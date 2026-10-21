package expo.modules.testvideo

import android.os.SystemClock
import expo.modules.kotlin.Promise
import okhttp3.*
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/** No capture or sender reference: this transport can only obtain a v1 invitation. */
internal class TrustedReconnectTransport(private val now: () -> Long = { SystemClock.elapsedRealtime() }) {
  private val lock = Any()
  private var generation = 0L
  private val timer = Executors.newSingleThreadScheduledExecutor()
  private sealed interface Handshake {
    data object Connecting : Handshake
    data object AwaitChallenge : Handshake
    data class AwaitInvitation(val deadline: Long) : Handshake
  }
  private data class Attempt(val promise: Promise, val client: OkHttpClient,
    var socket: WebSocket? = null, var timeout: ScheduledFuture<*>? = null,
    var handshake: Handshake = Handshake.Connecting)
  private var active: Attempt? = null

  fun ticket(): Long = synchronized(lock) { generation }

  fun close() = synchronized(lock) {
    generation++
    active?.let { finish(it, TrustFailure("ERR_TRUST_CANCELLED", "Reconnect cancelled.")) }
  }

  fun destroy() { close(); timer.shutdownNow() }

  private fun finish(attempt: Attempt, error: TrustFailure? = null, invitation: String? = null) {
    if (active !== attempt) return
    active = null
    attempt.timeout?.cancel(false)
    attempt.socket?.cancel()
    attempt.client.dispatcher.executorService.shutdown()
    attempt.client.connectionPool.evictAll()
    if (error != null) attempt.promise.reject(error.code, error.message, error)
    else attempt.promise.resolve(requireNotNull(invitation))
  }

  fun connect(store: TrustedIdentityStore, fingerprint: String, ticket: Long, promise: Promise) = synchronized(lock) {
    if (ticket != generation) {
      promise.reject("ERR_TRUST_CANCELLED", "Reconnect cancelled.", null)
      return@synchronized
    }
    try {
      check(active == null) { "A reconnect is already running" }
      val record = store.get(fingerprint)
      LanAddress.parse(record.address)
      val trust = object : X509TrustManager {
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Client trust is unsupported") }
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
          val leaf = chain.firstOrNull() ?: throw CertificateException("Missing desktop certificate")
          if (MessageDigest.getInstance("SHA-256").digest(leaf.encoded).hex() != record.fingerprint)
            throw CertificateException("Desktop identity changed. Explicit pairing is required.")
        }
      }
      val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
      val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
        .hostnameVerifier { host, _ -> host == record.address.substringBefore(':') }
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS)).connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS).build()
      val attempt = Attempt(promise, client)
      active = attempt
      attempt.timeout = timer.schedule({ synchronized(lock) {
        if (active === attempt) finish(attempt, TrustFailure(
          if (attempt.handshake == Handshake.Connecting) "ERR_TRUST_NETWORK" else "ERR_TRUST_AUTH",
          "Desktop did not respond. Check Wi-Fi and turn on Allow reconnects on the desktop."))
      } }, 15, TimeUnit.SECONDS)
      attempt.socket = client.newWebSocket(Request.Builder().url("wss://${record.address}/").build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(lock) {
          if (active !== attempt || generation != ticket) { webSocket.cancel(); return@synchronized }
          attempt.handshake = Handshake.AwaitChallenge
          // onOpen runs only after the TLS certificate pin above succeeds.
          if (!webSocket.send(JSONObject().put("v", 1).put("type", "trust_connect").put("phoneId", record.phoneId).toString()))
            finish(attempt, TrustFailure("ERR_TRUST_AUTH", "The desktop ended remembered access before authentication."))
        }
        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(lock) {
          if (active !== attempt || generation != ticket) return@synchronized
          try {
            require(text.toByteArray(Charsets.UTF_8).size <= 8192) { "Trusted response is too large" }
            val message = JSONObject(text)
            require(message.getInt("v") == 1)
            when (val handshake = attempt.handshake) {
              Handshake.AwaitChallenge -> {
                require(message.keys().asSequence().toSet() == setOf("v", "type", "phoneId", "fingerprint", "nonce"))
                require(message.getString("type") == "trust_challenge" && message.getString("phoneId") == record.phoneId && message.getString("fingerprint") == record.fingerprint)
                val challengeDeadline = now() + 30_000
                val bytes = trustedProofBytes(message.getString("nonce"), record.fingerprint, record.phoneId)
                val signature = store.sign(record, bytes).hex()
                check(now() < challengeDeadline) { "Trusted challenge expired" }
                attempt.handshake = Handshake.AwaitInvitation(challengeDeadline)
                attempt.timeout?.cancel(false)
                attempt.timeout = timer.schedule({ synchronized(lock) {
                  if (active === attempt) finish(attempt, TrustFailure("ERR_TRUST_AUTH", "Trusted challenge expired. Retry or pair with a new code."))
                } }, (challengeDeadline - now()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
                check(webSocket.send(JSONObject().put("v", 1).put("type", "trust_proof").put("phoneId", record.phoneId).put("signature", signature).toString()))
              }
              is Handshake.AwaitInvitation -> {
                require(now() < handshake.deadline) { "Trusted challenge expired" }
                require(message.keys().asSequence().toSet() == setOf("v", "type", "invitation") && message.getString("type") == "trust_invitation")
                val invitation = message.getJSONObject("invitation").toString()
                val parsed = Invitation.parse(invitation)
                require(java.net.URI(parsed.url).host == record.address.substringBefore(':')) { "Desktop invitation address does not match the saved address" }
                require(parsed.fingerprint == record.fingerprint) { "Desktop identity changed. Explicit pairing is required." }
                store.get(record.fingerprint)
                finish(attempt, invitation = invitation)
              }
              Handshake.Connecting -> error("Response before TLS was verified")
            }
          } catch (error: Exception) {
            finish(attempt, TrustFailure("ERR_TRUST_AUTH", error.message ?: "Trusted connection rejected. Pair with a new code."))
          }
        }
        override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = synchronized(lock) {
          finish(attempt, TrustFailure("ERR_TRUST_AUTH", "Invalid trusted desktop response."))
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(lock) {
          val terminal = attempt.handshake != Handshake.Connecting || generateSequence(t) { it.cause }.any { it is SSLException || it is CertificateException } || response != null || t !is IOException
          finish(attempt, TrustFailure(if (terminal) "ERR_TRUST_AUTH" else "ERR_TRUST_NETWORK",
            if (terminal) "Desktop identity could not be verified. Turn on Allow reconnects on the desktop or explicitly pair again."
            else "Cannot reach the saved desktop. Check its address, Wi-Fi, firewall and Allow reconnects setting."))
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = synchronized(lock) {
          finish(attempt, TrustFailure("ERR_TRUST_AUTH", "The desktop rejected remembered access. Turn on Allow reconnects or pair again with a new code."))
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = synchronized(lock) {
          finish(attempt, TrustFailure("ERR_TRUST_AUTH", "The desktop ended remembered access. Pair again if access was revoked."))
        }
      })
    } catch (error: Exception) {
      val failure = error as? TrustFailure ?: TrustFailure("ERR_TRUST_AUTH", error.message ?: "Explicit pairing is required.")
      val attempt = active
      if (attempt?.promise === promise) finish(attempt, failure)
      else promise.reject(failure.code, failure.message, failure)
    }
  }
}
