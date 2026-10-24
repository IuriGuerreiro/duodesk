package expo.modules.testvideo

import android.content.Context
import expo.modules.kotlin.Promise
import org.json.JSONObject
import org.webrtc.*
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

/** Watches the desktop's screen. The desktop offers, this answers, and the track renders into an attached view. */
internal class StreamViewer(private val context: Context, private val emit: (Map<String, Any>) -> Unit) {
  @Volatile
  private var queueThread: Thread? = null
  private val queue = ScheduledThreadPoolExecutor(1, ThreadFactory { r ->
    Thread(r, "duodesk-stream-viewer").also { queueThread = it }
  }).apply { removeOnCancelPolicy = true }

  @Volatile
  private var generation = 0L
  private var invitation: Invitation? = null
  private var signaling: PinnedSignaling? = null
  private var peer: PeerConnection? = null
  private var track: VideoTrack? = null
  private var renderer: VideoSink? = null
  private var timeout: ScheduledFuture<*>? = null
  private var stats: ScheduledFuture<*>? = null
  private val candidates = mutableListOf<IceCandidate>()
  private var previousBytes = 0.0
  private var previousTime = 0.0

  @Volatile
  private var state = "idle"
  @Volatile
  private var lastStats: Map<String, Any>? = null
  @Volatile
  private var lastError: String? = null

  fun getStatus(): Map<String, Any> {
    val map = mutableMapOf<String, Any>("state" to state)
    lastStats?.let { map["stats"] = it }
    lastError?.let { map["message"] = it }
    return map
  }

  private fun dispatch(action: () -> Unit) {
    if (!queue.isShutdown) runCatching {
      queue.execute { try { action() } catch (error: Exception) { fail(error.message ?: "Viewing failed") } }
    }
  }

  fun submit(promise: Promise, action: StreamViewer.() -> Unit) {
    dispatch {
      try { action(); promise.resolve() }
      catch (error: Exception) { fail(error.message ?: "Viewing failed"); promise.reject("ERR_STREAM", error.message, error) }
    }
  }

  /** Where the remote video draws. The view owns the sink and detaches it before it is released. */
  fun attach(sink: VideoSink) = dispatch {
    renderer = sink
    track?.addSink(sink)
  }

  fun detach(sink: VideoSink) = dispatch {
    if (renderer === sink) { track?.removeSink(sink); renderer = null }
  }

  private fun status(next: String) {
    state = next
    emit(mapOf("state" to next))
  }

  private fun fail(message: String) {
    lastError = message
    close()
    state = "failed"
    emit(mapOf("state" to "failed", "message" to message))
  }

  private fun armTimeout(message: String) {
    timeout?.cancel(false)
    val epoch = generation
    timeout = queue.schedule({ if (generation == epoch) fail(message) }, 20, TimeUnit.SECONDS)
  }

