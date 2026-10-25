package expo.modules.testvideo

import android.app.Activity
import android.content.pm.ActivityInfo
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

/**
 * Puts the Activity into a landscape, full-screen state while the desktop viewer is open.
 * The manifest stays portrait for every other screen; this saves and restores the prior lock.
 */
internal object ViewerWindow {
  private var savedOrientation: Int? = null

  fun enter(activity: Activity) = activity.runOnUiThread {
    if (savedOrientation == null) savedOrientation = activity.requestedOrientation
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    setBarsHidden(activity, true)
  }

  fun exit(activity: Activity) = activity.runOnUiThread {
    val previous = savedOrientation ?: return@runOnUiThread
    savedOrientation = null
    activity.requestedOrientation = previous
    setBarsHidden(activity, false)
  }

  @Suppress("DEPRECATION")
  private fun setBarsHidden(activity: Activity, hidden: Boolean) {
    val window = activity.window ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = window.insetsController ?: return
      if (hidden) {
        controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsets.Type.systemBars())
      } else {
        controller.show(WindowInsets.Type.systemBars())
      }
    } else {
      window.decorView.systemUiVisibility = if (hidden) {
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
          View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
          View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
      } else {
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
      }
    }
  }
}
