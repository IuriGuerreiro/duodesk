package expo.modules.testvideo

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * The desktop's self-signed leaf certificate is authenticated by the invitation fingerprint.
 * Pairing recovered the invitation over an encrypted channel, so nothing else is trusted.
 * Listener callbacks run on OkHttp threads.
 */
internal class PinnedSignaling(private val invitation: Invitation, private val listener: Listener) {
  interface Listener {
    fun onMessage(text: String)
    fun onFailure(message: String)
    fun onClosed()
  }

  private var client: OkHttpClient? = null
  private var socket: WebSocket? = null

  /** Connects, then claims the invitation with its pairing token. */
  fun open() {
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Client trust is not supported") }
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("Missing receiver certificate")
        val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
        if (digest != invitation.fingerprint) throw CertificateException("Receiver certificate does not match the invitation")
      }
    }
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
      .hostnameVerifier { host, _ -> host == URI(invitation.url).host }
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS)).pingInterval(10, TimeUnit.SECONDS)
      .connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    this.client = client
    socket = client.newWebSocket(Request.Builder().url(invitation.url).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        send(JSONObject().put("type", "pair").put("token", invitation.token))
      }
      override fun onMessage(webSocket: WebSocket, text: String) {
        try {
          val trust = TrustManager.current
          if (JSONObject(text).optString("type") == "paired") trust?.paired(invitation, ::send)
          if (trust?.enrollment(invitation, text) == true) return
          listener.onMessage(text)
        } catch (_: Exception) { listener.onFailure("Remembered-device protocol failed. Pair again.") }
      }
      override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = listener.onFailure("Unexpected binary signaling message")
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onFailure("Receiver connection failed: ${t.message}")
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed()
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed()
    })
  }

  fun send(message: JSONObject): Boolean {
    message.put("v", 1).put("sessionId", invitation.sessionId)
    return socket?.send(message.toString()) == true
  }

  /** Tells the desktop to stop, then drops the connection. */
  fun close() {
    TrustManager.current?.detached(invitation.sessionId)
    runCatching { send(JSONObject().put("type", "stop")) }
    socket?.cancel(); socket = null
    client?.dispatcher?.executorService?.shutdown(); client?.connectionPool?.evictAll(); client = null
  }
}
