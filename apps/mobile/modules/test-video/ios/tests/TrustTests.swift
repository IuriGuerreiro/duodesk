import Foundation
import CryptoKit

/// Compile with the five production trust/signaling files. Uses in-memory fixture keys, never Keychain.
@main struct TrustTests {
  struct FixtureIdentity: TrustSigningIdentity {
    let key: P256.Signing.PrivateKey
    var publicKey: String { TrustCrypto.hex(key.publicKey.x963Representation) }
    func sign(_ text: String) throws -> String { TrustCrypto.hex(try key.signature(for: Data(text.utf8)).derRepresentation) }
  }
  static func main() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let v = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let desktop = v["desktop"] as! [String: String], phone = v["phone"] as! [String: String], enroll = v["enroll"] as! [String: String], reconnect = v["reconnect"] as! [String: String]
    let fingerprint = TrustCrypto.hash(try TrustCrypto.bytes(desktop["publicKey"]!))
    precondition(fingerprint == desktop["fingerprint"]!)
    precondition(TrustCrypto.verify(desktop["publicKey"]!, enroll["desktopTranscript"]!, enroll["desktopSignature"]!))
    precondition(TrustCrypto.verify(phone["publicKey"]!, reconnect["transcript"]!, reconnect["phoneSignature"]!))
    precondition(!TrustCrypto.verify(phone["publicKey"]!, reconnect["transcript"]! + "x", reconnect["phoneSignature"]!))
    let identity = FixtureIdentity(key: try P256.Signing.PrivateKey(rawRepresentation: TrustCrypto.bytes(phone["privateScalar"]!)))
    let server = FixtureIdentity(key: try P256.Signing.PrivateKey(rawRepresentation: TrustCrypto.bytes(desktop["privateScalar"]!)))
    let invitation = StreamInvitation(v: 1, direction: "phone-to-desktop", sessionId: enroll["sessionId"]!, url: "wss://192.168.1.2:12345/", token: v["token"] as! String, fingerprint: enroll["certificateFingerprint"]!, expiresAt: Date().timeIntervalSince1970 * 1000 + 120000)
    var messages: [[String: Any]] = [], saved: [Bool] = []
    let state = TrustEnrollment(identity: identity, invitation: invitation, send: { messages.append($0) }, save: { _, _, active in saved.append(active) }, discard: { _ in }, event: { _ in })
    func message(_ type: String, _ fields: [String: Any] = [:]) -> [String: Any] { fields.merging(["v": 1, "sessionId": invitation.sessionId, "type": type]) { _, new in new } }
    state.receive(message("enroll_request", ["key": server.publicKey, "nonce": enroll["desktopNonce"]!, "name": "Desk"]))
    precondition(saved.isEmpty); try state.action("approve", "My PC"); precondition(saved.isEmpty)
    let nonce = messages.last!["nonce"] as! String
    let transcript = ["duodesk-enroll-v1", "desktop", invitation.sessionId, invitation.fingerprint, enroll["tokenHash"]!, server.publicKey, identity.publicKey, enroll["desktopNonce"]!, nonce].joined(separator: "\n")
    state.receive(message("enroll_confirm", ["signature": try server.sign(transcript)])); precondition(saved == [false])
    state.receive(message("enroll_saved")); precondition(saved == [false, true])
    precondition(TrustManager.lan("192.168.1.2:12345")); precondition(!TrustManager.lan("100.64.1.2:12345")); precondition(!TrustManager.lan("example.com:12345"))
    print("Swift trust vectors, enrollment consent, durable acknowledgement, and LAN address tests passed")
  }
}
