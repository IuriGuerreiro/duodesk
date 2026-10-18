package expo.modules.testvideo

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.WindowManager
import org.webrtc.CapturerObserver
import org.webrtc.EglBase
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import java.util.concurrent.Executor

internal data class CaptureDimensions(val width: Int, val height: Int)

internal fun computeCaptureDimensions(
  displayWidth: Int,
  displayHeight: Int,
  maxLongSide: Int = 1920,
  maxShortSide: Int = 1080
): CaptureDimensions {
  if (displayWidth <= 0 || displayHeight <= 0) {
    return CaptureDimensions(maxShortSide, maxLongSide)
  }
  val isPortrait = displayHeight >= displayWidth
  val targetMaxW = if (isPortrait) maxShortSide else maxLongSide
  val targetMaxH = if (isPortrait) maxLongSide else maxShortSide

  val scaleW = targetMaxW.toDouble() / displayWidth
  val scaleH = targetMaxH.toDouble() / displayHeight
  val scale = minOf(1.0, scaleW, scaleH)

  var w = (displayWidth * scale).toInt()
  var h = (displayHeight * scale).toInt()

  // Video encoders require dimensions divisible by 2
  w = maxOf(2, (w / 2) * 2)
  h = maxOf(2, (h / 2) * 2)

  return CaptureDimensions(w, h)
}

internal class ScreenSource(
  private val context: Context,
  private val eglContext: EglBase.Context,
  private val observer: CapturerObserver,
  private val resultData: Intent,
  private val queue: Executor,
  private val onResize: ((width: Int, height: Int) -> Unit)? = null,
  private val onFailure: (String) -> Unit
) {
  @Volatile
  private var running = false
  private var capturer: ScreenCapturerAndroid? = null
  private var surfaceTextureHelper: SurfaceTextureHelper? = null
  private var currentWidth = 0
  private var currentHeight = 0

  private val mediaProjectionCallback = object : MediaProjection.Callback() {
    override fun onStop() {
      // System revoked or stopped media projection.
      // Dispatch off the texture thread to avoid teardown deadlocks.
      queue.execute {
        if (running) {
          onFailure("Screen capture was stopped by the system")
        }
      }
    }

    override fun onCapturedContentResize(width: Int, height: Int) {
      // System resized captured content (API 34+ / Android 14+).
      // Dispatch off the texture thread before calling synchronized capturer methods.
      queue.execute {
        if (running) {
          handleResize(width, height)
        }
      }
    }
  }

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {}
    override fun onDisplayRemoved(displayId: Int) {}
    override fun onDisplayChanged(displayId: Int) {
      if (displayId == Display.DEFAULT_DISPLAY) {
        queue.execute {
          if (running) {
            val (w, h) = getDisplayDimensions()
            handleResize(w, h)
          }
        }
      }
    }
  }

  fun start() {
    check(capturer == null) { "Screen capture already started" }
    val (displayWidth, displayHeight) = getDisplayDimensions()
    val dims = computeCaptureDimensions(displayWidth, displayHeight)
    currentWidth = dims.width
    currentHeight = dims.height

    val helper = checkNotNull(SurfaceTextureHelper.create("duodesk-screen-textures", eglContext)) {
      "Could not create surface texture helper"
    }
    surfaceTextureHelper = helper

    val screenCapturer = ScreenCapturerAndroid(resultData, mediaProjectionCallback)
    capturer = screenCapturer
    screenCapturer.initialize(helper, context, observer)

    running = true
    screenCapturer.startCapture(dims.width, dims.height, 30)
    onResize?.invoke(dims.width, dims.height)

    val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    dm?.registerDisplayListener(displayListener, Handler(Looper.getMainLooper()))
  }

  fun stop() {
    if (!running && capturer == null) return
    running = false

    val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    runCatching { dm?.unregisterDisplayListener(displayListener) }

    runCatching { capturer?.stopCapture() }
    runCatching { capturer?.dispose() }
    capturer = null

    runCatching { surfaceTextureHelper?.dispose() }
    surfaceTextureHelper = null
  }

  private fun handleResize(newWidth: Int, newHeight: Int) {
    if (!running || newWidth <= 0 || newHeight <= 0) return
    val dims = computeCaptureDimensions(newWidth, newHeight)
    if (dims.width == currentWidth && dims.height == currentHeight) return
    currentWidth = dims.width
    currentHeight = dims.height

    runCatching {
      capturer?.changeCaptureFormat(dims.width, dims.height, 30)
      onResize?.invoke(dims.width, dims.height)
    }.onFailure {
      onFailure("Failed to resize screen capture: ${it.message}")
    }
  }

  private fun getDisplayDimensions(): Pair<Int, Int> {
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wm != null) {
      val bounds = wm.currentWindowMetrics.bounds
      Pair(bounds.width(), bounds.height())
    } else {
      val dm = context.resources.displayMetrics
      Pair(dm.widthPixels, dm.heightPixels)
    }
  }
}
