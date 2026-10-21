package expo.modules.testvideo

internal fun trustedProofBytes(nonce: String, fingerprint: String, phoneId: String): ByteArray =
  "DuoDesk trusted reconnect v1\n".toByteArray(Charsets.US_ASCII) +
    nonce.hexBytes(32) + fingerprint.hexBytes(32) + phoneId.hexBytes(32)

internal fun p256PublicKeyBytes(key: java.security.interfaces.ECPublicKey): ByteArray {
  require(key.params.curve.field.fieldSize == 256)
  fun coordinate(value: java.math.BigInteger): ByteArray {
    val bytes = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    require(bytes.size <= 32)
    return ByteArray(32 - bytes.size) + bytes
  }
  return byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)
}
