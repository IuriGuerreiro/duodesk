package expo.modules.testvideo

import android.content.Context
import android.media.projection.MediaProjectionManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TestVideoModule : Module() {
  private fun sender(): VideoSender {
    val context = requireNotNull(appContext.reactContext).applicationContext
    return VideoSenderManager.getOrCreateSender(context)
  }

  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Constant("supportsScreenSharing") { true }
    Events("onStatus")

    OnCreate {
      VideoSenderManager.setStatusListener { sendEvent("onStatus", it) }
    }

    AsyncFunction("connect") { invitation: String, promise: Promise ->
      sender().submit(promise) { connect(invitation) }
    }

    AsyncFunction("start") { bitrateMbps: Int, promise: Promise ->
      sender().submit(promise) { start(bitrateMbps) }
    }

    AsyncFunction("startScreen") { bitrateMbps: Int, promise: Promise ->
      val s = sender()
      if (!s.isReady()) {
        promise.reject("ERR_STREAM", "Connect to the desktop before starting", null)
        return@AsyncFunction
      }
      if (bitrateMbps !in 2..30) {
        promise.reject("ERR_STREAM", "Choose a bitrate between 2 and 30 Mbps", null)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity ?: run {
        promise.reject("ERR_ACTIVITY", "Current activity is not available", null)
        return@AsyncFunction
      }
      val mediaProjectionManager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager ?: run {
        promise.reject("ERR_PROJECTION", "Media projection is not supported on this device", null)
        return@AsyncFunction
      }

      val request = VideoSenderManager.prepareScreenConsent(bitrateMbps, promise) ?: return@AsyncFunction
      try {
        val captureIntent = mediaProjectionManager.createScreenCaptureIntent()
        activity.startActivityForResult(captureIntent, request.requestCode)
      } catch (error: Exception) {
        VideoSenderManager.abortConsent(request.id, "ERR_PROJECTION", "Failed to launch screen capture dialog: ${error.message}", error)
      }
    }

    AsyncFunction("stop") { promise: Promise ->
      VideoSenderManager.stop(promise)
    }

    AsyncFunction("background") { promise: Promise ->
      VideoSenderManager.background()
      promise.resolve()
    }

    AsyncFunction("getStatus") {
      VideoSenderManager.getStatus()
    }

    OnActivityResult { activity, payload ->
      if (VideoSenderManager.isConsentRequestCode(payload.requestCode)) {
        VideoSenderManager.onConsentResult(activity, payload.requestCode, payload.resultCode, payload.data)
      }
    }

    OnActivityEntersBackground {
      VideoSenderManager.background()
    }

    OnDestroy {
      VideoSenderManager.setStatusListener(null)
    }
  }
}
