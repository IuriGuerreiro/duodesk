package expo.modules.testvideo

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class TrustedReconnectTest {
  private data class Result(val value: Any? = null, val error: String? = null)
  private class AwaitPromise : Promise {
    val result = CompletableFuture<Result>()
    override fun resolve(value: Any?) { result.complete(Result(value = value)) }
    override fun reject(code: String?, message: String?, cause: Throwable?) { result.complete(Result(error = code)) }
    override fun reject(exception: CodedException) { result.complete(Result(error = exception.code)) }
    fun await(): Result = result.get(10, TimeUnit.SECONDS)
  }

  private class Fixture : AutoCloseable {
    val server = MockWebServer()
    val certificate = HeldCertificate.Builder().commonName("DuoDesk test").build()
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(certificate.certificate.encoded).hex()
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val publicKey = p256PublicKeyBytes(pair.public as java.security.interfaces.ECPublicKey)
    val phoneId = MessageDigest.getInstance("SHA-256").digest(publicKey).hex()
    val now = AtomicLong(1000)
    val transport = TrustedReconnectTransport { now.get() }
    val messages = AtomicInteger()
    val failures = CompletableFuture<Throwable>()
    lateinit var record: TrustedDesktop
    val identity = object : TrustedIdentityStore {
      override fun get(fingerprint: String): TrustedDesktop { check(fingerprint == record.fingerprint); return record }
      override fun sign(record: TrustedDesktop, bytes: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.private); update(bytes); sign()
      }
    }
    val nonce = "a1".repeat(32)

    fun start(pin: String = fingerprint, handler: (WebSocket, JSONObject) -> Unit) {
      server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
      server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
          messages.incrementAndGet()
          try { handler(webSocket, JSONObject(text)) }
          catch (error: Throwable) { failures.complete(error); webSocket.close(1011, "Test handler failed") }
        }
      }))
      val ip = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>().first { it.isSiteLocalAddress && !it.isLoopbackAddress }
      server.start(ip, 0)
      record = TrustedDesktop(pin, phoneId, "${ip.hostAddress}:${server.port}", "test", 1)
    }
    fun challenge(socket: WebSocket) {
      socket.send(JSONObject().put("v", 1).put("type", "trust_challenge").put("phoneId", phoneId)
        .put("fingerprint", record.fingerprint).put("nonce", nonce).toString())
    }
    fun invitation(host: String = record.address.substringBefore(':')) = JSONObject().put("v", 1)
      .put("sessionId", "a".repeat(32)).put("url", "wss://$host:12345/").put("token", "d".repeat(64))
      .put("fingerprint", record.fingerprint).put("expiresAt", System.currentTimeMillis() + 120_000)
    fun request(): AwaitPromise = AwaitPromise().also { transport.connect(identity, record.fingerprint, transport.ticket(), it) }
    fun assertServer() { if (failures.isDone) throw failures.get() }
    override fun close() { transport.destroy(); server.shutdown() }
  }

  @Test fun pinnedTlsReconnectUsesExactVersionedBytesAndAnOrdinaryInvitation() {
    Fixture().use { f ->
      f.start { socket, message ->
        when (message.getString("type")) {
          "trust_connect" -> {
            assertEquals(setOf("v", "type", "phoneId"), message.keys().asSequence().toSet())
            assertEquals(f.phoneId, message.getString("phoneId"))
            f.challenge(socket)
          }
          "trust_proof" -> {
            assertEquals(setOf("v", "type", "phoneId", "signature"), message.keys().asSequence().toSet())
            val expected = "DuoDesk trusted reconnect v1\n".toByteArray(Charsets.US_ASCII) +
              ByteArray(32) { 0xa1.toByte() } + f.record.fingerprint.hexBytes(32) + MessageDigest.getInstance("SHA-256").digest(f.publicKey)
            val signature = message.getString("signature").let { it.hexBytes(it.length / 2) }
            assertTrue(Signature.getInstance("SHA256withECDSA").run { initVerify(f.pair.public); update(expected); verify(signature) })
            socket.send(JSONObject().put("v", 1).put("type", "trust_invitation").put("invitation", f.invitation()).toString())
          }
          else -> fail("Unexpected message")
        }
      }
      val result = f.request().await()
      f.assertServer()
      assertNull(result.error)
      assertEquals(f.record.fingerprint, JSONObject(result.value as String).getString("fingerprint"))
      assertEquals(2, f.messages.get())
    }
  }

  @Test fun incorrectPinSendsNoPhoneIdentityOrProof() {
    Fixture().use { f ->
      f.start(pin = "0".repeat(64)) { _, _ -> fail("Identity sent before pin validation") }
      assertEquals("ERR_TRUST_AUTH", f.request().await().error)
      assertEquals(0, f.messages.get())
    }
  }

  @Test fun postOpenAbruptCloseIsTerminalForUnknownOrRevokedPhones() {
    Fixture().use { f ->
      f.start { _, _ -> Thread { f.server.shutdown() }.start() }
      assertEquals("ERR_TRUST_AUTH", f.request().await().error)
      assertEquals(1, f.messages.get())
    }
  }

  @Test fun invitationHostCannotRedirectASavedDesktop() {
    Fixture().use { f ->
      f.start { socket, message ->
        if (message.getString("type") == "trust_connect") f.challenge(socket)
        else socket.send(JSONObject().put("v", 1).put("type", "trust_invitation").put("invitation", f.invitation("192.168.254.254")).toString())
      }
      assertEquals("ERR_TRUST_AUTH", f.request().await().error)
      f.assertServer()
    }
  }

  @Test fun duplicateChallengeCannotProduceASecondProof() {
    Fixture().use { f ->
      f.start { socket, message ->
        if (message.getString("type") == "trust_connect") f.challenge(socket)
        else f.challenge(socket)
      }
      assertEquals("ERR_TRUST_AUTH", f.request().await().error)
      f.assertServer()
      assertEquals(2, f.messages.get())
    }
  }

  @Test fun expiredChallengeCannotReleaseAnInvitation() {
    Fixture().use { f ->
      f.start { socket, message ->
        if (message.getString("type") == "trust_connect") f.challenge(socket)
        else {
          f.now.addAndGet(30_001)
          socket.send(JSONObject().put("v", 1).put("type", "trust_invitation").put("invitation", f.invitation()).toString())
        }
      }
      assertEquals("ERR_TRUST_AUTH", f.request().await().error)
      f.assertServer()
    }
  }

  @Test fun cancelledGenerationCannotOpenAnotherTransport() {
    val transport = TrustedReconnectTransport { 0L }
    val ticket = transport.ticket()
    transport.close()
    val store = object : TrustedIdentityStore {
      override fun get(fingerprint: String): TrustedDesktop = error("Cancelled request reached storage")
      override fun sign(record: TrustedDesktop, bytes: ByteArray): ByteArray = error("Cancelled request signed")
    }
    val promise = AwaitPromise()
    transport.connect(store, "a".repeat(64), ticket, promise)
    assertEquals("ERR_TRUST_CANCELLED", promise.await().error)
    transport.destroy()
  }

  @Test fun invalidOrAmbiguousProofComponentsAreRejected() {
    for (invalid in listOf("a".repeat(63), "A".repeat(64), "a".repeat(65))) {
      try { trustedProofBytes(invalid, "b".repeat(64), "c".repeat(64)); fail("Invalid nonce accepted") }
      catch (_: IllegalArgumentException) { }
    }
  }
}
