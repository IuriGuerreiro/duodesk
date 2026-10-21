package expo.modules.testvideo

import android.content.Context
import android.os.Build
import android.media.projection.MediaProjectionManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TestVideoModule : Module() {
  private val pairing = PairingTransport()
  private val reconnect = TrustedReconnectTransport()
  private val trustQueue = java.util.concurrent.Executors.newSingleThreadExecutor()
  private fun trustStore() = TrustedDesktopStore.get(requireNotNull(appContext.reactContext).applicationContext)
  private fun trustAction(promise: Promise, action: () -> Any?) {
    trustQueue.execute {
      try { promise.resolve(action()) }
      catch (error: Exception) {
        promise.reject((error as? TrustFailure)?.code ?: "ERR_TRUST_STORAGE", error.message ?: "Secure trust storage failed", error)
      }
    }
  }
  private val pairingQueue = java.util.concurrent.Executors.newSingleThreadExecutor()

  private fun sender(): VideoSender {
    val context = requireNotNull(appContext.reactContext).applicationContext
    return VideoSenderManager.getOrCreateSender(context)
  }

  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Constant("supportsScreenSharing") { true }
    Constant("supportsPlaybackAudio") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q }
    Constant("supportsTrustedDevices") { true }
    Events("onStatus")

    OnCreate {
      VideoSenderManager.setStatusListener { sendEvent("onStatus", it) }
    }

    AsyncFunction("pairRequest") { address: String, message: String, fresh: Boolean, promise: Promise ->
      val ticket = pairing.ticket()
      pairingQueue.execute {
        try { promise.resolve(pairing.request(address, message, fresh, ticket)) }
        catch (error: Exception) { pairing.close(); promise.reject("ERR_PAIRING", "Pairing failed. Check the desktop address, code and Wi-Fi. Create a new code if expired or locked.", error) }
      }
    }
    AsyncFunction("pairClose") { pairing.close() }

    AsyncFunction("connect") { invitation: String, promise: Promise ->
      sender().submit(promise) { connect(invitation) }
    }

    AsyncFunction("connectAndRemember") { invitation: String, name: String, promise: Promise ->
      sender().connectAndRemember(invitation, name, promise)
    }
    AsyncFunction("trustedDesktops") { promise: Promise -> trustAction(promise) { trustStore().list() } }
    AsyncFunction("trustedAddress") { fingerprint: String, address: String, promise: Promise ->
      reconnect.close()
      trustAction(promise) { trustStore().updateAddress(fingerprint, address); null }
    }
    AsyncFunction("trustedForget") { fingerprint: String, promise: Promise ->
      reconnect.close()
      trustAction(promise) { trustStore().forget(fingerprint); null }
    }
    AsyncFunction("trustedReconnect") { fingerprint: String, promise: Promise ->
      val ticket = reconnect.ticket()
      trustQueue.execute {
        try { reconnect.connect(trustStore(), fingerprint, ticket, promise) }
        catch (error: Exception) { promise.reject("ERR_TRUST_STORAGE", error.message, error) }
      }
    }
    AsyncFunction("trustedCancel") { reconnect.close() }

    AsyncFunction("start") { bitrateMbps: Int, promise: Promise ->
      sender().submit(promise) { start(bitrateMbps) }
    }

    AsyncFunction("startScreen") { bitrateMbps: Int, shareAudio: Boolean, promise: Promise ->
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

      val request = VideoSenderManager.prepareScreenConsent(bitrateMbps, shareAudio, promise) ?: return@AsyncFunction
      try {
        val captureIntent = mediaProjectionManager.createScreenCaptureIntent()
        activity.startActivityForResult(captureIntent, request.requestCode)
      } catch (error: Exception) {
        VideoSenderManager.abortConsent(request.id, "ERR_PROJECTION", "Failed to launch screen capture dialog: ${error.message}", error)
      }
    }

    AsyncFunction("pause") { promise: Promise ->
      VideoSenderManager.getActiveSender()?.submit(promise) { pause() } ?: promise.resolve()
    }

    AsyncFunction("stop") { promise: Promise ->
      pairing.close()
      reconnect.close()
      VideoSenderManager.stop(promise)
    }

    AsyncFunction("background") { promise: Promise ->
      pairing.close()
      reconnect.close()
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
      pairing.close()
      reconnect.close()
      VideoSenderManager.background()
    }

    OnDestroy {
      pairing.close()
      reconnect.destroy()
      trustQueue.shutdownNow()
      pairingQueue.shutdownNow()
      VideoSenderManager.setStatusListener(null)
    }
  }
}
