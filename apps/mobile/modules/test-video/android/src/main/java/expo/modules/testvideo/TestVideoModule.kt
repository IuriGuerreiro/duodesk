package expo.modules.testvideo

import android.app.Activity
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TestVideoModule : Module() {
  @Volatile private var sender: VideoSender? = null
  @Volatile private var destroyed = false
  private var consent: Pair<Int, Promise>? = null
  private val main = Handler(Looper.getMainLooper())
  @Synchronized private fun session(): VideoSender {
    check(!destroyed) { "The streaming module has been destroyed" }
    return sender ?: VideoSender(requireNotNull(appContext.reactContext).applicationContext) {
      sendEvent("onStatus", it)
    }.also { sender = it }
  }
  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Events("onStatus")
    AsyncFunction("connect") { invitation: String, promise: Promise ->
      session().submit(promise) { connect(invitation) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { bitrateMbps: Int, promise: Promise ->
      session().submit(promise) { start(bitrateMbps) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("startScreen") { bitrateMbps: Int, promise: Promise ->
      if (consent != null) {
        promise.reject("ERR_SCREEN_PENDING", "Finish the current screen sharing prompt first", null)
      } else {
        val activeSender = session()
        activeSender.requestScreen(bitrateMbps, promise) {
          main.post {
            if (!destroyed) {
              try {
                val activity = requireNotNull(appContext.currentActivity) { "Open DuoDesk to share your screen" }
                check(!activity.isFinishing && !activity.isDestroyed) { "Open DuoDesk to share your screen" }
                consent = Pair(bitrateMbps, promise)
                val manager = activity.getSystemService(MediaProjectionManager::class.java)
                activity.startActivityForResult(manager.createScreenCaptureIntent(), SCREEN_REQUEST)
              } catch (error: Exception) {
                consent = null
                activeSender.screenConsentFailed(promise, error.message ?: "Could not open Android screen sharing consent")
              }
            }
          }
        }
      }
    }.runOnQueue(Queues.MAIN)
    OnActivityResult { _, result ->
      if (result.requestCode == SCREEN_REQUEST) {
        consent?.let { (bitrate, promise) ->
          consent = null
          sender?.screenConsent(bitrate, promise, if (result.resultCode == Activity.RESULT_OK) result.data else null)
        }
      }
    }
    AsyncFunction("stop") { promise: Promise ->
      sender?.submit(promise) { stop() } ?: promise.resolve()
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { sender?.background() }
    OnDestroy { destroyed = true; sender?.destroy(); sender = null; consent = null }
  }
  companion object { private const val SCREEN_REQUEST = 49721 }
}
