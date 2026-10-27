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
import org.json.JSONObject
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

internal class VideoSender(private val context: Context, private val emit: (Map<String, Any>) -> Unit) {
  @Volatile
  private var queueThread: Thread? = null
  private val queue = ScheduledThreadPoolExecutor(1, ThreadFactory { r ->
    Thread(r, "duodesk-video-sender").also { queueThread = it }
  }).apply { removeOnCancelPolicy = true }

  @Volatile
  private var generation = 0L
  /** Bumped only when the desktop link closes, so pausing video keeps the socket's callbacks alive. */
  @Volatile
  private var link = 0L
  private var invitation: Invitation? = null
  private var signaling: PinnedSignaling? = null
  private var peer: PeerConnection? = null
  private var source: VideoSource? = null
  private var track: VideoTrack? = null
  private var audioSource: AudioSource? = null
  private var audioTrack: AudioTrack? = null
  private var audioDevice: JavaAudioDeviceModule? = null
  private var factory: PeerConnectionFactory? = null
  private var clip: ClipSource? = null
  private var screen: ScreenSource? = null
  private var timeout: ScheduledFuture<*>? = null
  private var stats: ScheduledFuture<*>? = null
  private val candidates = mutableListOf<IceCandidate>()
  private var acceptingAnswer = false
  private var mediaStarted = false
  private var restarting = false
  private var negotiation = 0L
  private var pendingDescription = false
  private val recovery = ConnectionRecovery(
    schedule = recoveryScheduler(queue),
    changed = { next -> state = next; control?.revoke(); status(next) },
    exhausted = { fail("Connection could not be recovered. Pair again.", "unrecoverable") },
    restart = { restart() }
  )

