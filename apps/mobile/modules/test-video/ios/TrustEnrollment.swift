import Foundation

final class TrustEnrollment {
  private let identity: any TrustSigningIdentity
  private let invitation: StreamInvitation
  private let send: ([String: Any]) -> Void
  private let save: (String, String, Bool) throws -> Void
  private let discard: (String) -> Void
  private let event: ([String: Any]) -> Void
  private var phase = "idle"
  private var desktop = "", dn = "", pn = "", peer = "PC", label = ""
  private var attempts = 0
  private var timeout: DispatchWorkItem?
  private var generation = 0
  private let onTimeout: (TrustEnrollment, Int) -> Void
  init(identity: any TrustSigningIdentity, invitation: StreamInvitation, send: @escaping ([String: Any]) -> Void, save: @escaping (String, String, Bool) throws -> Void, discard: @escaping (String) -> Void, event: @escaping ([String: Any]) -> Void, onTimeout: @escaping (TrustEnrollment, Int) -> Void = { enrollment, ticket in enrollment.expire(ticket) }) {
    self.identity = identity; self.invitation = invitation; self.send = send; self.save = save; self.discard = discard; self.event = event; self.onTimeout = onTimeout
  }
  private func emit(_ state: String) { event(["type": "enroll", "state": state, "peerName": peer]) }
  private func message(_ type: String, _ fields: [String: Any] = [:]) { send(fields.merging(["type": "enroll_\(type)"]) { _, new in new }) }
  private func transcript(_ role: String) throws -> String { ["duodesk-enroll-v1", role, invitation.sessionId, invitation.fingerprint, TrustCrypto.hash(try TrustCrypto.bytes(invitation.token)), desktop, identity.publicKey, dn, pn].joined(separator: "\n") }
  private func arm() {
    timeout?.cancel(); generation += 1; let ticket = generation
    let work = DispatchWorkItem { [weak self] in guard let self else { return }; self.onTimeout(self, ticket) }; timeout = work
    DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: work)
  }
  func action(_ action: String, _ name: String) throws {
    label = name.isEmpty ? "" : TrustCrypto.name(name)
    switch action {
    case "start":
      guard phase == "idle", attempts < 3 else { throw TrustFailure("Remember request already open. Pair again to retry.") }
      attempts += 1; pn = try TrustCrypto.nonce(); phase = "requested"; arm()
      message("request", ["key": identity.publicKey, "nonce": pn, "name": "DuoDesk iPhone"]); emit("requested")
    case "approve":
      guard phase == "incoming" else { throw TrustFailure("Request expired") }
      pn = try TrustCrypto.nonce(); phase = "accepted"
      message("accept", ["key": identity.publicKey, "nonce": pn, "name": "DuoDesk iPhone", "signature": try identity.sign(transcript("phone"))]); emit("verifying")
    case "reject", "cancel": cancel()
    default: throw TrustFailure("Invalid remember action")
    }
  }
  func receive(_ value: [String: Any]) {
    do {
      guard let type = value["type"] as? String else { throw TrustFailure("Invalid enrollment") }
      let fields: [String]
      switch type { case "enroll_request": fields = ["key", "nonce", "name"]; case "enroll_accept": fields = ["key", "nonce", "name", "signature"]; case "enroll_confirm": fields = ["signature"]; case "enroll_saved", "enroll_cancel": fields = []; default: throw TrustFailure("Invalid enrollment") }
      try TrustCrypto.exact(value, type, ["sessionId"] + fields)
      guard value["sessionId"] as? String == invitation.sessionId else { throw TrustFailure("Stale enrollment") }
      func text(_ field: String) throws -> String { guard let text = value[field] as? String else { throw TrustFailure("Invalid field") }; return text }
      switch type {
      case "enroll_request", "enroll_accept":
        guard phase == (type == "enroll_request" ? "idle" : "requested"), attempts < 3 || type == "enroll_accept" else { throw TrustFailure("Unexpected enrollment") }
        desktop = try text("key"); dn = try text("nonce"); peer = TrustCrypto.name(try text("name"))
        guard desktop.range(of: "^04[0-9a-f]{128}$", options: .regularExpression) != nil, dn.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw TrustFailure("Invalid identity") }
        if type == "enroll_request" { attempts += 1; phase = "incoming"; arm(); emit("incoming") }
        else {
          guard TrustCrypto.verify(desktop, try transcript("desktop"), try text("signature")) else { throw TrustFailure("PC identity could not be verified") }
          try save(desktop, label.isEmpty ? peer : label, false); phase = "confirmed"
          message("confirm", ["signature": try identity.sign(transcript("phone"))])
        }
      case "enroll_confirm":
        guard phase == "accepted", TrustCrypto.verify(desktop, try transcript("desktop"), try text("signature")) else { throw TrustFailure("PC identity could not be verified") }
        try save(desktop, label.isEmpty ? peer : label, false); phase = "confirmed"; message("saved")
      case "enroll_saved":
        if phase == "done" { return }
        guard phase == "confirmed" else { throw TrustFailure("Unexpected saved reply") }
        try save(desktop, label.isEmpty ? peer : label, true); phase = "done"; timeout?.cancel(); message("saved"); emit("saved")
      default: if phase != "done" { discard(desktop); phase = "idle"; timeout?.cancel(); emit("cancelled") }
      }
    } catch { cancel(); emit("failed") }
  }
  func expire(_ ticket: Int) { if generation == ticket && phase != "done" { cancel() } }
  func cancel() {
    generation += 1
    timeout?.cancel()
    if phase != "done" { discard(desktop); message("cancel"); phase = "idle"; emit("cancelled") }
  }
}
