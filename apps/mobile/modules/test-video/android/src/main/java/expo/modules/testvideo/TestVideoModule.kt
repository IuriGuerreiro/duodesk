package expo.modules.testvideo

import android.app.Activity
import android.media.projection.MediaProjectionManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val SCREEN_REQUEST = 4202

class TestVideoModule : Module() {
  private var sender: VideoSender? = null
  private var pending: Pair<Int, Promise>? = null
  private val context get() = requireNotNull(appContext.reactContext).applicationContext
  private fun session(): VideoSender = sender ?: VideoSender(context) { sendEvent("onStatus", it) }.also { sender = it }

  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Events("onStatus")
    AsyncFunction("connect") { invitation: String, promise: Promise -> session().submit(promise) { connect(invitation) } }
    // Screen capture needs fresh user consent for every run.
    AsyncFunction("start") { bitrateMbps: Int, promise: Promise ->
      val activity = appContext.currentActivity ?: return@AsyncFunction promise.reject("ERR_STREAM", "DuoDesk is not in the foreground", null)
      pending?.second?.reject("ERR_STREAM", "Screen sharing was restarted", null)
      pending = bitrateMbps to promise
      val projection = context.getSystemService(MediaProjectionManager::class.java)
      activity.startActivityForResult(projection.createScreenCaptureIntent(), SCREEN_REQUEST)
    }
    AsyncFunction("pause") { promise: Promise -> sender?.submit(promise) { pause() } ?: promise.resolve() }
    AsyncFunction("stop") { promise: Promise -> sender?.submit(promise) { stop() } ?: promise.resolve() }
    OnActivityResult { _, result ->
      if (result.requestCode != SCREEN_REQUEST) return@OnActivityResult
      val (bitrate, promise) = pending ?: return@OnActivityResult
      pending = null
      val permission = result.data
      if (result.resultCode != Activity.RESULT_OK || permission == null)
        return@OnActivityResult promise.reject("ERR_STREAM", "Screen sharing was not allowed", null)
      ScreenShareService.start(context) { session().submit(promise) { start(bitrate, permission) } }
    }
    OnDestroy { sender?.destroy(); sender = null; ScreenShareService.stop(context) }
  }
}
