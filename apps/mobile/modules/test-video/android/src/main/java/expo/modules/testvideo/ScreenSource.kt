package expo.modules.testvideo

import android.app.Activity
import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.content.Intent
import android.os.Build
import android.view.Surface
import android.view.WindowManager
import org.webrtc.CapturerObserver
import org.webrtc.EglBase
import org.webrtc.SurfaceTextureHelper
import kotlin.math.roundToInt

/** One consent, one projection, one virtual display. Resizing never reuses the token. */
internal class ScreenSource(
  private val context: Context,
  private val egl: EglBase.Context,
  private val observer: CapturerObserver,
  private val onStopped: () -> Unit,
  private val onFailure: (String) -> Unit
) {
  private var helper: SurfaceTextureHelper? = null
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var surface: Surface? = null
  private var size = Pair(0, 0)
  private var active = false
  private var started = false
  private val displays = context.getSystemService(DisplayManager::class.java)
  private val callback = object : MediaProjection.Callback() {
    override fun onStop() { onStopped() }
    override fun onCapturedContentResize(width: Int, height: Int) { resizeSafely(width, height) }
  }
  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(id: Int) {}
    override fun onDisplayRemoved(id: Int) {}
    override fun onDisplayChanged(id: Int) {
      if (Build.VERSION.SDK_INT < 34) {
        val bounds = screenSize()
        resizeSafely(bounds.first, bounds.second)
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun screenSize(): Pair<Int, Int> {
    val wm = context.getSystemService(WindowManager::class.java)
    if (Build.VERSION.SDK_INT >= 30) return wm.maximumWindowMetrics.bounds.let { Pair(it.width(), it.height()) }
    val metrics = android.util.DisplayMetrics()
    wm.defaultDisplay.getRealMetrics(metrics)
    return Pair(metrics.widthPixels, metrics.heightPixels)
  }

  // Bound encoder load to a 1920-pixel long edge, preserving portrait/window aspect ratio.
  private fun outputSize(width: Int, height: Int): Pair<Int, Int> {
    require(width > 0 && height > 0) { "Invalid capture size" }
    val scale = minOf(1.0, 1920.0 / maxOf(width, height))
    return Pair(maxOf(2, (width * scale / 2).roundToInt() * 2), maxOf(2, (height * scale / 2).roundToInt() * 2))
  }
  private fun resizeSafely(width: Int, height: Int) {
    if (!active) return
    try {
      val next = outputSize(width, height)
      if (next == size) return
      helper?.setTextureSize(next.first, next.second)
      display?.resize(next.first, next.second, context.resources.configuration.densityDpi)
      size = next
    } catch (error: Exception) { onFailure("Could not resize screen capture: ${error.message}") }
  }

  fun start(data: Intent) {
    val helper = checkNotNull(SurfaceTextureHelper.create("duodesk-screen", egl))
    this.helper = helper
    val handler = helper.handler
    // All projection callbacks and resource mutations use the texture thread.
    org.webrtc.ThreadUtils.invokeAtFrontUninterruptibly(handler) {
      val manager = context.getSystemService(MediaProjectionManager::class.java)
      val projection = checkNotNull(manager.getMediaProjection(Activity.RESULT_OK, data))
      this.projection = projection
      projection.registerCallback(callback, handler)
      val bounds = screenSize()
      size = outputSize(bounds.first, bounds.second)
      helper.setTextureSize(size.first, size.second)
      surface = Surface(helper.surfaceTexture)
      active = true
      helper.startListening { frame -> if (active) observer.onFrameCaptured(frame) }
      display = projection.createVirtualDisplay("DuoDesk screen", size.first, size.second,
        context.resources.configuration.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        surface, null, handler)
      displays.registerDisplayListener(displayListener, handler)
      observer.onCapturerStarted(true)
      started = true
    }
  }

  fun stop() {
    val helper = helper ?: return
    org.webrtc.ThreadUtils.invokeAtFrontUninterruptibly(helper.handler) {
      active = false
      runCatching { displays.unregisterDisplayListener(displayListener) }
      runCatching { projection?.unregisterCallback(callback) }
      runCatching { display?.release() }; display = null
      runCatching { helper.stopListening() }
      runCatching { surface?.release() }; surface = null
      runCatching { projection?.stop() }; projection = null
      if (started) observer.onCapturerStopped()
      started = false
    }
    helper.dispose()
    this.helper = null
  }
}