  fun connect(text: String) {
    close()
    lastError = null
    val info = Invitation.parse(text)
    require(info.direction == Direction.DesktopToPhone) { "This invitation is for sharing this phone. Use the sender instead." }
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

  private fun receive(text: String) {
    require(text.toByteArray().size <= 65_536) { "Signaling message is too large" }
    val message = JSONObject(text)
    val info = checkNotNull(invitation)
    check(message.getInt("v") == 1 && message.getString("sessionId") == info.sessionId) { "Stale signaling session" }
    val type = message.getString("type")
    require(message.keys().asSequence().toSet() == SignalRoutes.desktopFields(info.direction, type)) { "Invalid signaling fields" }
    when (type) {
      "paired" -> {
        check(state == "connecting" && peer == null) { "Unexpected pairing response" }
        timeout?.cancel(false); status("ready")
      }
      "offer" -> {
        check(state == "ready" && peer == null) { "Unexpected second offer" }
        val sdp = message.getString("sdp")
        require(sdp.isNotEmpty() && sdp.toByteArray().size <= 60_000) { "Invalid SDP" }
        answer(sdp)
      }
      "candidate" -> {
        val candidate = message.getString("candidate")
        val mid = if (message.isNull("sdpMid")) null else message.getString("sdpMid")
        val index = message.getInt("sdpMLineIndex")
        require(candidate.isNotEmpty() && candidate.toByteArray().size <= 8192 && (mid?.length ?: 0) <= 256 && index in 0..32) { "Invalid ICE candidate" }
        val ice = IceCandidate(mid, index, candidate)
        val pc = peer
        if (pc?.remoteDescription != null) addCandidate(pc, ice, generation)
        else { check(candidates.size < 128) { "Too many pending candidates" }; candidates.add(ice) }
      }
      "stop" -> stop()
    }
  }

  private fun answer(offer: String) {
    val epoch = generation
    val config = PeerConnection.RTCConfiguration(emptyList()).apply {
      sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
      bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
    }
    val pc = checkNotNull(WebRtcFactory.get(context).factory.createPeerConnection(config, observer(epoch))) { "Could not create WebRTC viewer" }
    peer = pc
    status("connecting")
    armTimeout("Video negotiation timed out. Ask the desktop to start sharing again.")
    val failure = { message: String -> dispatch { if (generation == epoch) fail(message) } }
    pc.setRemoteDescription(object : SdpCallbacks(failure) {
      override fun onSetSuccess() = dispatch {
        if (peer !== pc) return@dispatch
        candidates.forEach { addCandidate(pc, it, epoch) }; candidates.clear()
        pc.createAnswer(object : SdpCallbacks(failure) {
          override fun onCreateSuccess(description: SessionDescription) = dispatch {
            if (peer !== pc) return@dispatch
            pc.setLocalDescription(object : SdpCallbacks(failure) {
              override fun onSetSuccess() = dispatch {
                if (peer === pc) signaling?.let { check(it.send(JSONObject().put("type", "answer").put("sdp", description.description))) { "Signaling socket is closed or busy" } }
              }
            }, description)
          }
        }, MediaConstraints())
      }
    }, SessionDescription(SessionDescription.Type.OFFER, offer))
  }

  private fun addCandidate(pc: PeerConnection, candidate: IceCandidate, epoch: Long) {
    pc.addIceCandidate(candidate, object : AddIceObserver {
      override fun onAddSuccess() {}
      override fun onAddFailure(error: String) = dispatch { if (generation == epoch) fail("Could not add ICE candidate") }
    })
  }

  private fun show(video: VideoTrack) {
    track = video
    renderer?.let { video.addSink(it) }
  }

  private fun startStats(pc: PeerConnection) {
    stats?.cancel(false)
    stats = queue.scheduleAtFixedRate({
      if (peer === pc) pc.getStats { report -> dispatch {
        if (peer !== pc) return@dispatch
        for (entry in report.statsMap.values.filter { it.type == "inbound-rtp" && it.members["kind"] == "video" }) {
          val values = entry.members
          val bytes = (values["bytesReceived"] as? Number)?.toDouble() ?: 0.0
          val elapsed = report.timestampUs - previousTime
          val mbps = if (previousTime > 0 && elapsed > 0) maxOf(0.0, (bytes - previousBytes) * 8 / elapsed) else 0.0
          previousBytes = bytes; previousTime = report.timestampUs
          val currentStats = mapOf(
            "codec" to (report.statsMap[values["codecId"]]?.members?.get("mimeType") ?: "negotiating"),
            "mbps" to mbps,
            "fps" to (values["framesPerSecond"] ?: 0),
            "width" to (values["frameWidth"] ?: 0),
            "height" to (values["frameHeight"] ?: 0),
          )
          lastStats = currentStats
          emit(mapOf("state" to state, "stats" to currentStats))
        }
      } }
    }, 1, 1, TimeUnit.SECONDS)
  }

  private fun observer(epoch: Long) = object : PeerConnection.Observer {
    override fun onIceCandidate(candidate: IceCandidate) = dispatch {
      if (generation == epoch) runCatching {
        check(signaling?.send(JSONObject().put("type", "candidate").put("candidate", candidate.sdp)
          .put("sdpMid", candidate.sdpMid ?: JSONObject.NULL).put("sdpMLineIndex", candidate.sdpMLineIndex)) == true) { "Signaling socket is closed or busy" }
      }.onFailure { fail("Could not send ICE candidate") }
    }
    override fun onTrack(transceiver: RtpTransceiver) = dispatch {
      if (generation == epoch) (transceiver.receiver.track() as? VideoTrack)?.let { show(it) }
    }
    override fun onIceConnectionChange(next: PeerConnection.IceConnectionState) = dispatch {
      if (generation != epoch) return@dispatch
      when (next) {
        PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> {
          timeout?.cancel(false); status("streaming"); peer?.let { startStats(it) }
        }
        PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.DISCONNECTED -> fail("Video connection lost. Ask the desktop to start sharing again.")
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
    renderer?.let { track?.removeSink(it) }; track = null
    peer?.close(); peer?.dispose(); peer = null
    signaling?.close(); signaling = null
    invitation = null; candidates.clear(); previousBytes = 0.0; previousTime = 0.0
    lastStats = null
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

  fun destroy() = dispatch { close(); queue.shutdown() }
}
