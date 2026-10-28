import Foundation
import Darwin

/// Persistent trust, ephemeral waiting links, and explicit new-session requests are separate state.
final class TrustManager: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  static weak var current: TrustManager?
  private var identity: TrustIdentity?
  private var peers: [String: [String: Any]] = [:]
  private var storageError: String?
  private var revoked = Set<String>()
  private var prepared = Set<String>()
  private var enrollment: (String, TrustEnrollment)?
  private var bound: (String, String)?
  private var boundRequest: String?
  private var waiting: [String: TrustWaitingLink] = [:]
  private var tickets: [String: String] = [:]
  private var links: [String: TrustWaitingLink] = [:]
  private struct Request { let device: String; let direction: String; let incoming: Bool; var approved: Bool }
  private var requests: [String: Request] = [:]
  private var foreground = false
  private var generation = 0
  private let browser = NetServiceBrowser()
  private var services: [NetService] = []
  private let lock = NSRecursiveLock()
  private let event: ([String: Any]) -> Void
  private let endSession: () -> Void
  init(event: @escaping ([String: Any]) -> Void, endSession: @escaping () -> Void) {
    self.event = event; self.endSession = endSession; super.init()
    do { let id = try TrustIdentity(); identity = id; peers = try id.read().filter { $0.value["active"] as? Bool == true }; try id.write(peers) }
    catch { storageError = error.localizedDescription; identity = nil }
    browser.delegate = self; Self.current = self
  }
  private func status() -> [String: Any] {
    var value: [String: Any] = ["available": storageError == nil, "devices": peers.compactMap { id, p -> [String: Any]? in
      guard p["active"] as? Bool == true, !revoked.contains(id) else { return nil }
      return ["id": id, "name": p["name"] as? String ?? "PC", "address": p["address"] as? String ?? "", "available": links[id] != nil]
    }]
    if let error = storageError { value["error"] = error }; return value
  }
  private func publish() { event(["type": "status"]) }
  private func persist(_ value: [String: [String: Any]]) throws {
    guard let identity, storageError == nil else { throw TrustFailure(storageError ?? "Secure storage unavailable") }
    try identity.write(value); peers = value
  }
  private func save(_ key: String, _ name: String, _ active: Bool) throws {
    lock.lock(); defer { lock.unlock() }
    let id = TrustCrypto.hash(try TrustCrypto.bytes(key)); var copy = peers
    guard copy.count < 32 || copy[id] != nil else { throw TrustFailure("Forget a device before adding more") }
    copy[id] = ["key": key, "name": TrustCrypto.name(name), "active": active, "address": copy[id]?["address"] as? String ?? ""]
    try persist(copy); revoked.remove(id); if active, let enrollment { bound = (enrollment.0, id); boundRequest = nil }; publish()
  }
  private func discard(_ key: String) {
    lock.lock(); defer { lock.unlock() }
    guard let data = try? TrustCrypto.bytes(key) else { return }; let id = TrustCrypto.hash(data)
    if peers[id]?["active"] as? Bool == false { var copy = peers; copy.removeValue(forKey: id); do { try persist(copy) } catch { revoked.insert(id) } }
  }
  func paired(_ invitation: StreamInvitation, send: @escaping ([String: Any]) -> Void) {
    lock.lock(); defer { lock.unlock() }
    guard prepared.remove(invitation.sessionId) != nil, let identity else { return }
    enrollment?.1.cancel()
    enrollment = (invitation.sessionId, TrustEnrollment(identity: identity, invitation: invitation, send: send, save: { [weak self] key, name, active in guard let self else { throw TrustFailure("Session ended") }; try self.save(key, name, active) }, discard: { [weak self] in self?.discard($0) }, event: event, onTimeout: { [weak self] enrollment, ticket in
      guard let self else { return }; self.lock.lock(); defer { self.lock.unlock() }
      if self.enrollment?.1 === enrollment { enrollment.expire(ticket) }
    }))
    send(["type": "enroll_hello"]); event(["type": "enroll", "state": "capable"])
  }
  func receiveEnrollment(_ invitation: StreamInvitation, _ text: String) throws -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let type = value["type"] as? String else { return false }
    guard type.hasPrefix("enroll_") else { return false }; guard text.utf8.count <= 4096 else { throw TrustFailure("Oversized enrollment") }
    if enrollment?.0 == invitation.sessionId { enrollment?.1.receive(value) }; return true
  }
  func detached(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    if enrollment?.0 == id { enrollment?.1.cancel(); enrollment = nil }; prepared.remove(id)
    if bound?.0 == id { bound = nil; boundRequest = nil }
  }
  private func forget(_ id: String, notify: Bool) throws {
    revoked.insert(id)
    if notify { links[id]?.send(["v": 1, "type": "forget"]) }; links.removeValue(forKey: id)?.close()
    requests = requests.filter { $0.value.device != id }
    if bound?.1 == id { endSession(); bound = nil }
    var copy = peers; copy.removeValue(forKey: id); try persist(copy)
    if peers.isEmpty { DispatchQueue.main.async { [weak self] in self?.browser.stop() } }
    publish()
  }
  func command(_ method: String, _ args: [String: Any]) throws -> String {
    lock.lock(); defer { lock.unlock() }
    func text(_ key: String) throws -> String { guard let value = args[key] as? String else { throw TrustFailure("Missing \(key)") }; return value }
    switch method {
    case "status": return String(decoding: try JSONSerialization.data(withJSONObject: status()), as: UTF8.self)
    case "prepare":
      let inv = try StreamInvitation.parse(text("invitation")); if args["enabled"] as? Bool == true { if prepared.count >= 8 { prepared.removeAll() }; prepared.insert(inv.sessionId) }
    case "enroll":
      guard let enrollment else { throw TrustFailure("Pair with an updated PC first") }; try enrollment.1.action(text("action"), args["name"] as? String ?? "")
    case "rename":
      let id = try text("deviceId"); guard peers[id] != nil else { throw TrustFailure("Device forgotten") }; var copy = peers; copy[id]?["name"] = TrustCrypto.name(try text("name")); try persist(copy); publish()
    case "forget": try forget(text("deviceId"), notify: true)
    case "foreground": setForeground(args["active"] as? Bool == true)
    case "link": try open(text("address"))
    case "connect":
      let id = try text("deviceId"), direction = try text("direction")
      guard direction == "phone-to-desktop" else { throw SenderError.viewerUnsupported }
      guard let link = links[id], peers[id]?["active"] as? Bool == true, !revoked.contains(id), !requests.values.contains(where: { $0.device == id }) else { throw TrustFailure("PC unavailable. Open DuoDesk on the PC, check Wi-Fi, or pair again.") }
      let request = String(try TrustCrypto.nonce().prefix(32)); requests[request] = Request(device: id, direction: direction, incoming: false, approved: false)
      link.send(["v": 1, "type": "connect_request", "requestId": request, "direction": direction]); expire(request)
      return "{\"requestId\":\"\(request)\"}"
    case "respond":
      let id = try text("requestId"); guard var request = requests[id], request.incoming else { throw TrustFailure("Request expired") }
      let accept = args["accept"] as? Bool == true
      request.approved = accept; requests[id] = accept ? request : nil
      links[request.device]?.send(["v": 1, "type": accept ? "connect_accept" : "connect_reject", "requestId": id])
    case "cancel": cancel(try text("requestId"))
    default: throw TrustFailure("Unknown remembered command")
    }
    return "null"
  }
  private func setForeground(_ active: Bool) {
    foreground = active; generation += 1; let ticket = generation
    if active {
      for p in peers.values { if let address = p["address"] as? String, !address.isEmpty { try? open(address) } }
      DispatchQueue.main.async { [weak self] in guard let self else { return }; self.lock.lock(); defer { self.lock.unlock() }; if self.foreground && ticket == self.generation && self.peers.values.contains(where: { $0["active"] as? Bool == true }) { self.browser.stop(); self.browser.searchForServices(ofType: "_duodesk-trust._tcp.", inDomain: "local.") } }
    } else {
      let old = Array(waiting.values); waiting.removeAll(); tickets.removeAll(); links.removeAll(); requests.removeAll(); old.forEach { $0.close() }
      DispatchQueue.main.async { [weak self] in self?.browser.stop(); self?.services.forEach { $0.stop() }; self?.services.removeAll() }; publish()
    }
  }
  private func cancel(_ id: String) {
    guard let r = requests.removeValue(forKey: id) else {
      if boundRequest == id, let bound {
        links[bound.1]?.send(["v": 1, "type": "connect_cancel", "requestId": id]); endSession(); self.bound = nil; boundRequest = nil; event(["type": "cancelled", "requestId": id])
      }
      return
    }; links[r.device]?.send(["v": 1, "type": "connect_cancel", "requestId": id]); event(["type": "cancelled", "requestId": id])
  }
  private func expire(_ id: String) { DispatchQueue.global().asyncAfter(deadline: .now() + 60) { [weak self] in guard let self else { return }; self.lock.lock(); defer { self.lock.unlock() }; if self.requests[id] != nil { self.cancel(id) } } }
  private func open(_ address: String) throws {
    guard Self.lan(address) else { throw TrustFailure("Use a private LAN IPv4 address and port") }
    guard foreground, waiting[address] == nil, waiting.count < 16, let identity, storageError == nil else { return }
    let ticket = UUID().uuidString
    let link = TrustWaitingLink(address: address, identity: identity, trustedKeys: { [weak self] in
      guard let self else { return [] }; self.lock.lock(); defer { self.lock.unlock() }
      return self.peers.compactMap { id, value in !self.revoked.contains(id) && value["active"] as? Bool == true ? value["key"] as? String : nil }
    }, event: { [weak self] key, value in self?.received(address, ticket, key, value) })
    tickets[address] = ticket; waiting[address] = link; link.open()
  }
  private func received(_ address: String, _ ticket: String, _ key: String?, _ value: [String: Any]?) {
    lock.lock(); defer { lock.unlock() }
    guard tickets[address] == ticket, let link = waiting[address] else { return }
    guard let key, let data = try? TrustCrypto.bytes(key) else { if value == nil { waiting.removeValue(forKey: address); tickets.removeValue(forKey: address) }; return }
    let device = TrustCrypto.hash(data)
    guard let value else {
      waiting.removeValue(forKey: address); tickets.removeValue(forKey: address)
      if links[device] === link { links.removeValue(forKey: device); for (id, r) in requests where r.device == device { cancel(id) }; publish() }; return
    }
    do {
      guard foreground, peers[device]?["active"] as? Bool == true, !revoked.contains(device), let type = value["type"] as? String else { throw TrustFailure("Device forgotten") }
      if type == "authenticated" {
        if let old = links[device], old !== link { old.close() }; links[device] = link
        var copy = peers; copy[device]?["address"] = address; try persist(copy); publish(); return
      }
      guard links[device] === link else { throw TrustFailure("Stale link") }
      if type == "forget" { try TrustCrypto.exact(value, type, []); try forget(device, notify: false); return }
      let fields = type == "connect_request" ? ["requestId", "direction"] : type == "invitation" ? ["requestId", "invitation"] : ["requestId"]
      try TrustCrypto.exact(value, type, fields)
      guard let id = value["requestId"] as? String, id.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { throw TrustFailure("Invalid request") }
      switch type {
      case "connect_request":
        guard requests[id] == nil, !requests.values.contains(where: { $0.device == device }), let direction = value["direction"] as? String else { throw TrustFailure("Unexpected request") }
        if direction != "phone-to-desktop" { link.send(["v": 1, "type": "connect_reject", "requestId": id]); return }
        requests[id] = Request(device: device, direction: direction, incoming: true, approved: false); expire(id); event(["type": "request", "requestId": id, "deviceId": device, "direction": direction])
      case "connect_accept":
        guard var r = requests[id], r.device == device, !r.incoming else { throw TrustFailure("Unexpected acceptance") }; r.approved = true; requests[id] = r
      case "connect_reject", "connect_cancel":
        guard requests[id]?.device == device else { throw TrustFailure("Stale request") }; requests.removeValue(forKey: id); event(["type": "cancelled", "requestId": id])
      case "invitation":
        guard let r = requests[id], r.device == device, r.approved, let text = value["invitation"] as? String else { throw TrustFailure("Unapproved session") }
        let inv = try StreamInvitation.parse(text); guard inv.direction == r.direction, URL(string: inv.url)?.host == URL(string: "wss://\(address)/")?.host else { throw TrustFailure("Session endpoint changed") }
        requests.removeValue(forKey: id); bound = (inv.sessionId, device); boundRequest = id; event(["type": "invitation", "deviceId": device, "invitation": text])
      default: throw TrustFailure("Invalid remembered message")
      }
    } catch { link.close(); event(["type": "error", "message": "Remembered connection failed. Pair again if the PC identity changed."]) }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    lock.lock(); defer { lock.unlock() }; guard foreground, services.count < 16 else { return }; services.append(service); service.delegate = self; service.resolve(withTimeout: 5)
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) { lock.lock(); defer { lock.unlock() }; services.removeAll { $0 == service }; service.stop() }
  func netServiceDidResolveAddress(_ sender: NetService) {
    for data in sender.addresses ?? [] {
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = data.withUnsafeBytes { buffer -> Int32 in guard let base = buffer.baseAddress else { return -1 }; return getnameinfo(base.assumingMemoryBound(to: sockaddr.self), socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) }
      if result == 0 { let address = "\(String(cString: host)):\(sender.port)"; if Self.lan(address) { lock.lock(); try? open(address); lock.unlock(); return } }
    }
  }
  func destroy() { lock.lock(); defer { lock.unlock() }; setForeground(false); enrollment?.1.cancel(); enrollment = nil; if Self.current === self { Self.current = nil } }
  static func lan(_ address: String) -> Bool {
    let parts = address.split(separator: ":"); guard parts.count == 2, let port = Int(parts[1]), (1...65535).contains(port) else { return false }
    let octets = parts[0].split(separator: "."); let values = octets.compactMap { Int($0) }; guard octets.count == 4, values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return false }
    guard values.map(String.init).joined(separator: ".") + ":" + String(port) == address else { return false }
    return values[0] == 10 || values[0] == 172 && (16...31).contains(values[1]) || values[0] == 192 && values[1] == 168 || values[0] == 169 && values[1] == 254
  }
}
