package expo.modules.testvideo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class TrustFailure(val code: String, message: String) : Exception(message)

internal fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
internal fun String.hexBytes(size: Int): ByteArray {
  require(length == size * 2 && matches(Regex("[0-9a-f]+"))) { "Invalid trusted device encoding" }
  return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}

internal data class TrustedDesktop(
  val fingerprint: String,
  val phoneId: String,
  val address: String,
  val alias: String,
  val createdAt: Long,
) {
  fun json() = JSONObject().put("fingerprint", fingerprint).put("phoneId", phoneId)
    .put("address", address).put("alias", alias).put("createdAt", createdAt)
}

internal data class EnrollmentKey(val fingerprint: String, val phoneId: String, val publicKey: String, val alias: String)

/** The encrypted registry and exclusive per-desktop keys have one process-wide writer. */
internal interface TrustedIdentityStore {
  fun get(fingerprint: String): TrustedDesktop
  fun sign(record: TrustedDesktop, bytes: ByteArray): ByteArray
}

internal class TrustedDesktopStore private constructor(context: Context) : TrustedIdentityStore {
  private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private val file = AtomicFile(File(context.noBackupFilesDir, "trusted-desktops.v1"))
  private var records: List<TrustedDesktop> = load()

  init {
    val referenced = records.map { it.alias }.toSet()
    keys.aliases().toList().filter { it.startsWith(PHONE_PREFIX) && it !in referenced }.forEach { keys.deleteEntry(it) }
  }

  private fun storageKey(create: Boolean): SecretKey {
    val existing = keys.getKey(STORAGE_ALIAS, null)
    if (existing is SecretKey) return existing
    check(create && !keys.containsAlias(STORAGE_ALIAS)) { "Saved desktop encryption key is missing. Explicit pairing is required." }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(STORAGE_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  private fun load(): List<TrustedDesktop> {
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return emptyList()
    try {
      val bytes = file.openRead().use { input ->
        val content = input.readBytes()
        require(content.size in 30..65_536)
        content
      }
      require(bytes[0] == 1.toByte())
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, storageKey(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
      cipher.updateAAD(AAD)
      val data = JSONObject(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
      require(data.getInt("v") == 1)
      val list = data.getJSONArray("desktops")
      require(list.length() <= 32)
      return (0 until list.length()).map { i ->
        val entry = list.getJSONObject(i)
        val fingerprint = entry.getString("fingerprint").also { it.hexBytes(32) }
        val phoneId = entry.getString("phoneId").also { it.hexBytes(32) }
        val address = entry.getString("address").also { LanAddress.parse(it) }
        val alias = entry.getString("alias").also { require(it.startsWith(PHONE_PREFIX + fingerprint + ".")) }
        TrustedDesktop(fingerprint, phoneId, address, alias, entry.getLong("createdAt"))
      }.also { require(it.map { r -> r.fingerprint }.distinct().size == it.size) }
    } catch (error: Exception) {
      throw TrustFailure("ERR_TRUST_STORAGE", "Saved desktops could not be decrypted. Trust was not replaced. Clear app storage and explicitly pair again if the Android keys were lost.")
    }
  }

  private fun write(next: List<TrustedDesktop>) {
    val data = JSONObject().put("v", 1).put("desktops", JSONArray(next.map { it.json() }))
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, storageKey(true))
    cipher.updateAAD(AAD)
    val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(data.toString().toByteArray(Charsets.UTF_8))
    val output = file.startWrite()
    try {
      output.write(encrypted)
      file.finishWrite(output)
    } catch (error: Exception) {
      file.failWrite(output)
      throw error
    }
    records = next
  }

  @Synchronized fun list(): List<Map<String, Any>> = records.map {
    mapOf("fingerprint" to it.fingerprint, "phoneId" to it.phoneId, "address" to it.address,
      "createdAt" to it.createdAt, "keyAvailable" to keyMatches(it))
  }

  @Synchronized override fun get(fingerprint: String): TrustedDesktop {
    val record = records.find { it.fingerprint == fingerprint }
      ?: throw TrustFailure("ERR_TRUST_AUTH", "This desktop is no longer saved. Pair with a new code.")
    if (!keyMatches(record)) throw TrustFailure("ERR_TRUST_AUTH", "The phone key is missing or changed. Forget this desktop and explicitly pair again.")
    return record
  }

  private fun keyMatches(record: TrustedDesktop): Boolean = runCatching {
    val publicKey = keys.getCertificate(record.alias)?.publicKey as? ECPublicKey ?: return false
    keys.isKeyEntry(record.alias) && MessageDigest.getInstance("SHA-256").digest(p256PublicKeyBytes(publicKey)).hex() == record.phoneId
  }.getOrDefault(false)

  @Synchronized fun prepare(fingerprint: String): EnrollmentKey {
    fingerprint.hexBytes(32)
    if (records.any { it.fingerprint == fingerprint }) throw TrustFailure("ERR_TRUST_AUTH", "This desktop is already saved. Forget it before enrolling a replacement key.")
    check(records.size < 32) { "Forget a saved desktop before adding another." }
    val alias = PHONE_PREFIX + fingerprint + "." + UUID.randomUUID()
    try {
      val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
      }.generateKeyPair()
      val publicKey = p256PublicKeyBytes(pair.public as ECPublicKey)
      return EnrollmentKey(fingerprint, MessageDigest.getInstance("SHA-256").digest(publicKey).hex(), publicKey.hex(), alias)
    } catch (error: Exception) { keys.deleteEntry(alias); throw error }
  }

  @Synchronized fun commit(key: EnrollmentKey, address: String) {
    LanAddress.parse(address)
    check(records.none { it.fingerprint == key.fingerprint }) { "Pinned desktop identity cannot be replaced. Forget it first." }
    val record = TrustedDesktop(key.fingerprint, key.phoneId, address, key.alias, System.currentTimeMillis())
    check(keyMatches(record)) { "Enrollment key was lost. Explicit pairing is required." }
    write(records + record)
  }

  @Synchronized fun discard(key: EnrollmentKey) {
    if (records.none { it.alias == key.alias }) keys.deleteEntry(key.alias)
  }

  @Synchronized fun updateAddress(fingerprint: String, address: String) {
    LanAddress.parse(address)
    get(fingerprint)
    write(records.map { if (it.fingerprint == fingerprint) it.copy(address = address) else it })
  }

  @Synchronized fun forget(fingerprint: String) {
    val record = records.find { it.fingerprint == fingerprint } ?: return
    write(records.filter { it.fingerprint != fingerprint })
    keys.deleteEntry(record.alias)
  }

  @Synchronized override fun sign(record: TrustedDesktop, bytes: ByteArray): ByteArray {
    check(get(record.fingerprint) == record) { "Saved trust changed during reconnect" }
    val key = keys.getKey(record.alias, null) as? java.security.PrivateKey
      ?: throw TrustFailure("ERR_TRUST_AUTH", "The signing key is missing. Explicit pairing is required.")
    return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(bytes); sign() }
  }

  companion object {
    private const val STORAGE_ALIAS = "duodesk.trust.storage.v1"
    private const val PHONE_PREFIX = "duodesk.trust.phone.v1."
    private val AAD = "DuoDesk trusted desktops v1".toByteArray(Charsets.US_ASCII)
    private var instance: TrustedDesktopStore? = null
    @Synchronized fun get(context: Context): TrustedDesktopStore = instance
      ?: TrustedDesktopStore(context.applicationContext).also { instance = it }
  }
}
