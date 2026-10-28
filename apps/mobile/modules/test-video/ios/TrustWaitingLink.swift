import Foundation
import Security

/// URLSession proves possession of the pinned desktop TLS key. No TLS exporter is needed.
final class TrustWaitingLink: NSObject, URLSessionDelegate {
  let address: String
  private let identity: TrustIdentity
  private let trustedKeys: () -> [String]
  private let event: (String?, [String: Any]?) -> Void
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var desktop: String?
  private var challenged = false
  private var authenticated = false
  private var heartbeat: DispatchSourceTimer?
  private var pingPending = false
  private let queue = DispatchQueue(label: "duodesk.trust.link")
  init(address: String, identity: TrustIdentity, trustedKeys: @escaping () -> [String], event: @escaping (String?, [String: Any]?) -> Void) {
    self.address = address; self.identity = identity; self.trustedKeys = trustedKeys; self.event = event
  }
  func open() {
    guard let url = URL(string: "wss://\(address)/") else { return }
    let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 15; config.urlCache = nil; config.connectionProxyDictionary = [:]
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil); self.session = session
    let task = session.webSocketTask(with: url); task.maximumMessageSize = 4096; socket = task; task.resume(); receive(task)
    queue.asyncAfter(deadline: .now() + 15) { [weak self, weak task] in
      guard let self, let task, self.socket === task, !self.authenticated else { return }; self.close()
    }
  }
  func send(_ value: [String: Any]) { queue.async { [weak self] in self?.sendNow(value) } }
  private func sendNow(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 4096, let text = String(data: data, encoding: .utf8) else { return }
    socket?.send(.string(text)) { [weak self] error in if error != nil { self?.queue.async { self?.close() } } }
  }
  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self, weak task] result in
      guard let self, let task else { return }
      self.queue.async { [weak self] in
        guard let self, self.socket === task else { return }
        do {
          guard case let .string(text) = try result.get(), text.utf8.count <= 4096,
                let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let type = value["type"] as? String, let desktop = self.desktop else { throw TrustFailure("Invalid remembered message") }
          if type == "challenge" {
            try TrustCrypto.exact(value, type, ["nonce"])
            guard !self.challenged, let nonce = value["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw TrustFailure("Invalid challenge") }
            self.challenged = true; let client = try TrustCrypto.nonce()
            let transcript = ["duodesk-reconnect-v1", "phone", desktop, self.identity.publicKey, nonce, client].joined(separator: "\n")
            self.send(["v": 1, "type": "auth", "key": self.identity.publicKey, "nonce": client, "signature": try self.identity.sign(transcript)])
          } else if type == "authenticated" {
            try TrustCrypto.exact(value, type, []); guard self.challenged, !self.authenticated else { throw TrustFailure("Unexpected authentication") }
            self.authenticated = true; self.startHeartbeat(task); self.event(desktop, value)
          } else { guard self.authenticated else { throw TrustFailure("Unauthenticated message") }; self.event(desktop, value) }
          self.receive(task)
        } catch { self.close() }
      }
    }
  }
  private func startHeartbeat(_ task: URLSessionWebSocketTask) {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 10, repeating: 10)
    timer.setEventHandler { [weak self, weak task] in
      guard let self, let task, self.socket === task else { return }
      if self.pingPending { self.closeNow(); return }
      self.pingPending = true
      task.sendPing { [weak self, weak task] error in
        guard let self, let task else { return }
        self.queue.async { [weak self] in
          guard let self, self.socket === task else { return }
          self.pingPending = false
          if error != nil { self.closeNow() }
        }
      }
    }
    heartbeat = timer; timer.resume()
  }
  func close() { queue.async { [weak self] in self?.closeNow() } }
  private func closeNow() {
    heartbeat?.cancel(); heartbeat = nil; pingPending = false
    socket?.cancel(with: .goingAway, reason: nil); socket = nil
    session?.invalidateAndCancel(); session = nil; event(desktop, nil)
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          challenge.protectionSpace.host == URL(string: "wss://\(address)/")?.host,
          let trust = challenge.protectionSpace.serverTrust, let key = SecTrustCopyKey(trust),
          let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?, raw.count == 65 else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    let pin = TrustCrypto.hex(raw)
    guard trustedKeys().contains(pin) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    queue.sync { desktop = pin }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}
