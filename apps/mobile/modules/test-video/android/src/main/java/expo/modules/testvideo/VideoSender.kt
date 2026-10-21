package expo.modules.testvideo

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.Manifest
import android.media.AudioFormat
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import okhttp3.*
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
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
  @Volatile
  private var queueThread: Thread? = null
  private val queue = ScheduledThreadPoolExecutor(1, ThreadFactory { r ->
    Thread(r, "duodesk-video-sender").also { queueThread = it }
  }).apply { removeOnCancelPolicy = true }

  @Volatile
  private var generation = 0L
  private sealed class Enrollment(open val promise: Promise) {
    data class AwaitPair(val name: String, override val promise: Promise) : Enrollment(promise)
    data class AwaitApproval(val key: EnrollmentKey, override val promise: Promise) : Enrollment(promise)
  }
  private var enrollment: Enrollment? = null
  private var enrollmentTimeout: ScheduledFuture<*>? = null
  private fun trustStore() = TrustedDesktopStore.get(context)

  /** Bumped only when the desktop link closes, so pausing video keeps the socket's callbacks alive. */
  @Volatile
  private var link = 0L
  private var invitation: Invitation? = null
  private var socket: WebSocket? = null
  private var client: OkHttpClient? = null
  private var peer: PeerConnection? = null
  private var source: VideoSource? = null
  private var track: VideoTrack? = null
  private var audioSource: AudioSource? = null
  private var audioTrack: AudioTrack? = null
  private var audioDevice: JavaAudioDeviceModule? = null
  private var clip: ClipSource? = null
  private var screen: ScreenSource? = null
  private var egl: EglBase? = null
  private var factory: PeerConnectionFactory? = null
  private var timeout: ScheduledFuture<*>? = null
  private var stats: ScheduledFuture<*>? = null
  private val candidates = mutableListOf<IceCandidate>()
  private var acceptingAnswer = false

  @Volatile
  private var state = "idle"
  @Volatile
  private var mode: String? = null
  @Volatile
  private var lastStats: Map<String, Any>? = null
  @Volatile
  private var lastError: String? = null
  @Volatile
  private var serviceSessionId: Long = 0L
  @Volatile
  private var audioState = AudioStatus.OFF
  @Volatile
  private var audioMessage: String? = null
  /** Read on the WebRTC audio thread, written on the sender queue. */
  @Volatile
  private var playbackAudio: PlaybackAudioCapture? = null
  private val silence = SilencePacer()

  private var previousBytes = 0.0
  private var previousTime = 0.0
  private var previousAudioBytes = 0.0
  private var previousAudioTime = 0.0

  fun isReady(): Boolean = (state == "ready")
  fun currentGeneration(): Long = generation
  fun getMode(): String? = mode

  fun getStatus(): Map<String, Any> {
    val map = mutableMapOf<String, Any>("state" to state)
    mode?.let { map["mode"] = it }
    lastStats?.let { map["stats"] = it }
    lastError?.let { map["message"] = it }
    addAudio(map)
    return map
  }

  private fun addAudio(map: MutableMap<String, Any>) {
    if (mode != "screen") return
    map["audio"] = audioState
    audioMessage?.let { map["audioMessage"] = it }
  }

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

  fun background() = dispatch {
    if (mode == "screen") {
      return@dispatch
    }
    stop()
  }

  fun destroy() = dispatch {
    close(); factory?.dispose(); factory = null
    audioDevice?.release(); audioDevice = null
    egl?.release(); egl = null; queue.shutdown()
  }

  private fun status(next: String) {
    state = next
    val map = mutableMapOf<String, Any>("state" to next)
    mode?.let { map["mode"] = it }
    addAudio(map)
    emit(map)
  }

  private fun fail(message: String) {
    lastError = message
    close()
    state = "failed"
    val map = mutableMapOf<String, Any>("state" to "failed", "message" to message)
    mode?.let { map["mode"] = it }
    emit(map)
  }

  private fun setAudio(next: String, message: String? = null) {
    audioState = next
    audioMessage = message
    val map = mutableMapOf<String, Any>("state" to state)
    mode?.let { map["mode"] = it }
    addAudio(map)
    emit(map)
  }

  /** Playback capture broke after negotiation. The track stays in the SDP, so the PC hears silence; video continues. */
  private fun audioFailed(message: String) {
    playbackAudio?.stop(); playbackAudio = null
    setAudio(AudioStatus.FAILED, message)
  }

  fun onPermissionDenied(message: String) {
    dispatch {
      lastError = message
      val map = mutableMapOf<String, Any>("state" to state, "message" to message)
      mode?.let { map["mode"] = it }
      addAudio(map)
      emit(map)
    }
  }

  private fun armTimeout(message: String) {
    timeout?.cancel(false)
    val epoch = generation
    timeout = queue.schedule({ if (generation == epoch) fail(message) }, 20, TimeUnit.SECONDS)
  }

  fun connectAndRemember(text: String, name: String, promise: Promise) = dispatch {
    try {
      require(name.toByteArray(Charsets.UTF_8).size in 1..80) { "Phone name must be 1 to 80 UTF-8 bytes" }
      trustStore()
      connect(text)
      enrollment = Enrollment.AwaitPair(name, promise)
      val linkEpoch = link
      enrollmentTimeout = queue.schedule({
        if (link == linkEpoch) rejectEnrollment("Desktop approval timed out. This desktop was not remembered. Try pairing again.")
      }, 125, TimeUnit.SECONDS)
    } catch (error: Exception) {
      fail(error.message ?: "Could not remember the desktop")
      promise.reject("ERR_TRUST_ENROLL", error.message, error)
    }
  }

  private fun rejectEnrollment(message: String) {
    val pending = enrollment ?: return
    enrollment = null
    enrollmentTimeout?.cancel(false); enrollmentTimeout = null
    if (pending is Enrollment.AwaitApproval) runCatching { trustStore().discard(pending.key) }
    pending.promise.reject("ERR_TRUST_ENROLL", message, null)
  }

  private fun enrollAfterPair() {
    val pending = enrollment as? Enrollment.AwaitPair ?: return
    try {
      val key = trustStore().prepare(checkNotNull(invitation).fingerprint)
      enrollment = Enrollment.AwaitApproval(key, pending.promise)
      send(JSONObject().put("type", "trust_enroll").put("phoneId", key.phoneId)
        .put("name", pending.name).put("publicKey", key.publicKey))
    } catch (error: Exception) {
      rejectEnrollment(error.message ?: "Secure enrollment failed. This desktop was not remembered.")
    }
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
    val client = OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
      .hostnameVerifier { host, _ -> host == URI(info.url).host }
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS)).pingInterval(10, TimeUnit.SECONDS)
      .connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    this.client = client
    val linkEpoch = link
    status("connecting")
    armTimeout("Connection timed out. Check Wi-Fi and the desktop firewall.")
    socket = client.newWebSocket(Request.Builder().url(info.url).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) = dispatch {
        if (link == linkEpoch) send(JSONObject().put("type", "pair").put("token", info.token))
      }
      override fun onMessage(webSocket: WebSocket, text: String) = dispatch {
        if (link == linkEpoch) runCatching { receive(text) }.onFailure { fail(it.message ?: "Invalid signaling message") }
      }
      override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) = dispatch {
        if (link == linkEpoch) fail("Unexpected binary signaling message")
      }
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dispatch {
        if (link == linkEpoch) fail("Receiver connection failed: ${t.message}")
      }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = dispatch {
        if (link == linkEpoch) stop()
      }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dispatch {
        if (link == linkEpoch) stop()
      }
    })
  }

  private fun nativeFactory(): PeerConnectionFactory {
    factory?.let { return it }
    initialize(context)
    val egl = EglBase.create()
    this.egl = egl
    // Recordingless mode: the module never creates a microphone AudioRecord. It asks onAudioBuffer for
    // every 10 ms buffer, and that callback supplies captured playback audio or paced silence.
    val adm = JavaAudioDeviceModule.builder(context)
      .setInputSampleRate(PLAYBACK_SAMPLE_RATE)
      .setUseStereoInput(true)
      .setUseHardwareAcousticEchoCanceler(false)
      .setUseHardwareNoiseSuppressor(false)
      .setAudioBufferCallback { buffer, format, channels, rate, _, _ -> onAudioBuffer(buffer, format, channels, rate) }
      .createAudioDeviceModule()
    adm.setAudioRecordEnabled(false)
    audioDevice = adm
    return PeerConnectionFactory.builder()
      .setAudioDeviceModule(adm)
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext)).createPeerConnectionFactory().also { factory = it }
  }

  private fun onAudioBuffer(buffer: ByteBuffer, format: Int, channels: Int, rate: Int): Long {
    val capture = playbackAudio
    if (capture != null && format == AudioFormat.ENCODING_PCM_16BIT && channels == PLAYBACK_CHANNELS && rate == PLAYBACK_SAMPLE_RATE) {
      val capturedAt = capture.readInto(buffer, buffer.capacity())
      if (capturedAt >= 0) { silence.reset(); return capturedAt }
    }
    return silence.fill(buffer, buffer.capacity(), rate, channels * 2)
  }

  /** Adds a send-only Opus track in the same stream as the video so the PC keeps them lip-synced. */
  private fun addAudioTrack(factory: PeerConnectionFactory, pc: PeerConnection) {
    // Captured app audio is already final: echo cancellation, noise suppression and gain control would damage it.
    val constraints = MediaConstraints().apply {
      listOf("googEchoCancellation", "googNoiseSuppression", "googAutoGainControl", "googHighpassFilter")
        .forEach { mandatory.add(MediaConstraints.KeyValuePair(it, "false")) }
    }
    val source = factory.createAudioSource(constraints)
    audioSource = source
    val track = factory.createAudioTrack("duodesk-playback-audio", source)
    audioTrack = track
    val transceiver = checkNotNull(pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("duodesk"))))
    val opus = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO).codecs.filter { it.name.equals("opus", true) }
    check(opus.isNotEmpty()) { "This device's WebRTC build has no Opus encoder" }
    transceiver.setCodecPreferences(opus).throwError()
    val parameters = transceiver.sender.parameters
    parameters.encodings.forEach { it.maxBitrateBps = 128_000 }
    check(transceiver.sender.setParameters(parameters)) { "Could not configure audio bitrate" }
  }

  private fun initPeerConnection(bitrateMbps: Int, withAudio: Boolean = false): Pair<PeerConnection, Long> {
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
    val track = factory.createVideoTrack("duodesk-test-video", source)
    this.track = track
    val transceiver = checkNotNull(pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("duodesk"))))
    val codecs = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
    val h264 = codecs.filter { it.name.equals("H264", true) }
    // Emulators have no H.264 encoder; debug builds there fall back to software VP8 for UI testing.
    val video = h264.ifEmpty { if (debugEmulator()) codecs.filter { it.name.equals("VP8", true) } else h264 }
    check(video.isNotEmpty()) { "This Android device has no supported H.264 encoder" }
    transceiver.setCodecPreferences(video + codecs.filter { it.name.equals("rtx", true) }).throwError()
    val parameters = transceiver.sender.parameters
    parameters.encodings.forEach { it.maxBitrateBps = bitrateMbps * 1_000_000; it.maxFramerate = 30 }
    parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
    check(transceiver.sender.setParameters(parameters)) { "Could not configure video bitrate" }
    if (withAudio) addAudioTrack(factory, pc)
    return Pair(pc, epoch)
  }

  private fun debugEmulator(): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
      (Build.HARDWARE in setOf("ranchu", "goldfish") || Build.FINGERPRINT.startsWith("generic"))

  private fun sendOffer(pc: PeerConnection, epoch: Long) {
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

  fun start(bitrateMbps: Int) {
    mode = "clip"
    val (pc, epoch) = initPeerConnection(bitrateMbps)
    val src = checkNotNull(source)
    src.adaptOutputFormat(1920, 1080, 30)
    clip = ClipSource(context, checkNotNull(egl).eglBaseContext, src.capturerObserver) { message ->
      dispatch { if (epoch == generation) fail(message) }
    }
    sendOffer(pc, epoch)
  }

  fun submitScreen(
    bitrateMbps: Int,
    shareAudio: Boolean,
    resultData: Intent,
    serviceSession: Long,
    onStarted: () -> Unit,
    onError: (Throwable) -> Unit
  ) {
    dispatch {
      try {
        this.serviceSessionId = serviceSession
        if (generation != serviceSession) {
          ScreenCaptureService.stop(context, serviceSession)
          onError(IllegalStateException("Session changed before screen capture started"))
          return@dispatch
        }
        startScreen(bitrateMbps, shareAudio, resultData, serviceSession)
        onStarted()
      } catch (error: Exception) {
        fail(error.message ?: "Streaming failed")
        onError(error)
      }
    }
  }

  fun startScreen(bitrateMbps: Int, shareAudio: Boolean, resultData: Intent, serviceSession: Long = 0L) {
    mode = "screen"
    this.serviceSessionId = serviceSession
    val permitted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val blocked = audioBlockedStatus(shareAudio, Build.VERSION.SDK_INT, permitted)
    audioMessage = when (blocked) {
      AudioStatus.DENIED -> "Audio permission is off, so only video is shared. Allow it in Android settings to share sound."
      AudioStatus.UNSUPPORTED -> "Sharing sound needs Android 10 or newer. Only video is shared."
      else -> null
    }
    audioState = blocked ?: AudioStatus.STARTING
    val (pc, epoch) = initPeerConnection(bitrateMbps, withAudio = blocked == null)
    val src = checkNotNull(source)
    screen = ScreenSource(
      context = context,
      eglContext = checkNotNull(egl).eglBaseContext,
      observer = src.capturerObserver,
      resultData = resultData,
      queue = queue,
      onResize = { w, h ->
        dispatch {
          if (epoch == generation) {
            src.adaptOutputFormat(w, h, 30)
          }
        }
      },
      onFailure = { message ->
        dispatch {
          if (epoch == generation) {
            fail(message)
          }
        }
      }
    )
    sendOffer(pc, epoch)
  }

  /** Called right after screen capture starts, because the audio capture reuses the screen projection. */
  private fun startPlaybackAudio() {
    if (audioTrack == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val epoch = generation
    try {
      val projection = checkNotNull(screen?.projection) { "Screen capture is not ready for audio" }
      playbackAudio = PlaybackAudioCapture(projection) { message -> dispatch { if (generation == epoch) audioFailed(message) } }
      setAudio(AudioStatus.ACTIVE)
    } catch (error: Exception) {
      Log.w("DuoDesk", "Playback audio capture unavailable", error)
      audioFailed("Couldn't capture phone audio (${error.message ?: "unknown error"}). Video continues without sound.")
    }
  }

  private fun receive(text: String) {
    require(text.toByteArray().size <= 65_536) { "Signaling message is too large" }
    val message = JSONObject(text)
    check(message.getInt("v") == 1 && message.getString("sessionId") == invitation?.sessionId) { "Stale signaling session" }
    val keys = setOf("v", "sessionId", "type")
    val expected = when (message.getString("type")) {
      "paired", "stop" -> keys
      "trust_committed" -> keys + setOf("phoneId", "fingerprint", "address")
      "trust_rejected" -> keys + setOf("phoneId", "reason")
      "answer" -> keys + "sdp"
      "candidate" -> keys + setOf("candidate", "sdpMid", "sdpMLineIndex")
      else -> error("Unexpected signaling message")
    }
    require(message.keys().asSequence().toSet() == expected) { "Invalid signaling fields" }
    when (message.getString("type")) {
      "paired" -> {
        check(state == "connecting" && peer == null) { "Unexpected pairing response" }
        timeout?.cancel(false); status("ready")
        enrollAfterPair()
      }
      "trust_committed" -> {
        val pending = checkNotNull(enrollment as? Enrollment.AwaitApproval) { "Unexpected enrollment acknowledgement" }
        require(message.getString("phoneId") == pending.key.phoneId && message.getString("fingerprint") == pending.key.fingerprint && invitation?.fingerprint == pending.key.fingerprint) { "Enrollment identity mismatch" }
        try {
          trustStore().commit(pending.key, message.getString("address"))
          enrollment = null
          enrollmentTimeout?.cancel(false); enrollmentTimeout = null
          pending.promise.resolve()
        } catch (error: Exception) {
          rejectEnrollment("Desktop approval arrived, but secure saving failed. This desktop was not remembered. ${error.message ?: ""}")
        }
      }
      "trust_rejected" -> {
        val pending = checkNotNull(enrollment as? Enrollment.AwaitApproval) { "Unexpected enrollment rejection" }
        require(message.getString("phoneId") == pending.key.phoneId)
        val reason = message.getString("reason")
        require(reason.toByteArray(Charsets.UTF_8).size <= 1024)
        rejectEnrollment("The desktop did not approve remembering this phone. $reason")
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
            if (mode == "screen") {
              screen?.start()
              startPlaybackAudio()
            } else {
              clip?.start()
            }
            startStats(pc)
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
        val audioEntry = report.statsMap.values.firstOrNull { it.type == "outbound-rtp" && it.members["kind"] == "audio" }
        val audioKbps = audioEntry?.let { entry ->
          val bytes = (entry.members["bytesSent"] as? Number)?.toDouble() ?: 0.0
          val elapsed = report.timestampUs - previousAudioTime
          val kbps = if (previousAudioTime > 0 && elapsed > 0) maxOf(0.0, (bytes - previousAudioBytes) * 8 * 1000 / elapsed) else 0.0
          previousAudioBytes = bytes; previousAudioTime = report.timestampUs
          kbps
        }
        for (entry in report.statsMap.values.filter { it.type == "outbound-rtp" && it.members["kind"] == "video" }) {
          val values = entry.members
          val bytes = (values["bytesSent"] as? Number)?.toDouble() ?: 0.0
          val elapsed = report.timestampUs - previousTime
          val mbps = if (previousTime > 0 && elapsed > 0) maxOf(0.0, (bytes - previousBytes) * 8 / elapsed) else 0.0
          previousBytes = bytes; previousTime = report.timestampUs
          val codec = report.statsMap[values["codecId"]]?.members?.get("mimeType") ?: "H264"
          val currentStats = mutableMapOf<String, Any>(
            "codec" to codec,
            "mbps" to mbps,
            "fps" to (values["framesPerSecond"] ?: 0),
            "width" to (values["frameWidth"] ?: 0),
            "height" to (values["frameHeight"] ?: 0),
            "qualityLimit" to (values["qualityLimitationReason"] ?: "unknown")
          )
          audioKbps?.let { currentStats["audioKbps"] = it }
          lastStats = currentStats
          val map = mutableMapOf<String, Any>(
            "state" to state,
            "stats" to currentStats
          )
          mode?.let { map["mode"] = it }
          addAudio(map)
          emit(map)
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

  /** Tears down capture and the peer but keeps the desktop link open. */
  private fun closeVideo() {
    generation++
    timeout?.cancel(false); timeout = null; stats?.cancel(false); stats = null
    clip?.stop(); clip = null
    // Audio goes first: it borrows the screen projection, and the ADM thread may be blocked reading it.
    playbackAudio?.stop(); playbackAudio = null
    val wasScreen = (mode == "screen" || screen != null)
    screen?.stop(); screen = null
    if (wasScreen) {
      ScreenCaptureService.stop(context, serviceSessionId)
    }
    peer?.close(); peer?.dispose(); peer = null
    track?.dispose(); track = null; source?.dispose(); source = null
    audioTrack?.dispose(); audioTrack = null; audioSource?.dispose(); audioSource = null
    audioState = AudioStatus.OFF; audioMessage = null; silence.reset()
    previousAudioBytes = 0.0; previousAudioTime = 0.0
    candidates.clear(); acceptingAnswer = false; previousBytes = 0.0; previousTime = 0.0
    mode = null
  }

  private fun close() {
    rejectEnrollment("Connection ended before saving was confirmed. This desktop was not remembered. Pair again to retry.")
    closeVideo()
    link++
    runCatching { send(JSONObject().put("type", "stop")) }
    socket?.cancel(); socket = null
    client?.dispatcher?.executorService?.shutdown(); client?.connectionPool?.evictAll(); client = null
    invitation = null
    state = "stopped"
  }

  /** Ends the video only; the desktop stays paired and a new start needs no new invitation. */
  fun pause() {
    if (peer == null) return
    closeVideo()
    runCatching { send(JSONObject().put("type", "pause")) }.onFailure { return fail("Desktop connection lost") }
    lastStats = null
    status("ready")
  }

  fun stop(promise: Promise? = null) {
    if (Thread.currentThread() === queueThread) {
      close()
      status("stopped")
      promise?.resolve()
    } else {
      if (queue.isShutdown) {
        promise?.resolve()
        return
      }
      dispatch {
        close()
        status("stopped")
        promise?.resolve()
      }
    }
  }

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