  @Volatile
  private var state = "idle"
  @Volatile
  private var mode: String? = null
  @Volatile
  private var lastStats: Map<String, Any>? = null
  @Volatile
  private var lastError: String? = null
  @Volatile
  private var lastFailure: String? = null
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
  private var control: RemoteControl? = null
  private var controlChannel: DataChannel? = null
  private var inputChannel: DataChannel? = null
  private var heartbeat: ScheduledFuture<*>? = null
  private val serviceListener: () -> Unit = { dispatch { control?.serviceChanged() } }

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
    lastFailure?.let { map["failure"] = it }
    addSession(map)
    map.putAll(recovery.fields())
    return map
  }

  /** Adds what the phone UI needs about the screen session: audio, and the remote control grant. */
  private fun addSession(map: MutableMap<String, Any>) {
    if (mode != "screen") return
    map["audio"] = audioState
    audioMessage?.let { map["audioMessage"] = it }
    control?.snapshot()?.let { snap ->
      val entry = mutableMapOf<String, Any>("state" to if (snap.on) "on" else "off", "serviceEnabled" to snap.serviceEnabled)
      snap.reason?.let { entry["reason"] = it.wire }
      map["control"] = entry
    }
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

  init {
    ControlAccessibilityService.addListener(serviceListener)
  }

  fun destroy() = dispatch {
    ControlAccessibilityService.removeListener(serviceListener)
    close(); factory?.dispose(); factory = null
    audioDevice?.release(); audioDevice = null
    queue.shutdown()
  }

  private fun status(next: String) {
    if (state != next) Log.i("DuoDesk", "Sender state $state -> $next, mode=$mode, generation=$generation")
    state = next
    val map = mutableMapOf<String, Any>("state" to next)
    mode?.let { map["mode"] = it }
    addSession(map)
    map.putAll(recovery.fields())
    emit(map)
  }

  private fun fail(message: String, reason: String = "unrecoverable") {
    Log.w("DuoDesk", "Sender failed: $message, state=$state, mode=$mode, generation=$generation")
    lastError = message
    lastFailure = reason
    close()
    state = "disconnected"
    val map = mutableMapOf<String, Any>("state" to "disconnected", "message" to message, "failure" to reason)
    mode?.let { map["mode"] = it }
    emit(map)
  }

  private fun setAudio(next: String, message: String? = null) {
    audioState = next
    audioMessage = message
    val map = mutableMapOf<String, Any>("state" to state)
    mode?.let { map["mode"] = it }
    addSession(map)
    map.putAll(recovery.fields())
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
      addSession(map)
      emit(map)
    }
  }

  private fun armTimeout(message: String) {
    timeout?.cancel(false)
    val epoch = generation
    timeout = queue.schedule({ if (generation == epoch) fail(message) }, 20, TimeUnit.SECONDS)
  }

  fun connect(text: String) {
    close()
    lastError = null
    lastFailure = null
    val info = Invitation.parse(text)
    require(info.direction == Direction.PhoneToDesktop) { "This invitation is for viewing the desktop screen. Use the viewer instead." }
    invitation = info
    val linkEpoch = link
    status("connecting")
    armTimeout("Connection timed out. Check Wi-Fi and the desktop firewall.")
    signaling = PinnedSignaling(info, object : PinnedSignaling.Listener {
      override fun onMessage(text: String) = dispatch {
        if (link == linkEpoch) runCatching { receive(text) }.onFailure { fail(it.message ?: "Invalid signaling message") }
      }
      override fun onFailure(message: String) = dispatch {
        if (link == linkEpoch) fail("$message. Pair again; consumed invitations cannot reconnect.", "connection-lost")
      }
      override fun onClosed() = dispatch {
        if (link == linkEpoch) fail("Desktop connection closed. Pair again.", "connection-lost")
      }
    }).also { it.open() }
  }

  private fun nativeFactory(): PeerConnectionFactory {
    factory?.let { return it }
    val egl = WebRtcFactory.get(context).egl
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
    openControlChannels(pc, epoch, supported = mode == "screen")
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
    parameters.encodings.forEach { it.maxBitrateBps = bitrateMbps * 1_000_000; it.maxFramerate = 60 }
    parameters.degradationPreference = RtpParameters.DegradationPreference.BALANCED
    check(transceiver.sender.setParameters(parameters)) { "Could not configure video bitrate" }
    if (withAudio) addAudioTrack(factory, pc)
    return Pair(pc, epoch)
  }

  /**
   * Remote control channels exist in every session so the desktop can always tell the phone's state. The phone
   * owns the grant: control stays off until the owner allows it, and only a screen session can ever allow it.
   */
  private fun openControlChannels(pc: PeerConnection, epoch: Long, supported: Boolean) {
    val sessionId = checkNotNull(invitation).sessionId
    control = RemoteControl(
      sessionId = sessionId,
      supported = supported,
      injector = { ControlAccessibilityService.injector() },
      send = { text -> sendControl(text) },
      post = { block -> dispatch { if (generation == epoch) block() } },
      changed = {
        val on = control?.snapshot()?.on == true
        ScreenCaptureService.setControlActive(on)
        status(state)
      }
    )
    val reliable = DataChannel.Init().apply { ordered = true; negotiated = true; id = ControlWire.CONTROL_ID }
    val shortLived = DataChannel.Init().apply {
      ordered = true; negotiated = true; id = ControlWire.INPUT_ID
      maxRetransmitTimeMs = ControlWire.INPUT_PACKET_LIFETIME_MS
    }
    val controlLine = checkNotNull(pc.createDataChannel(ControlWire.CONTROL_LABEL, reliable)) { "Could not open the control channel" }
    val inputLine = checkNotNull(pc.createDataChannel(ControlWire.INPUT_LABEL, shortLived)) { "Could not open the input channel" }
    controlChannel = controlLine
    inputChannel = inputLine
    controlLine.registerObserver(object : DataChannel.Observer {
      override fun onBufferedAmountChange(previousAmount: Long) {}
      override fun onMessage(buffer: DataChannel.Buffer) {}
      override fun onStateChange() = dispatch {
        if (generation != epoch) return@dispatch
        when (controlLine.state()) {
          DataChannel.State.OPEN -> { control?.publish(); startHeartbeat(epoch) }
          DataChannel.State.CLOSING, DataChannel.State.CLOSED -> control?.revoke()
          else -> Unit
        }
      }
    })
    inputLine.registerObserver(object : DataChannel.Observer {
      override fun onBufferedAmountChange(previousAmount: Long) {}
      override fun onMessage(buffer: DataChannel.Buffer) {
        if (buffer.binary || buffer.data.remaining() > ControlWire.MAX_BYTES) return
        val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
        dispatch { if (generation == epoch) control?.onCommand(String(bytes, Charsets.UTF_8)) }
      }
      override fun onStateChange() = dispatch {
        if (generation != epoch) return@dispatch
        if (inputLine.state() == DataChannel.State.CLOSING || inputLine.state() == DataChannel.State.CLOSED) control?.revoke()
      }
    })
  }

  private fun startHeartbeat(epoch: Long) {
    heartbeat?.cancel(false)
    heartbeat = queue.scheduleAtFixedRate({
      if (generation == epoch) runCatching { control?.publish() }
    }, ControlWire.HEARTBEAT_MS, ControlWire.HEARTBEAT_MS, TimeUnit.MILLISECONDS)
  }

  private fun sendControl(text: String): Boolean {
    val channel = controlChannel ?: return false
    if (channel.state() != DataChannel.State.OPEN || channel.bufferedAmount() > 65_536) return false
    return channel.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
  }

  /** Runs a control action from the phone UI. A refusal rejects the promise but never ends the session. */
  fun controlAction(promise: Promise, action: RemoteControl.() -> String?) {
    dispatch {
      val current = control
      val problem = if (current == null || mode != "screen" || state != "streaming") "Start sharing your screen first." else current.action()
      if (problem == null) promise.resolve() else promise.reject("ERR_CONTROL", problem, null)
    }
  }

  fun revokeControl() = dispatch { control?.revoke() }
  private fun debugEmulator(): Boolean =
    (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
      (Build.HARDWARE in setOf("ranchu", "goldfish") || Build.FINGERPRINT.startsWith("generic"))

  fun reconnect() = recovery.reconnect()

  private fun restart() {
    val pc = peer ?: return
    if (pc.signalingState() != PeerConnection.SignalingState.STABLE) {
      fail("The desktop did not answer recovery. Pair again and update both apps if needed.")
      return
    }
    restarting = true
    acceptingAnswer = false
    candidates.clear()
    sendOffer(pc, generation)
  }

  private fun flushDescription() {
    val pc = peer ?: return
    if (!pendingDescription || pc.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return
    pendingDescription = false
    send(JSONObject().put("type", "offer").put("sdp", pc.localDescription.description))
  }

  private fun sendOffer(pc: PeerConnection, epoch: Long) {
    val round = ++negotiation
    if (!restarting) {
      status("connecting")
      armTimeout("Video negotiation timed out. Check Wi-Fi and firewall, then pair again.")
    }
    pc.createOffer(object : SdpCallbacks({ message -> dispatch { if (epoch == generation && round == negotiation) fail(message) } }) {
      override fun onCreateSuccess(description: SessionDescription) = dispatch {
        if (peer !== pc || round != negotiation) return@dispatch
        pc.setLocalDescription(object : SdpCallbacks({ message -> dispatch { if (epoch == generation && round == negotiation) fail(message) } }) {
          override fun onSetSuccess() = dispatch {
            if (peer === pc && round == negotiation) {
              if (restarting) { pendingDescription = true; flushDescription() }
              else send(JSONObject().put("type", "offer").put("sdp", description.description))
            }
          }
        }, description)
      }
    }, MediaConstraints().apply {
      if (restarting) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
    })
  }

  fun start(bitrateMbps: Int) {
    mode = "clip"
    val (pc, epoch) = initPeerConnection(bitrateMbps)
    val src = checkNotNull(source)
    src.adaptOutputFormat(1920, 1080, 30)
    clip = ClipSource(context, WebRtcFactory.get(context).egl.eglBaseContext, src.capturerObserver) { message ->
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
      eglContext = WebRtcFactory.get(context).egl.eglBaseContext,
      observer = src.capturerObserver,
      resultData = resultData,
      queue = queue,
      onResize = { w, h ->
        dispatch {
          if (epoch == generation) {
            src.adaptOutputFormat(w, h, 60)
          }
        }
      },
      onGeometry = { geometry -> dispatch { if (epoch == generation) control?.setGeometry(geometry) } },
      onFailure = { message ->
        dispatch {
          if (epoch == generation) {
            fail(message, "permission-revoked")
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
    val direction = checkNotNull(invitation).direction
    val expected = SignalRoutes.desktopFields(direction, message.getString("type"))
    require(message.keys().asSequence().toSet() == expected) { "Invalid signaling fields" }
    when (message.getString("type")) {
      "paired" -> {
        check(state == "connecting" && peer == null) { "Unexpected pairing response" }
        timeout?.cancel(false); status("ready")
      }
      "answer" -> {
        val pc = checkNotNull(peer)
        check(!acceptingAnswer && (pc.remoteDescription == null || restarting) && pc.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) { "Unexpected second answer" }
        val sdp = message.getString("sdp")
        require(sdp.isNotEmpty() && sdp.toByteArray().size <= 60_000) { "Invalid SDP" }
        acceptingAnswer = true
        val epoch = generation
        pc.setRemoteDescription(object : SdpCallbacks({ reason -> dispatch { if (generation == epoch) fail(reason) } }) {
          override fun onSetSuccess() = dispatch {
            if (peer !== pc) return@dispatch
            candidates.forEach { addCandidate(pc, it, epoch) }; candidates.clear()
            if (!mediaStarted) {
              mediaStarted = true
              if (mode == "screen") { screen?.start(); startPlaybackAudio() }
              else clip?.start()
            }
            startStats(pc)
            connectionReady()
          }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
      }
      "candidate" -> {
        if (restarting) return
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
    val signaling = signaling ?: return
    check(signaling.send(message)) { "Signaling socket is closed or busy" }
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
          addSession(map)
          map.putAll(recovery.fields())
          emit(map)
        }
      } }
    }, 1, 1, TimeUnit.SECONDS)
  }

  private fun connectionReady() {
    val pc = peer ?: return
    if (pc.signalingState() != PeerConnection.SignalingState.STABLE || !acceptingAnswer || pendingDescription) return
    if (pc.iceConnectionState() == PeerConnection.IceConnectionState.CONNECTED || pc.iceConnectionState() == PeerConnection.IceConnectionState.COMPLETED) {
      timeout?.cancel(false); recovery.connected(); status("streaming")
    }
  }

  private fun observer(epoch: Long) = object : PeerConnection.Observer {
    override fun onIceCandidate(candidate: IceCandidate) = dispatch {
      if (generation == epoch && !restarting) runCatching { send(JSONObject().put("type", "candidate").put("candidate", candidate.sdp)
        .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL).put("sdpMLineIndex", candidate.sdpMLineIndex)) }.onFailure { fail("Could not send ICE candidate") }
    }
    override fun onIceConnectionChange(next: PeerConnection.IceConnectionState) = dispatch {
      if (generation != epoch) return@dispatch
      when (next) {
        PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> connectionReady()
        PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.DISCONNECTED -> recovery.interrupt()
        else -> Unit
      }
    }
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = dispatch { if (generation == epoch) flushDescription() }
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
    override fun onAddStream(stream: MediaStream) {}
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: DataChannel) {}
    override fun onRenegotiationNeeded() {}
  }

  /** Tears down capture and the peer but keeps the desktop link open. */
  private fun closeVideo() {
    generation++
    negotiation++
    recovery.connected()
    pendingDescription = false
    restarting = false
    mediaStarted = false
    timeout?.cancel(false); timeout = null; stats?.cancel(false); stats = null
    // Remote control ends first, before capture or the connection go away.
    heartbeat?.cancel(false); heartbeat = null
    control?.close(); control = null
    ScreenCaptureService.setControlActive(false)
    for (channel in listOf(controlChannel, inputChannel)) {
      channel?.unregisterObserver(); channel?.close(); channel?.dispose()
    }
    controlChannel = null; inputChannel = null
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
    closeVideo()
    link++
    signaling?.close(); signaling = null
    invitation = null
    state = "stopped"
  }

  /** Ends the video only; the desktop stays paired and a new start needs no new invitation. */
  fun pause() {
    Log.i("DuoDesk", "Owner paused streaming, state=$state, mode=$mode")
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
}

internal open class SdpCallbacks(private val failure: (String) -> Unit) : SdpObserver {
  override fun onCreateSuccess(description: SessionDescription) {}
  override fun onSetSuccess() {}
  override fun onCreateFailure(error: String) = failure("Could not create video description: $error")
  override fun onSetFailure(error: String) = failure("Could not apply video description: $error")
}
