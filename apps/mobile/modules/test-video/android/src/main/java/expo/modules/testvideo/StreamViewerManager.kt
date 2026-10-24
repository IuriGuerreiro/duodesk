package expo.modules.testvideo

import android.content.Context
import expo.modules.kotlin.Promise
import org.webrtc.VideoSink

internal object StreamViewerManager {
  private var activeViewer: StreamViewer? = null
  private var statusListener: ((Map<String, Any>) -> Unit)? = null
  private var lastStatus: Map<String, Any> = mapOf("state" to "idle")

  @Synchronized
  fun getOrCreate(context: Context): StreamViewer {
    activeViewer?.let { return it }
    val viewer = StreamViewer(context.applicationContext) { status -> updateStatus(status) }
    activeViewer = viewer
    return viewer
  }

  @Synchronized
  fun setStatusListener(listener: ((Map<String, Any>) -> Unit)?) {
    statusListener = listener
  }

  @Synchronized
  private fun updateStatus(status: Map<String, Any>) {
    lastStatus = status
    statusListener?.invoke(status)
  }

  @Synchronized
  fun getStatus(): Map<String, Any> = activeViewer?.getStatus() ?: lastStatus

  fun attach(context: Context, sink: VideoSink) = getOrCreate(context).attach(sink)

  @Synchronized
  fun detach(sink: VideoSink) {
    activeViewer?.detach(sink)
  }

  fun stop(promise: Promise? = null) {
    val viewer = synchronized(this) { activeViewer }
    if (viewer != null) viewer.stop(promise) else promise?.resolve()
  }
}
