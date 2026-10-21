import Foundation
import Network

/// Bounded PAKE bootstrap only. The native sender still owns pinned TLS signaling.
final class PairingTransport {
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var connection: NWConnection?
  private let networkQueue = DispatchQueue(label: "duodesk.pairing.network")
  private func failure() -> NSError {
    NSError(domain: "DuoDeskPairing", code: 1, userInfo: [NSLocalizedDescriptionKey: "Pairing failed. Check the desktop address, code and Wi-Fi. Create a new code if expired or locked."])
  }
  func ticket() -> UInt64 { lock.lock(); defer { lock.unlock() }; return generation }
  func close() {
    lock.lock(); generation &+= 1; let old = connection; connection = nil; lock.unlock()
    old?.cancel()
  }
  func request(address: String, message: String, fresh: Bool, ticket: UInt64) throws -> String {
    guard message.utf8.count <= 8191, !message.contains("\n") else { throw failure() }
    if fresh {
      lock.lock()
      guard ticket == generation else { lock.unlock(); throw failure() }
      let old = connection; connection = nil; lock.unlock()
      old?.cancel()
      let parts = address.split(separator: ":", omittingEmptySubsequences: false)
      guard parts.count == 2 else { throw failure() }
      let components = parts[0].split(separator: ".", omittingEmptySubsequences: false)
      let octets = components.compactMap { UInt8($0) }
      guard components.count == 4, octets.count == 4,
        octets[0] == 10 || octets[0] == 172 && (16...31).contains(octets[1]) || octets[0] == 192 && octets[1] == 168 || octets[0] == 169 && octets[1] == 254,
        let port = UInt16(parts[1]), port > 0 else { throw failure() }
      let host = octets.map(String.init).joined(separator: ".")
      guard address == "\(host):\(port)" else { throw failure() }
      let next = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
      lock.lock()
      guard ticket == generation else { lock.unlock(); next.cancel(); throw failure() }
      connection = next; lock.unlock()
      let ready = DispatchSemaphore(value: 0)
      next.stateUpdateHandler = { state in
        switch state { case .ready, .failed, .cancelled: ready.signal(); default: break }
      }
      next.start(queue: networkQueue)
      guard ready.wait(timeout: .now() + 5) == .success, case .ready = next.state else { close(); throw failure() }
    }
    lock.lock()
    let active = ticket == generation ? connection : nil
    lock.unlock()
    guard let active else { throw failure() }
    do {
      let sent = DispatchSemaphore(value: 0)
      active.send(content: Data((message + "\n").utf8), completion: .contentProcessed { _ in sent.signal() })
      guard sent.wait(timeout: .now() + 5) == .success else { throw failure() }
      // All result access is protected; completion may arrive after a timeout.
      let resultLock = NSLock()
      let received = DispatchSemaphore(value: 0)
      var response = Data()
      var valid = false
      func read() {
        active.receive(minimumIncompleteLength: 1, maximumLength: 1) { data, _, complete, error in
          resultLock.lock()
          if let data { response.append(data) }
          let done = response.last == 10
          let failed = error != nil || complete || response.count >= 8192
          if done { valid = true }
          resultLock.unlock()
          if done || failed { received.signal() } else { read() }
        }
      }
      read()
      guard received.wait(timeout: .now() + 5) == .success else { throw failure() }
      resultLock.lock(); let bytes = response; let success = valid; resultLock.unlock()
      guard success, let text = String(data: bytes.dropLast(), encoding: .utf8) else { throw failure() }
      return text
    } catch { close(); throw error }
  }
}
