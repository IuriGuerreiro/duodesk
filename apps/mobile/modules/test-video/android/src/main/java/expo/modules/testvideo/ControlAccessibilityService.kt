package expo.modules.testvideo

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Lets an allowed DuoDesk session perform taps and swipes. It declares no event types and cannot read window
 * content: its only capability is `canPerformGestures`. The phone owner turns it on in Android's Accessibility
 * settings; being on does not allow control by itself, each session needs its own Allow.
 */
class ControlAccessibilityService : AccessibilityService() {
  companion object {
    @Volatile
    private var connected: ControlAccessibilityService? = null
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    internal fun injector(): GestureInjector? = connected?.injector

    internal fun addListener(listener: () -> Unit) { listeners.add(listener) }
    internal fun removeListener(listener: () -> Unit) { listeners.remove(listener) }

    fun settingsIntent(): Intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun setConnected(service: ControlAccessibilityService?) {
      connected = service
      listeners.forEach { it() }
    }
  }

  private val injector = object : GestureInjector {
    override fun dispatch(points: List<Pair<Int, Int>>, durationMs: Int, onDone: (GestureOutcome) -> Unit): Boolean {
      if (points.isEmpty()) return false
      val path = Path().apply {
        moveTo(points[0].first.toFloat(), points[0].second.toFloat())
        for (index in 1 until points.size) lineTo(points[index].first.toFloat(), points[index].second.toFloat())
      }
      val gesture = try {
        GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.toLong())).build()
      } catch (_: IllegalArgumentException) {
        return false
      }
      val callback = object : GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) = onDone(GestureOutcome.DONE)
        override fun onCancelled(gestureDescription: GestureDescription?) = onDone(GestureOutcome.CANCELLED)
      }
      return dispatchGesture(gesture, callback, null)
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    setConnected(this)
  }

  override fun onUnbind(intent: Intent?): Boolean {
    if (connected === this) setConnected(null)
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    if (connected === this) setConnected(null)
    super.onDestroy()
  }

  override fun onInterrupt() {}

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
}
