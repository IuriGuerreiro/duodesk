package expo.modules.testvideo

import android.content.Context
import expo.modules.kotlin.Promise
import okhttp3.*
import org.json.JSONObject
import org.webrtc.*
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

internal data class Invitation(val sessionId: String, val url: String, val token: String, val fingerprint: String) {
  companion object {
    fun parse(text: String): Invitation {
      require(text.toByteArray().size <= 2048) { "Invitation is too large" }
      val json = JSONObject(text)
      require(json.keys().asSequence().toSet() == setOf("v", "sessionId", "url", "token", "fingerprint", "expiresAt")) { "Invalid invitation fields" }
      val uri = URI(json.getString("url"))
      val now = System.currentTimeMillis()
      require(json.getInt("v") == 1 && json.getString("sessionId").matches(Regex("[a-f0-9]{32}")) &&
        json.getString("token").matches(Regex("[a-f0-9]{64}")) && json.getString("fingerprint").matches(Regex("[a-f0-9]{64}")) &&
        json.getLong("expiresAt") > now && json.getLong("expiresAt") <= now + 300_000 &&
        uri.scheme == "wss" && uri.port in 1..65535 && uri.path == "/" && uri.userInfo == null && uri.query == null && uri.fragment == null &&
        uri.host?.split('.')?.let { parts -> parts.size == 4 && parts.all { it.toIntOrNull() in 0..255 } } == true) { "Invalid or expired invitation. Create a new one on the desktop." }
      return Invitation(json.getString("sessionId"), uri.toString(), json.getString("token"), json.getString("fingerprint"))
    }
  }
}

internal class VideoSender(private val context: Context, private val emit: (Map<String, Any>) -> Unit) {
  private val queue = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
  private var generation = 0L
  private var invitation: Invitation? = null
  private var socket: WebSocket? = null
  private var client: OkHttpClient? = null
  private var peer: PeerConnection? = null
  private var source: VideoSource? = null
  private var track: VideoTrack? = null
  private var clip: ClipSource? = null
  private var egl: EglBase? = null
  private var factory: PeerConnectionFactory? = null
  private var timeout: ScheduledFuture<*>? = null
  private var stats: ScheduledFuture<*>? = null
  private val candidates = mutableListOf<IceCandidate>()
  private var acceptingAnswer = false
  private var state = "idle"
  private var previousBytes = 0.0
  private var previousTime = 0.0

  private fun dispatch(action: () -> Unit) {
    if (!queue.isShutdown) runCatching {
      queue.execute { try { action() } catch (error: Exception) { fail(error.message ?: "Streaming failed") } }
    }
  }
  fun submit(promise: Promise, action: VideoSender.() -> Unit) {
    dispatch {
      try { action(); promise.resolve() }
      catch (error: Exception) { fail(error.message ?: "Streaming failed"); promise.reject("ERR_STREAM", error.message, error) }
    }
  }
  fun background() = dispatch { stop() }
  fun destroy() = dispatch {
    close(); factory?.dispose(); factory = null; egl?.release(); egl = null; queue.shutdown()
  }
  private fun status(next: String) { state = next; emit(mapOf("state" to next)) }
  private fun fail(message: String) { close(); state = "failed"; emit(mapOf("state" to "failed", "message" to message)) }
  private fun armTimeout(message: String) {
    timeout?.cancel(false)
    val epoch = generation
    timeout = queue.schedule({ if (generation == epoch) fail(message) }, 20, TimeUnit.SECONDS)
  }

