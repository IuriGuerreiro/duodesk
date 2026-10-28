package expo.modules.testvideo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.security.*
import java.security.interfaces.ECPublicKey
import java.security.spec.*
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keys never cross the native bridge. Trust records are encrypted and excluded from backup. */
internal interface TrustSigningIdentity { val publicKey: String; fun sign(text: String): String }

internal class TrustIdentity(context: Context) : TrustSigningIdentity {
  private val root = File(context.noBackupFilesDir, "duodesk-trust").apply { mkdirs() }
  private val marker = File(root, "install")
  private val install = if (marker.exists()) marker.readText() else TrustCrypto.nonce().also { marker.writeText(it) }
  private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private val signingAlias = "duodesk.sign.$install"
  private val encryptionAlias = "duodesk.store.$install"
  private val file = AtomicFile(File(root, "peers"))
  init {
    if (!store.containsAlias(signingAlias)) {
      KeyPairGenerator.getInstance("EC", "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(signingAlias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
      }.generateKeyPair()
      file.delete() // Key loss invalidates the old relationships.
    }
    if (!store.containsAlias(encryptionAlias)) {
      KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(encryptionAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      }.generateKey()
      file.delete()
    }
  }
  override val publicKey: String get() = TrustCrypto.point(store.getCertificate(signingAlias).publicKey as ECPublicKey)
  override fun sign(text: String): String = Signature.getInstance("SHA256withECDSA").run {
    initSign(store.getKey(signingAlias, null) as PrivateKey); update(text.toByteArray(Charsets.UTF_8)); TrustCrypto.hex(sign())
  }
  fun read(): JSONObject {
    if (!file.baseFile.exists()) return JSONObject()
    val bytes = file.openRead().use { it.readBytes() }
    require(bytes.size in 29..65536) { "Unreadable remembered devices" }
    val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
      init(Cipher.DECRYPT_MODE, store.getKey(encryptionAlias, null) as SecretKey, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      updateAAD(install.toByteArray()); doFinal(bytes.copyOfRange(12, bytes.size))
    }
    return JSONObject(String(plain, Charsets.UTF_8))
  }
  fun write(value: JSONObject) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.ENCRYPT_MODE, store.getKey(encryptionAlias, null) as SecretKey); updateAAD(install.toByteArray())
    }
    val bytes = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
    val stream = file.startWrite()
    try { stream.write(bytes); file.finishWrite(stream) } catch (e: Exception) { file.failWrite(stream); throw e }
  }
}
internal object TrustCrypto {
  fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
  fun bytes(value: String): ByteArray {
    require(value.length % 2 == 0 && value.matches(Regex("[0-9a-f]*")))
    return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  }
  fun nonce() = hex(ByteArray(32).also { SecureRandom().nextBytes(it) })
  fun hash(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
  fun point(key: ECPublicKey): String {
    fun coordinate(n: BigInteger) = n.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
    return hex(byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY))
  }
  fun publicKey(raw: String): PublicKey {
    require(raw.matches(Regex("04[0-9a-f]{128}")))
    val b = bytes(raw)
    val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, b.copyOfRange(1, 33)), BigInteger(1, b.copyOfRange(33, 65))), params))
  }
  fun verify(key: String, text: String, signature: String): Boolean = runCatching {
    require(signature.length <= 144)
    Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey(key)); update(text.toByteArray(Charsets.UTF_8)); verify(bytes(signature)) }
  }.getOrDefault(false)
  fun name(value: String) = value.filterNot { it.isISOControl() || it in '\u202a'..'\u202e' || it in '\u2066'..'\u2069' }.trim().take(40).ifEmpty { "DuoDesk device" }
  fun exact(v: JSONObject, kind: String, vararg fields: String) {
    require(v.opt("v") == 1 && v.optString("type") == kind && v.keys().asSequence().toSet() == setOf("v", "type", *fields)) { "Invalid remembered message" }
  }
}
