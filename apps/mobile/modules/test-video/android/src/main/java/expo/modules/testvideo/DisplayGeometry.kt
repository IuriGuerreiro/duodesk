package expo.modules.testvideo

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager

/**
 * The one source of truth for the captured display's size. Screen capture sizing and the remote control
 * coordinate mapping both read it, so the encoded frame and the touch space always describe the same display.
 */
internal fun readDisplayGeometry(context: Context): Geometry? {
  val display = (context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(Display.DEFAULT_DISPLAY) ?: return null
  val width: Int
  val height: Int
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    val bounds = (context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)?.maximumWindowMetrics?.bounds ?: return null
    width = bounds.width()
    height = bounds.height()
  } else {
    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    display.getRealMetrics(metrics)
    width = metrics.widthPixels
    height = metrics.heightPixels
  }
  if (width <= 0 || height <= 0) return null
  return Geometry(width, height, display.rotation)
}