  fun connect(text: String) {
    close()
    val info = Invitation.parse(text)
    invitation = info
    val epoch = generation
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Client trust is not supported") }
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("Missing receiver certificate")
        val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
        if (digest != info.fingerprint) throw CertificateException("Receiver certificate does not match the invitation")
      }
    }
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    // Dedicated client: its trust policy applies only to this invitation, never other app requests.
    val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
      .hostnameVerifier { host, _ -> host == URI(info.url).host }
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS)).pingInterval(10, TimeUnit.SECONDS)
      .connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    this.client = client
    status("connecting")
    armTimeout("Connection timed out. Check Wi-Fi and the desktop firewall.")
    socket = client.newWebSocket(Request.Builder().url(info.url).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) = dispatch {
        if (generation == epoch) send(JSONObject().put("type", "pair").put("token", info.token))
      }
      override fun onMessage(webSocket: WebSocket, text: String) = dispatch {
        if (generation == epoch) runCatching { receive(text) }.onFailure { fail(it.message ?: "Invalid signaling message") }
      }
      override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = dispatch {
        if (generation == epoch) fail("Unexpected binary signaling message")
      }
      override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) = dispatch {
        if (generation == epoch) fail("Receiver connection failed: ${error.message}")
      }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = dispatch {
        if (generation == epoch) stop()
      }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dispatch {
        if (generation == epoch) stop()
      }
    })
  }

  private fun nativeFactory(): PeerConnectionFactory {
    factory?.let { return it }
    initialize(context)
    val egl = EglBase.create()
    this.egl = egl
    return PeerConnectionFactory.builder()
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext)).createPeerConnectionFactory().also { factory = it }
  }

  fun start(bitrateMbps: Int) {
    check(state == "ready") { "Connect to the desktop before starting" }
    require(bitrateMbps in 2..30) { "Choose a bitrate between 2 and 30 Mbps" }
    val factory = nativeFactory()
    val epoch = generation
    val config = PeerConnection.RTCConfiguration(emptyList()).apply {
      sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
    }
    val pc = checkNotNull(factory.createPeerConnection(config, observer(epoch))) { "Could not create WebRTC sender" }
    peer = pc
    val source = factory.createVideoSource(true)
    this.source = source
    source.adaptOutputFormat(1920, 1080, 30)
    val track = factory.createVideoTrack("duodesk-test-video", source)
    this.track = track
    val transceiver = checkNotNull(pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("duodesk"))))
    val codecs = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
    val h264 = codecs.filter { it.name.equals("H264", true) }
    check(h264.isNotEmpty()) { "This Android device has no supported H.264 encoder" }
    transceiver.setCodecPreferences(h264 + codecs.filter { it.name.equals("rtx", true) }).throwError()
    val parameters = transceiver.sender.parameters
    parameters.encodings.forEach { it.maxBitrateBps = bitrateMbps * 1_000_000; it.maxFramerate = 30 }
    parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
    check(transceiver.sender.setParameters(parameters)) { "Could not configure video bitrate" }
    clip = ClipSource(context, checkNotNull(egl).eglBaseContext, source.capturerObserver) { message ->
      dispatch { if (epoch == generation) fail(message) }
    }
    status("connecting")
    armTimeout("Video negotiation timed out. Create a new desktop pairing code.")
    pc.createOffer(object : SdpCallbacks({ message -> dispatch { if (epoch == generation) fail(message) } }) {
      override fun onCreateSuccess(description: SessionDescription) = dispatch {
        if (peer !== pc) return@dispatch
        pc.setLocalDescription(object : SdpCallbacks({ message -> dispatch { if (epoch == generation) fail(message) } }) {
          override fun onSetSuccess() = dispatch {
            if (peer === pc) send(JSONObject().put("type", "offer").put("sdp", description.description))
          }
        }, description)
      }
    }, MediaConstraints())
  }

  private fun receive(text: String) {
    require(text.toByteArray().size <= 65_536) { "Signaling message is too large" }
    val message = JSONObject(text)
    check(message.getInt("v") == 1 && message.getString("sessionId") == invitation?.sessionId) { "Stale signaling session" }
    val keys = setOf("v", "sessionId", "type")
    val expected = when (message.getString("type")) {
      "paired", "stop" -> keys
      "answer" -> keys + "sdp"
      "candidate" -> keys + setOf("candidate", "sdpMid", "sdpMLineIndex")
      else -> error("Unexpected signaling message")
    }
    require(message.keys().asSequence().toSet() == expected) { "Invalid signaling fields" }
    when (message.getString("type")) {
      "paired" -> {
        check(state == "connecting" && peer == null) { "Unexpected pairing response" }
        timeout?.cancel(false); status("ready")
      }
      "answer" -> {
        val pc = checkNotNull(peer)
        check(!acceptingAnswer && pc.remoteDescription == null) { "Unexpected second answer" }
        val sdp = message.getString("sdp")
        require(sdp.isNotEmpty() && sdp.toByteArray().size <= 60_000) { "Invalid SDP" }
        acceptingAnswer = true
        val epoch = generation
        pc.setRemoteDescription(object : SdpCallbacks({ reason -> dispatch { if (generation == epoch) fail(reason) } }) {
          override fun onSetSuccess() = dispatch {
            if (peer !== pc) return@dispatch
            candidates.forEach { addCandidate(pc, it, epoch) }; candidates.clear()
            clip?.start(); startStats(pc)
          }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
      }
      "candidate" -> {
        val pc = checkNotNull(peer)
        val candidate = message.getString("candidate")
        val mid = if (message.isNull("sdpMid")) null else message.getString("sdpMid")
        val index = message.getInt("sdpMLineIndex")
        require(candidate.isNotEmpty() && candidate.toByteArray().size <= 8192 && (mid?.length ?: 0) <= 256 && index in 0..32) { "Invalid ICE candidate" }
        val ice = IceCandidate(mid, index, candidate)
        if (pc.remoteDescription != null) addCandidate(pc, ice, generation)
        else { check(candidates.size < 128) { "Too many pending candidates" }; candidates.add(ice) }
      }
      "stop" -> stop()
    }
  }

  private fun addCandidate(pc: PeerConnection, candidate: IceCandidate, epoch: Long) {
    pc.addIceCandidate(candidate, object : AddIceObserver {
      override fun onAddSuccess() {}
      override fun onAddFailure(error: String) = dispatch { if (generation == epoch) fail("Could not add ICE candidate") }
    })
  }
  private fun send(message: JSONObject) {
    val info = invitation ?: return
    message.put("v", 1).put("sessionId", info.sessionId)
    check(socket?.send(message.toString()) == true) { "Signaling socket is closed or busy" }
  }
  private fun startStats(pc: PeerConnection) {
    stats?.cancel(false)
    stats = queue.scheduleAtFixedRate({
      if (peer === pc) pc.getStats { report -> dispatch {
        if (peer !== pc) return@dispatch
        for (entry in report.statsMap.values.filter { it.type == "outbound-rtp" && it.members["kind"] == "video" }) {
          val values = entry.members
          val bytes = (values["bytesSent"] as? Number)?.toDouble() ?: 0.0
          val elapsed = report.timestampUs - previousTime
          val mbps = if (previousTime > 0 && elapsed > 0) maxOf(0.0, (bytes - previousBytes) * 8 / elapsed) else 0.0
          previousBytes = bytes; previousTime = report.timestampUs
          val codec = report.statsMap[values["codecId"]]?.members?.get("mimeType") ?: "H264"
          emit(mapOf("state" to state, "stats" to mapOf("codec" to codec, "mbps" to mbps,
            "fps" to (values["framesPerSecond"] ?: 0), "width" to (values["frameWidth"] ?: 0),
            "height" to (values["frameHeight"] ?: 0), "qualityLimit" to (values["qualityLimitationReason"] ?: "unknown"))))
        }
      } }
    }, 1, 1, TimeUnit.SECONDS)
  }
  private fun observer(epoch: Long) = object : PeerConnection.Observer {
    override fun onIceCandidate(candidate: IceCandidate) = dispatch {
      if (generation == epoch) runCatching { send(JSONObject().put("type", "candidate").put("candidate", candidate.sdp)
        .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL).put("sdpMLineIndex", candidate.sdpMLineIndex)) }.onFailure { fail("Could not send ICE candidate") }
    }
    override fun onIceConnectionChange(next: PeerConnection.IceConnectionState) = dispatch {
      if (generation != epoch) return@dispatch
      when (next) {
        PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> { timeout?.cancel(false); status("streaming") }
        PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.DISCONNECTED -> fail("Video connection lost. Create a new desktop pairing code.")
        else -> Unit
      }
    }
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
    override fun onAddStream(stream: MediaStream) {}
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: DataChannel) {}
    override fun onRenegotiationNeeded() {}
  }
  private fun close() {
    generation++
    timeout?.cancel(false); timeout = null; stats?.cancel(false); stats = null
    clip?.stop(); clip = null
    peer?.close(); peer?.dispose(); peer = null
    track?.dispose(); track = null; source?.dispose(); source = null
    socket?.cancel(); socket = null
    client?.dispatcher?.executorService?.shutdown(); client?.connectionPool?.evictAll(); client = null
    invitation = null; candidates.clear(); acceptingAnswer = false; previousBytes = 0.0; previousTime = 0.0
    state = "stopped"
  }
  fun stop() { close(); status("stopped") }

  companion object {
    private var initialized = false
    @Synchronized private fun initialize(context: Context) {
      if (!initialized) { PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()); initialized = true }
    }
  }
}

internal open class SdpCallbacks(private val failure: (String) -> Unit) : SdpObserver {
  override fun onCreateSuccess(description: SessionDescription) {}
  override fun onSetSuccess() {}
  override fun onCreateFailure(error: String) = failure("Could not create video offer: $error")
  override fun onSetFailure(error: String) = failure("Could not apply video description: $error")
}
