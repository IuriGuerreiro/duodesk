package expo.modules.testvideo

import android.content.Context
import org.json.JSONObject
import org.json.JSONArray
import okhttp3.*
import java.net.URI
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/** An authenticated waiting link grants no capture, viewing or control permission. */
internal class TrustManager(context: Context, private val event: (Map<String, Any?>) -> Unit, private val endSession: () -> Unit) {
  private val identity = runCatching { TrustIdentity(context) }
  private val loaded = runCatching { identity.getOrThrow().read() }
  private var peers = loaded.getOrElse { JSONObject() }
  private var storageError: String? = loaded.exceptionOrNull()?.let { "Secure storage unavailable. Unlock the phone and restart DuoDesk." }
  private val revoked = mutableSetOf<String>()
  private val links = mutableMapOf<String, WebSocket>()
  private val clients = mutableMapOf<String, OkHttpClient>()
  private val opening = mutableMapOf<String, WebSocket>()
  private val pending = mutableMapOf<String, Pair<String, String>>() // request -> device, direction
  private val incoming = mutableSetOf<String>()
  private val approved = mutableSetOf<String>()
  private val prepared = mutableSetOf<String>()
  private var session: Pair<String, TrustEnrollment>? = null
  private var sessionDevice: String? = null
  private var boundSession: String? = null
  private var boundRequest: String? = null
  private var foreground = false
  private val browser = NearbyBrowser(context, "_duodesk-trust._tcp.") { value ->
    if (value["type"] == "found") {
      val hosts = value["hosts"] as? List<*> ?: emptyList<Any>()
      val port = value["port"] as? Int ?: 0
      hosts.filterIsInstance<String>().firstOrNull { lan("$it:$port") }?.let { address -> runCatching { open("$address:$port") } }
    }
  }
  init {
    try {
      val copy = JSONObject(peers.toString())
      copy.keys().asSequence().toList().filter { !copy.getJSONObject(it).optBoolean("active") }.forEach(copy::remove)
      if (copy.toString() != peers.toString()) persist(copy)
    } catch (_: Exception) { storageError = "Remembered storage is unreadable. Clear DuoDesk app data and pair again." }
    current = this
  }
  @Synchronized fun status(): JSONObject = JSONObject().put("available", storageError == null).put("error", storageError ?: JSONObject.NULL)
    .put("devices", JSONArray(peers.keys().asSequence().filter { peers.getJSONObject(it).optBoolean("active") && it !in revoked }.map { id ->
      val p = peers.getJSONObject(id)
      JSONObject().put("id", id).put("name", p.getString("name")).put("address", p.optString("address")).put("available", links.containsKey(id))
    }.toList()))
  private fun publish() = event(mapOf("type" to "status", "status" to status().toString()))
  private fun persist(copy: JSONObject) {
    check(storageError == null) { storageError ?: "Secure storage unavailable" }
    identity.getOrThrow().write(copy); peers = copy
  }
  @Synchronized private fun save(key: String, name: String, active: Boolean) {
    val id = TrustCrypto.hash(TrustCrypto.bytes(key)); val copy = JSONObject(peers.toString())
    check(copy.length() < 32 || copy.has(id)) { "Forget a device before adding more." }
    copy.put(id, JSONObject().put("key", key).put("name", TrustCrypto.name(name)).put("active", active).put("address", copy.optJSONObject(id)?.optString("address") ?: ""))
    persist(copy); revoked.remove(id); if (active) { sessionDevice = id; boundSession = session?.first; boundRequest = null }; publish()
  }
  @Synchronized private fun discard(key: String) {
    if (key.isEmpty()) return
    val id = TrustCrypto.hash(TrustCrypto.bytes(key))
    if (peers.optJSONObject(id)?.optBoolean("active") == false) {
      val copy = JSONObject(peers.toString()); copy.remove(id)
      try { persist(copy) } catch (_: Exception) { revoked.add(id) }
    }
  }
  @Synchronized fun paired(invitation: Invitation, send: (JSONObject) -> Boolean) {
    if (!prepared.remove(invitation.sessionId) || storageError != null) return
    session?.second?.cancel()
    session = Pair(invitation.sessionId, TrustEnrollment(identity.getOrThrow(), invitation, send, ::save, ::discard, event, TrustCrypto.name(android.os.Build.MODEL)) { enrollment, ticket -> synchronized(this) { if (session?.second === enrollment) enrollment.expire(ticket) } })
    send(JSONObject().put("type", "enroll_hello")); event(mapOf("type" to "enroll", "state" to "capable"))
  }
  @Synchronized fun enrollment(invitation: Invitation, text: String): Boolean {
    val v = JSONObject(text)
    if (!v.optString("type").startsWith("enroll_")) return false
    check(text.toByteArray().size <= 4096)
    session?.takeIf { it.first == invitation.sessionId }?.second?.receive(v)
    return true
  }
  @Synchronized fun detached(id: String) {
    if (session?.first == id) { session?.second?.cancel(); session = null }
    prepared.remove(id)
    if (boundSession == id) { boundSession = null; sessionDevice = null; boundRequest = null }
  }
  @Synchronized private fun forget(id: String, notify: Boolean) {
    revoked.add(id)
    if (notify) links[id]?.send(JSONObject().put("v", 1).put("type", "forget").toString())
    links.remove(id)?.close(1000, "Forgotten")
    pending.filterValues { it.first == id }.keys.toList().forEach { pending.remove(it); incoming.remove(it); approved.remove(it) }
    if (sessionDevice == id) { endSession(); sessionDevice = null }
    val copy = JSONObject(peers.toString()); copy.remove(id)
    try { persist(copy) } catch (_: Exception) { publish(); error("Device blocked until DuoDesk closes, but removal could not be saved. Unlock secure storage and try Forget again.") }
    if (peers.length() == 0) browser.stop()
    publish()
  }
  @Synchronized fun command(method: String, args: JSONObject): String {
    when (method) {
      "status" -> return status().toString()
      "prepare" -> {
        val invitation = Invitation.parse(args.getString("invitation"))
        if (args.optBoolean("enabled")) { if (prepared.size >= 8) prepared.clear(); prepared.add(invitation.sessionId) }
        if (args.has("deviceId")) sessionDevice = args.getString("deviceId")
      }
      "enroll" -> session?.second?.action(args.getString("action"), args.optString("name")) ?: error("Pair with an updated PC first.")
      "rename" -> {
        val id = args.getString("deviceId"); check(peers.has(id)); val copy = JSONObject(peers.toString())
        copy.getJSONObject(id).put("name", TrustCrypto.name(args.getString("name"))); persist(copy); publish()
      }
      "forget" -> forget(args.getString("deviceId"), true)
      "foreground" -> {
        foreground = args.getBoolean("active")
        if (foreground) { check(storageError == null) { storageError ?: "Storage unavailable" }; if (peers.keys().asSequence().any { peers.getJSONObject(it).optBoolean("active") }) browser.start() else browser.stop(); peers.keys().asSequence().toList().forEach { id -> peers.getJSONObject(id).optString("address").takeIf { it.isNotEmpty() }?.let { runCatching { open(it) } } } }
        else { browser.stop(); opening.values.toList().forEach { it.cancel() }; opening.clear(); links.values.toList().forEach { it.cancel() }; links.clear(); clients.values.toList().forEach { it.dispatcher.executorService.shutdown(); it.connectionPool.evictAll() }; clients.clear(); pending.clear(); incoming.clear(); approved.clear(); publish() }
      }
      "link" -> { check(foreground) { "Open DuoDesk first." }; open(args.getString("address")) }
      "connect" -> {
        val id = args.getString("deviceId"); val direction = Direction.parse(args.getString("direction")).wire
        require(peers.optJSONObject(id)?.optBoolean("active") == true && id !in revoked)
        check(pending.values.none { it.first == id }) { "A request is already open." }
        val requestId = TrustCrypto.nonce().take(32); pending[requestId] = Pair(id, direction)
        check(links[id]?.send(JSONObject().put("v", 1).put("type", "connect_request").put("requestId", requestId).put("direction", direction).toString()) == true) { "PC unavailable. Open DuoDesk on the PC, check Wi-Fi, or pair again." }
        expire(requestId); return JSONObject().put("requestId", requestId).toString()
      }
      "respond" -> {
        val id = args.getString("requestId"); val request = pending[id] ?: error("Request expired")
        check(id in incoming)
        val accept = args.getBoolean("accept")
        if (accept) approved.add(id) else { pending.remove(id); incoming.remove(id) }
        links[request.first]?.send(JSONObject().put("v", 1).put("type", if (accept) "connect_accept" else "connect_reject").put("requestId", id).toString())
      }
      "cancel" -> cancel(args.getString("requestId"))
      else -> error("Unknown remembered command")
    }
    return "null"
  }
  private fun cancel(id: String) {
    val request = pending.remove(id) ?: run {
      if (boundRequest == id) {
        sessionDevice?.let { links[it]?.send(JSONObject().put("v", 1).put("type", "connect_cancel").put("requestId", id).toString()) }
        endSession(); boundRequest = null; boundSession = null; sessionDevice = null
        event(mapOf("type" to "cancelled", "requestId" to id))
      }
      return
    }
    incoming.remove(id); approved.remove(id)
    links[request.first]?.send(JSONObject().put("v", 1).put("type", "connect_cancel").put("requestId", id).toString())
    event(mapOf("type" to "cancelled", "requestId" to id))
  }
  private fun expire(id: String) { timer.schedule(object : java.util.TimerTask() { override fun run() { synchronized(this@TrustManager) { if (pending.containsKey(id)) cancel(id) } } }, 60_000) }
  @Synchronized private fun open(address: String) {
    require(lan(address)) { "Use a private LAN IPv4 address and port." }
    if (!foreground || opening.containsKey(address) || opening.size >= 16 || storageError != null) return
    var selected: String? = null
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Not supported") }
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val key = (chain.firstOrNull()?.publicKey as? ECPublicKey)?.let(TrustCrypto::point) ?: throw CertificateException("Unexpected PC identity")
        synchronized(this@TrustManager) {
          val id = TrustCrypto.hash(TrustCrypto.bytes(key))
          if (peers.optJSONObject(id)?.let { it.optBoolean("active") && it.optString("key") == key } != true || id in revoked) throw CertificateException("PC identity changed. Pair again.")
          selected = id
        }
      }
    }
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust).hostnameVerifier { host, _ -> host == URI("wss://$address/").host }
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS)).connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(10, TimeUnit.SECONDS).build()
    clients[address] = client
    val socket = client.newWebSocket(Request.Builder().url("wss://$address/").build(), object : WebSocketListener() {
      private var challenged = false
      override fun onMessage(socket: WebSocket, text: String) {
        synchronized(this@TrustManager) {
          if (!foreground || opening[address] !== socket) { socket.cancel(); return }
          try {
            require(text.toByteArray().size <= 4096)
            val v = JSONObject(text); val kind = v.getString("type"); val id = selected ?: error("PC identity missing")
            check(id !in revoked && peers.optJSONObject(id)?.optBoolean("active") == true)
            when (kind) {
              "challenge" -> {
                TrustCrypto.exact(v, kind, "nonce"); check(!challenged); challenged = true
                val nonce = v.getString("nonce"); require(nonce.matches(Regex("[a-f0-9]{64}")))
                val mine = identity.getOrThrow(); val cn = TrustCrypto.nonce(); val key = peers.getJSONObject(id).getString("key")
                val transcript = listOf("duodesk-reconnect-v1", "phone", key, mine.publicKey, nonce, cn).joinToString("\n")
                socket.send(JSONObject().put("v", 1).put("type", "auth").put("key", mine.publicKey).put("nonce", cn).put("signature", mine.sign(transcript)).toString())
              }
              "authenticated" -> {
                TrustCrypto.exact(v, kind); check(challenged)
                links.put(id, socket)?.takeIf { it !== socket }?.cancel()
                val copy = JSONObject(peers.toString()); copy.getJSONObject(id).put("address", address); persist(copy); publish()
              }
              else -> { check(links[id] === socket); receiveLink(id, v) }
            }
          } catch (_: Exception) { socket.cancel(); event(mapOf("type" to "error", "message" to "Remembered authentication failed. Pair again if the PC identity changed.")) }
        }
      }
      override fun onFailure(socket: WebSocket, t: Throwable, response: Response?) { closed(socket) }
      override fun onClosed(socket: WebSocket, code: Int, reason: String) { closed(socket) }
      private fun closed(socket: WebSocket) { synchronized(this@TrustManager) {
        if (opening[address] === socket) { opening.remove(address); clients.remove(address)?.let { it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() } }
        selected?.let { id -> if (links[id] === socket) { links.remove(id); pending.filterValues { it.first == id }.keys.toList().forEach(::cancel); publish() } }
      } }
    })
    opening[address] = socket
    timer.schedule(object : java.util.TimerTask() { override fun run() { synchronized(this@TrustManager) { if (opening[address] === socket && links.values.none { it === socket }) socket.cancel() } } }, 15_000)
  }
  private fun receiveLink(device: String, v: JSONObject) {
    val type = v.getString("type")
    if (type == "forget") { TrustCrypto.exact(v, type); forget(device, false); return }
    val fields = when (type) { "connect_request" -> arrayOf("requestId", "direction"); "invitation" -> arrayOf("requestId", "invitation"); "connect_accept", "connect_reject", "connect_cancel" -> arrayOf("requestId"); else -> error("Invalid link message") }
    TrustCrypto.exact(v, type, *fields)
    val id = v.getString("requestId"); require(id.matches(Regex("[0-9a-f]{32}")))
    when (type) {
      "connect_request" -> {
        check(!pending.containsKey(id) && pending.values.none { it.first == device })
        val direction = Direction.parse(v.getString("direction")).wire; pending[id] = Pair(device, direction); incoming.add(id); expire(id)
        event(mapOf("type" to "request", "requestId" to id, "deviceId" to device, "direction" to direction))
      }
      "connect_accept" -> { check(pending[id]?.first == device && id !in incoming); approved.add(id) }
      "connect_reject", "connect_cancel" -> { check(pending[id]?.first == device); pending.remove(id); incoming.remove(id); approved.remove(id); event(mapOf("type" to "cancelled", "requestId" to id)) }
      "invitation" -> {
        val request = pending[id] ?: error("Request expired"); check(request.first == device && id in approved)
        val text = v.getString("invitation"); val invitation = Invitation.parse(text); check(invitation.direction.wire == request.second)
        check(URI(invitation.url).host == URI("wss://${peers.getJSONObject(device).getString("address")}/").host) { "Session endpoint changed" }
        pending.remove(id); incoming.remove(id); approved.remove(id); sessionDevice = device; boundSession = invitation.sessionId; boundRequest = id
        event(mapOf("type" to "invitation", "deviceId" to device, "invitation" to text))
      }
    }
  }
  fun destroy() { command("foreground", JSONObject().put("active", false)); session?.second?.cancel(); browser.destroy(); if (current === this) current = null }
  companion object {
    @Volatile var current: TrustManager? = null
    private val timer = java.util.Timer("DuoDesk trust timeouts", true)
    fun lan(address: String): Boolean = runCatching {
      val m = Regex("([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.([0-9]+):([0-9]+)").matchEntire(address) ?: return false
      val n = m.groupValues.drop(1).map(String::toInt)
      (n.take(4).joinToString(".") + ":" + n[4]) == address && n.take(4).all { it in 0..255 } && n[4] in 1..65535 && (n[0] == 10 || n[0] == 172 && n[1] in 16..31 || n[0] == 192 && n[1] == 168 || n[0] == 169 && n[1] == 254)
    }.getOrDefault(false)
  }
}
