package expo.modules.testvideo

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.Promise
import org.json.JSONObject
import org.webrtc.*
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
  private var invitation: Invitation? = null
  private var signaling: PinnedSignaling? = null
  private var peer: PeerConnection? = null
  private var source: VideoSource? = null
  private var track: VideoTrack? = null
  private var clip: ClipSource? = null
  private var screen: ScreenSource? = null
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

  private var previousBytes = 0.0
  private var previousTime = 0.0

  fun isReady(): Boolean = (state == "ready")
  fun currentGeneration(): Long = generation
  fun getMode(): String? = mode

  fun getStatus(): Map<String, Any> {
    val map = mutableMapOf<String, Any>("state" to state)
    mode?.let { map["mode"] = it }
    lastStats?.let { map["stats"] = it }
    lastError?.let { map["message"] = it }
    return map
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
    close(); queue.shutdown()
  }

  private fun status(next: String) {
    state = next
    val map = mutableMapOf<String, Any>("state" to next)
    mode?.let { map["mode"] = it }
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

  fun onPermissionDenied(message: String) {
    dispatch {
      lastError = message
      val map = mutableMapOf<String, Any>("state" to state, "message" to message)
      mode?.let { map["mode"] = it }
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
    val info = Invitation.parse(text)
    require(info.direction == Direction.PhoneToDesktop) { "This invitation is for viewing the desktop screen. Use the viewer instead." }
    invitation = info
    val epoch = generation
    status("connecting")
    armTimeout("Connection timed out. Check Wi-Fi and the desktop firewall.")
    signaling = PinnedSignaling(info, object : PinnedSignaling.Listener {
      override fun onMessage(text: String) = dispatch {
        if (generation == epoch) runCatching { receive(text) }.onFailure { fail(it.message ?: "Invalid signaling message") }
      }
      override fun onFailure(message: String) = dispatch {
        if (generation == epoch) fail(message)
      }
      override fun onClosed() = dispatch {
        if (generation == epoch) stop()
      }
    }).also { it.open() }
  }

  private fun initPeerConnection(bitrateMbps: Int): Pair<PeerConnection, Long> {
    check(state == "ready") { "Connect to the desktop before starting" }
    require(bitrateMbps in 2..30) { "Choose a bitrate between 2 and 30 Mbps" }
    val factory = WebRtcFactory.get(context).factory
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
    check(h264.isNotEmpty()) { "This Android device has no supported H.264 encoder" }
    transceiver.setCodecPreferences(h264 + codecs.filter { it.name.equals("rtx", true) }).throwError()
    val parameters = transceiver.sender.parameters
    parameters.encodings.forEach { it.maxBitrateBps = bitrateMbps * 1_000_000; it.maxFramerate = 30 }
    parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
    check(transceiver.sender.setParameters(parameters)) { "Could not configure video bitrate" }
    return Pair(pc, epoch)
  }

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
    clip = ClipSource(context, WebRtcFactory.get(context).egl.eglBaseContext, src.capturerObserver) { message ->
      dispatch { if (epoch == generation) fail(message) }
    }
    sendOffer(pc, epoch)
  }

  fun submitScreen(
    bitrateMbps: Int,
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
        startScreen(bitrateMbps, resultData, serviceSession)
        onStarted()
      } catch (error: Exception) {
        fail(error.message ?: "Streaming failed")
        onError(error)
      }
    }
  }

  fun startScreen(bitrateMbps: Int, resultData: Intent, serviceSession: Long = 0L) {
    mode = "screen"
    this.serviceSessionId = serviceSession
    val (pc, epoch) = initPeerConnection(bitrateMbps)
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
    val signaling = signaling ?: return
    check(signaling.send(message)) { "Signaling socket is closed or busy" }
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
          val currentStats = mapOf(
            "codec" to codec,
            "mbps" to mbps,
            "fps" to (values["framesPerSecond"] ?: 0),
            "width" to (values["frameWidth"] ?: 0),
            "height" to (values["frameHeight"] ?: 0),
            "qualityLimit" to (values["qualityLimitationReason"] ?: "unknown")
          )
          lastStats = currentStats
          val map = mutableMapOf<String, Any>(
            "state" to state,
            "stats" to currentStats
          )
          mode?.let { map["mode"] = it }
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

  private fun close() {
    generation++
    timeout?.cancel(false); timeout = null; stats?.cancel(false); stats = null
    clip?.stop(); clip = null
    val wasScreen = (mode == "screen" || screen != null)
    screen?.stop(); screen = null
    if (wasScreen) {
      ScreenCaptureService.stop(context, serviceSessionId)
    }
    peer?.close(); peer?.dispose(); peer = null
    track?.dispose(); track = null; source?.dispose(); source = null
    signaling?.close(); signaling = null
    invitation = null; candidates.clear(); acceptingAnswer = false; previousBytes = 0.0; previousTime = 0.0
    mode = null
    state = "stopped"
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
