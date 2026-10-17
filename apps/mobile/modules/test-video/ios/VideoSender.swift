import Foundation
import WebRTC

final class VideoSender: NSObject, RTCPeerConnectionDelegate {
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
  }()
  private let queue: DispatchQueue
  private let emit: ([String: Any]) -> Void
  private var invitation: StreamInvitation?
  private var signaling: PinnedSignaling?
  private var peer: RTCPeerConnection?
  private var clip: ClipCapturer?
  private var candidates: [RTCIceCandidate] = []
  private var state = "idle"
  private var timeout: DispatchWorkItem?
  private var statsTimer: DispatchSourceTimer?
  private var previousBytes: Double = 0
  private var previousTimestamp: Double = 0
  private var generation = UUID()
  private var acceptingAnswer = false

  init(queue: DispatchQueue, emit: @escaping ([String: Any]) -> Void) { self.queue = queue; self.emit = emit }

  func connect(_ text: String) throws {
    close()
    let invitation = try StreamInvitation.parse(text)
    self.invitation = invitation
    let generation = self.generation
    let signaling = PinnedSignaling(invitation: invitation, queue: queue, onMessage: { [weak self] text in
      guard let self, self.generation == generation else { return }; self.receive(text)
    }, onFailure: { [weak self] message in
      guard let self, self.generation == generation else { return }; self.fail(message)
    })
    self.signaling = signaling
    status("connecting")
    armTimeout("Connection timed out. Check Wi-Fi and the Windows firewall.")
    signaling.open()
  }

  func start(bitrateMbps: Int) throws {
    guard state == "ready", let invitation else { throw SenderError.notReady }
    var started = false
    defer { if !started { close() } }
    let host = Bundle(for: ClipCapturer.self)
    guard let bundleURL = host.url(forResource: "DuoDeskTestVideo", withExtension: "bundle"),
          let bundle = Bundle(url: bundleURL), let url = bundle.url(forResource: "test-pattern", withExtension: "mp4") else { throw SenderError.clipMissing }
    let config = RTCConfiguration()
    config.iceServers = []
    config.sdpSemantics = .unifiedPlan
    config.bundlePolicy = .maxBundle
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else { throw SenderError.peerUnavailable }
    self.peer = peer
    let source = Self.factory.videoSource(forScreenCast: true)
    source.adaptOutputFormat(toWidth: 1920, height: 1080, fps: 30)
    let track = Self.factory.videoTrack(with: source, trackId: "duodesk-test-video")
    let setup = RTCRtpTransceiverInit()
    setup.direction = .sendOnly; setup.streamIds = ["duodesk"]
    guard let transceiver = peer.addTransceiver(with: track, init: setup) else { close(); throw SenderError.peerUnavailable }
    let codecs = Self.factory.rtpSenderCapabilities(forKind: "video").codecs
    let h264 = codecs.filter { $0.name.caseInsensitiveCompare("H264") == .orderedSame }
    // Require H.264 for this experiment instead of silently changing the quality baseline.
    guard !h264.isEmpty else { close(); throw SenderError.peerUnavailable }
    try transceiver.setCodecPreferences(h264 + codecs.filter { $0.name.caseInsensitiveCompare("rtx") == .orderedSame })
    let parameters = transceiver.sender.parameters
    for encoding in parameters.encodings {
      encoding.maxBitrateBps = NSNumber(value: min(30, max(2, bitrateMbps)) * 1_000_000)
      encoding.maxFramerate = 30
    }
    parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
    transceiver.sender.parameters = parameters
    let generation = self.generation
    clip = ClipCapturer(source: source, url: url) { [weak self] message in
      self?.queue.async { [weak self] in
        guard let self, self.generation == generation else { return }; self.fail(message)
      }
    }
    status("connecting")
    armTimeout("Video negotiation timed out. Create a new invitation and reconnect.")
    peer.offer(for: constraints) { [weak self, weak peer] description, error in
      guard let self, let peer else { return }
      self.queue.async {
        guard self.peer === peer else { return }
        guard let description, error == nil else { self.fail("Could not create video offer"); return }
        peer.setLocalDescription(description) { [weak self, weak peer] error in
          guard let self, let peer else { return }
          self.queue.async {
            guard self.peer === peer else { return }
            guard error == nil else { self.fail("Could not set local video description"); return }
            self.send(["type": "offer", "sdp": description.sdp], sessionId: invitation.sessionId)
          }
        }
      }
    }
    started = true
  }

  private func receive(_ text: String) {
    guard let invitation, text.utf8.count <= 65_536,
          let data = text.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          message["v"] as? Int == 1, message["sessionId"] as? String == invitation.sessionId,
          let type = message["type"] as? String else { fail("Invalid signaling message"); return }
    switch type {
    case "paired":
      guard state == "connecting", peer == nil else { fail("Unexpected pairing response"); return }
      timeout?.cancel(); timeout = nil; status("ready")
    case "answer":
      guard let peer, !acceptingAnswer, peer.remoteDescription == nil,
            let sdp = message["sdp"] as? String, !sdp.isEmpty, sdp.utf8.count <= 60_000 else { fail("Invalid video answer"); return }
      acceptingAnswer = true
      peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self, weak peer] error in
        guard let self, let peer else { return }
        self.queue.async {
          guard self.peer === peer else { return }
          guard error == nil else { self.fail("Could not accept video answer"); return }
          for candidate in self.candidates { self.add(candidate, to: peer) }
          self.candidates.removeAll()
          self.clip?.start()
          self.startStats(peer)
        }
      }
    case "candidate":
      guard let peer, let sdp = message["candidate"] as? String, !sdp.isEmpty, sdp.utf8.count <= 8192,
            let index = message["sdpMLineIndex"] as? Int32, (0...32).contains(index),
            message["sdpMid"] is NSNull || message["sdpMid"] is String,
            ((message["sdpMid"] as? String)?.utf8.count ?? 0) <= 256 else { fail("Invalid ICE candidate"); return }
      let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: message["sdpMid"] as? String)
      if peer.remoteDescription != nil { add(candidate, to: peer) }
      else if candidates.count < 128 { candidates.append(candidate) }
      else { fail("Too many pending candidates") }
    case "stop": close(); status("stopped")
    default: fail("Unexpected signaling message")
    }
  }

  private func add(_ candidate: RTCIceCandidate, to peer: RTCPeerConnection) {
    peer.add(candidate) { [weak self, weak peer] error in
      guard let self, let peer, error != nil else { return }
      self.queue.async { if self.peer === peer { self.fail("Could not add remote ICE candidate") } }
    }
  }
  private func send(_ fields: [String: Any], sessionId: String) {
    var message = fields; message["v"] = 1; message["sessionId"] = sessionId
    signaling?.send(message)
  }
  private func armTimeout(_ message: String) {
    timeout?.cancel()
    let generation = self.generation
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.generation == generation else { return }; self.fail(message)
    }
    timeout = item; queue.asyncAfter(deadline: .now() + 20, execute: item)
  }
  private func status(_ value: String) { state = value; emit(["state": value]) }
  private func fail(_ message: String) { close(); state = "failed"; emit(["state": "failed", "message": message]) }

  func close() {
    generation = UUID()
    timeout?.cancel(); timeout = nil
    statsTimer?.cancel(); statsTimer = nil
    clip?.stop(); clip = nil
    peer?.delegate = nil; peer?.close(); peer = nil
    signaling?.close(); signaling = nil
    invitation = nil; candidates.removeAll(); acceptingAnswer = false
    previousBytes = 0; previousTimestamp = 0; state = "stopped"
  }
  func stop() { close(); status("stopped") }

  private func startStats(_ peer: RTCPeerConnection) {
    statsTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self, weak peer] in
      guard let self, let peer, self.peer === peer else { return }
      peer.statistics { [weak self, weak peer] report in
        guard let self, let peer else { return }
        self.queue.async {
          guard self.peer === peer else { return }
          for entry in report.statistics.values where entry.type == "outbound-rtp" && entry.values["kind"] as? String == "video" {
            let bytes = (entry.values["bytesSent"] as? NSNumber)?.doubleValue ?? 0
            let elapsed = report.timestamp_us - self.previousTimestamp
            let mbps = self.previousTimestamp > 0 && elapsed > 0 ? max(0, (bytes - self.previousBytes) * 8 / elapsed) : 0
            self.previousBytes = bytes; self.previousTimestamp = report.timestamp_us
            let codecId = entry.values["codecId"] as? String ?? ""
            let codec = report.statistics[codecId]?.values["mimeType"] as? String ?? "H264"
            self.emit(["state": self.state, "stats": ["codec": codec, "mbps": mbps,
              "fps": entry.values["framesPerSecond"] ?? 0, "width": entry.values["frameWidth"] ?? 0,
              "height": entry.values["frameHeight"] ?? 0,
              "qualityLimit": entry.values["qualityLimitationReason"] ?? "unknown"]])
          }
        }
      }
    }
    statsTimer = timer; timer.resume()
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
    queue.async { [weak self] in
      guard let self, self.peer === peerConnection, let invitation = self.invitation else { return }
      self.send(["type": "candidate", "candidate": candidate.sdp, "sdpMid": candidate.sdpMid as Any? ?? NSNull(),
                 "sdpMLineIndex": candidate.sdpMLineIndex], sessionId: invitation.sessionId)
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    queue.async { [weak self] in
      guard let self, self.peer === peerConnection else { return }
      if newState == .connected || newState == .completed { self.timeout?.cancel(); self.timeout = nil; self.status("streaming") }
      else if newState == .failed || newState == .disconnected { self.fail("Video connection lost. Create a new invitation.") }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
