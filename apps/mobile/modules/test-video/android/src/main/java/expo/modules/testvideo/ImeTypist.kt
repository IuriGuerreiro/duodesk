package expo.modules.testvideo

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.InputMethod
import android.os.SystemClock
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.annotation.RequiresApi

/**
 * Types through the accessibility service's own input method (`FLAG_INPUT_METHOD_EDITOR`, Android 13+). It
 * writes into the focused field only; it cannot read the field or the screen. Only loaded on Android 13+.
 */
@RequiresApi(33)
internal class ImeTypist(private val service: AccessibilityService) : TextInjector {
  /**
   * False until the owner's Accessibility setting carries the input method flag. A service enabled by an
   * older build may need to be turned off and on again.
   */
  fun available(): Boolean {
    val info = service.serviceInfo ?: return false
    return info.flags and AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR != 0 && service.inputMethod != null
  }

  /** The focused editor's connection, or null when no editable field has input focus. */
  private fun editor(): Pair<InputMethod, InputMethod.AccessibilityInputConnection>? {
    val method = service.inputMethod ?: return null
    if (!method.currentInputStarted) return null
    val connection = method.currentInputConnection ?: return null
    return Pair(method, connection)
  }

  override fun commitText(text: String): TypingOutcome {
    val (_, connection) = editor() ?: return TypingOutcome.NO_FIELD
    // Returns nothing: success means handed to the editor, not displayed.
    connection.commitText(text, 1, null)
    return TypingOutcome.DONE
  }

  override fun press(key: ControlWire.Key): TypingOutcome {
    val (method, connection) = editor() ?: return TypingOutcome.NO_FIELD
    when (key) {
      // Key events let the editor delete a whole character, so emoji and surrogate pairs are never split.
      ControlWire.Key.BACKSPACE -> downUp(connection, KeyEvent.KEYCODE_DEL)
      ControlWire.Key.DELETE -> downUp(connection, KeyEvent.KEYCODE_FORWARD_DEL)
      ControlWire.Key.ENTER -> {
        val info = method.currentInputEditorInfo
        when (val plan = EnterPlan.of(info?.inputType ?: 0, info?.imeOptions ?: 0)) {
          EnterPlan.NewLine -> connection.commitText("\n", 1, null)
          is EnterPlan.Action -> connection.performEditorAction(plan.id)
          EnterPlan.Key -> downUp(connection, KeyEvent.KEYCODE_ENTER)
        }
      }
    }
    return TypingOutcome.DONE
  }

  /** The same pair of events a soft keyboard sends for one key press. */
  private fun downUp(connection: InputMethod.AccessibilityInputConnection, code: Int) {
    val time = SystemClock.uptimeMillis()
    val flags = KeyEvent.FLAG_SOFT_KEYBOARD or KeyEvent.FLAG_KEEP_TOUCH_MODE
    for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP))
      connection.sendKeyEvent(KeyEvent(time, time, action, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, flags))
  }
}
