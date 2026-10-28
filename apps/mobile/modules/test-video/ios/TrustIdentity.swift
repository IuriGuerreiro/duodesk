import Foundation
import CryptoKit
import Security

struct TrustFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

enum TrustCrypto {
  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
  static func bytes(_ text: String) throws -> Data {
    guard text.count % 2 == 0, text.range(of: "^[0-9a-f]*$", options: .regularExpression) != nil else { throw TrustFailure("Invalid hex") }
    var data = Data(); var at = text.startIndex
    while at < text.endIndex { let end = text.index(at, offsetBy: 2); guard let b = UInt8(text[at..<end], radix: 16) else { throw TrustFailure("Invalid hex") }; data.append(b); at = end }
    return data
  }
  static func nonce() throws -> String { var bytes = [UInt8](repeating: 0, count: 32); guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw TrustFailure("Randomness unavailable") }; return hex(Data(bytes)) }
  static func hash(_ data: Data) -> String { hex(Data(SHA256.hash(data: data))) }
  static func name(_ value: String) -> String {
    let clean = String(String.UnicodeScalarView(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !(0x202a...0x202e).contains($0.value) && !(0x2066...0x2069).contains($0.value) })).trimmingCharacters(in: .whitespacesAndNewlines)
    return clean.isEmpty ? "DuoDesk device" : String(String.UnicodeScalarView(clean.unicodeScalars.prefix(40)))
  }
  static func verify(_ key: String, _ text: String, _ signature: String) -> Bool {
    guard key.count == 130, key.hasPrefix("04"), signature.count <= 144,
          let data = try? bytes(key), let pub = try? P256.Signing.PublicKey(x963Representation: data),
          let sig = try? P256.Signing.ECDSASignature(derRepresentation: bytes(signature)) else { return false }
    return pub.isValidSignature(sig, for: Data(text.utf8))
  }
  static func exact(_ value: [String: Any], _ type: String, _ fields: [String]) throws {
    guard value["v"] as? Int == 1, value["type"] as? String == type, Set(value.keys) == Set(["v", "type"] + fields) else { throw TrustFailure("Invalid remembered message") }
  }
}

/// Native-only keys and records. A non-backed-up marker prevents adopting orphaned keychain items.
protocol TrustSigningIdentity { var publicKey: String { get }; func sign(_ text: String) throws -> String }

final class TrustIdentity: TrustSigningIdentity {
  private let install: String
  private let key: P256.Signing.PrivateKey
  init() throws {
    let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("DuoDeskTrust", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var marker = dir.appendingPathComponent("install")
    let installation: String
    if let data = try? Data(contentsOf: marker), let text = String(data: data, encoding: .utf8), text.count == 64 { installation = text }
    else { installation = try TrustCrypto.nonce(); try Data(installation.utf8).write(to: marker, options: .atomic) }
    install = installation
    var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try marker.setResourceValues(resource)
    if let bytes = try Self.get("identity.\(installation)") { key = try P256.Signing.PrivateKey(rawRepresentation: bytes) }
    else {
      let fresh = P256.Signing.PrivateKey(); try Self.set("records.\(installation)", Data("{}".utf8)); try Self.set("identity.\(installation)", fresh.rawRepresentation); key = fresh
    }
  }
  var publicKey: String { TrustCrypto.hex(key.publicKey.x963Representation) }
  func sign(_ text: String) throws -> String { TrustCrypto.hex(try key.signature(for: Data(text.utf8)).derRepresentation) }
  func read() throws -> [String: [String: Any]] {
    guard let bytes = try Self.get("records.\(install)") else { return [:] }
    guard bytes.count <= 65536, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: [String: Any]] else { throw TrustFailure("Unreadable trust records. Clear DuoDesk app data and pair again.") }
    return value
  }
  func write(_ peers: [String: [String: Any]]) throws { try Self.set("records.\(install)", JSONSerialization.data(withJSONObject: peers)) }
  private static func query(_ name: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.duodesk.mobile.trust", kSecAttrAccount as String: name, kSecAttrSynchronizable as String: false] }
  private static func get(_ name: String) throws -> Data? {
    var q = query(name); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?; let code = SecItemCopyMatching(q as CFDictionary, &result)
    if code == errSecItemNotFound { return nil }
    guard code == errSecSuccess, let data = result as? Data else { throw TrustFailure("Secure storage unavailable. Unlock the phone and restart DuoDesk.") }; return data
  }
  private static func set(_ name: String, _ value: Data) throws {
    let q = query(name)
    let attributes: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    let code = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if code == errSecItemNotFound {
      let add = q.merging(attributes) { _, new in new }
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw TrustFailure("Could not save remembered devices in Keychain.") }
    } else if code != errSecSuccess { throw TrustFailure("Could not update remembered devices in Keychain.") }
  }
}
