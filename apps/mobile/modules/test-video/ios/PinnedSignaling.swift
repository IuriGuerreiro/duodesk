import Foundation
import CryptoKit
import Security

struct StreamInvitation: Decodable {
  let v: Int
  let direction: String
  let sessionId: String
  let url: String
  let token: String
  let fingerprint: String
  let expiresAt: Double

  static func parse(_ text: String) throws -> StreamInvitation {
    guard text.utf8.count <= 2048, let data = text.data(using: .utf8) else { throw SenderError.invalidInvitation }
    let invitation = try JSONDecoder().decode(Self.self, from: data)
    guard invitation.direction == "phone-to-desktop" || invitation.direction == "desktop-to-phone" else { throw SenderError.invalidInvitation }
    guard invitation.direction == "phone-to-desktop" else { throw SenderError.viewerUnsupported }
    let now = Date().timeIntervalSince1970 * 1000
    guard invitation.v == 1, invitation.sessionId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
          invitation.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          invitation.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          invitation.expiresAt > now, invitation.expiresAt <= now + 300_000,
          let url = URL(string: invitation.url), url.scheme == "wss", url.user == nil, url.password == nil,
          url.path == "/", url.query == nil, url.fragment == nil, let port = url.port, (1...65535).contains(port),
          let host = url.host, host.split(separator: ".").count == 4,
          host.split(separator: ".").allSatisfy({ part in Int(part).map { (0...255).contains($0) } ?? false }) else {
      throw SenderError.invalidInvitation
    }
    return invitation
  }
}

enum SenderError: LocalizedError {
  case invalidInvitation, viewerUnsupported, notReady, clipMissing, peerUnavailable
  var errorDescription: String? {
    switch self {
    case .invalidInvitation: return "Pairing failed or expired. Check the desktop address and code, then create a new pairing code."
    case .viewerUnsupported: return "Viewing the desktop screen is not available on iOS yet."
    case .notReady: return "Connect to Windows before starting."
    case .clipMissing: return "The bundled test clip is missing. Rebuild the development client."
    case .peerUnavailable: return "Could not create the native WebRTC sender."
    }
  }
}

/// The invitation fingerprint authenticates exactly this self-signed leaf certificate.
/// Pairing recovers the invitation; this does not disable other certificate checks.
final class PinnedSignaling: NSObject, URLSessionDelegate {
  private let invitation: StreamInvitation
  private let queue: DispatchQueue
  private let onMessage: (String) -> Void
  private let onFailure: (String) -> Void
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var heartbeat: DispatchSourceTimer?

  init(invitation: StreamInvitation, queue: DispatchQueue, onMessage: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
    self.invitation = invitation; self.queue = queue; self.onMessage = onMessage; self.onFailure = onFailure
  }

  func open() {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    config.urlCache = nil
    config.connectionProxyDictionary = [:]
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: URL(string: invitation.url)!)
    task.maximumMessageSize = 65_536
    self.session = session; socket = task
    task.resume()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 10, repeating: 10)
    timer.setEventHandler { [weak self, weak task] in
      guard let self, let task, self.socket === task else { return }
      task.sendPing { [weak self, weak task] error in
        guard let self, let task, error != nil else { return }
        self.queue.async { [weak self] in
          guard let self, self.socket === task else { return }
          self.onFailure("Lost the receiver connection. Create a new desktop pairing code.")
        }
      }
    }
    heartbeat = timer; timer.resume()
    send(["v": 1, "sessionId": invitation.sessionId, "type": "pair", "token": invitation.token])
    receive(task)
  }

  func send(_ message: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 65_536,
          let text = String(data: data, encoding: .utf8) else { return }
    socket.send(.string(text)) { [weak self, weak socket] error in
      guard let self, let socket, let error else { return }
      self.queue.async { [weak self] in
        guard let self, self.socket === socket else { return }
        self.onFailure("Signaling send failed: \(error.localizedDescription)")
      }
    }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self, weak task] result in
      guard let self, let task else { return }
      self.queue.async { [weak self] in
        guard let self, self.socket === task else { return }
        switch result {
        case .success(.string(let text)): self.onMessage(text)
        case .success: self.onFailure("Unexpected binary signaling message")
        case .failure(let error): self.onFailure("Connection closed: \(error.localizedDescription)"); return
        }
        if self.socket === task { self.receive(task) }
      }
    }
  }

  func close() {
    heartbeat?.cancel(); heartbeat = nil
    socket?.cancel(with: .goingAway, reason: nil); socket = nil
    session?.invalidateAndCancel(); session = nil
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          challenge.protectionSpace.host == URL(string: invitation.url)?.host,
          let trust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else {
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    let digest = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
    guard digest == invitation.fingerprint else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
}
