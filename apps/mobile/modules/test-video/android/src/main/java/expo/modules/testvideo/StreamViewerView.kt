package expo.modules.testvideo

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

/** Draws the desktop's video. It shares the module's EGL context, so frames are never copied through JS. */
class StreamViewerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val renderer = SurfaceViewRenderer(context).also {
    it.init(WebRtcFactory.get(context).egl.eglBaseContext, null)
    it.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
    it.setEnableHardwareScaler(true)
    it.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    addView(it)
    StreamViewerManager.attach(context, it)
  }

  internal fun release() {
    StreamViewerManager.detach(renderer)
    renderer.release()
  }
}
