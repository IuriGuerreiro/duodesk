package expo.modules.testvideo

import android.app.Activity
import android.content.Context
import android.content.Intent
import expo.modules.kotlin.Promise
import java.util.concurrent.atomic.AtomicBoolean

internal class ConsentRequest(
  val id: Long,
  val requestCode: Int,
  val senderGeneration: Long,
  val bitrateMbps: Int,
  private val promise: Promise
) {
  private val settled = AtomicBoolean(false)

  val isSettled: Boolean
    get() = settled.get()

  fun resolve(): Boolean {
    if (settled.compareAndSet(false, true)) {
      promise.resolve()
      return true
    }
    return false
  }

  fun reject(code: String, message: String, cause: Throwable? = null): Boolean {
    if (settled.compareAndSet(false, true)) {
      promise.reject(code, message, cause)
      return true
    }
    return false
  }
}

internal object VideoSenderManager {
  const val BASE_REQUEST_CODE = 3000
  private const val REQUEST_CODE_RANGE = 1000

  private var activeSender: VideoSender? = null
  private var statusListener: ((Map<String, Any>) -> Unit)? = null
  private var lastStatus: Map<String, Any> = mapOf("state" to "idle")

  private var nextConsentId = 0L
  private var pendingConsentRequest: ConsentRequest? = null
  @Volatile
  private var isConsentOutstanding = false

  @Synchronized
  fun getOrCreateSender(context: Context): VideoSender {
    activeSender?.let { return it }
    val sender = VideoSender(context.applicationContext) { status ->
      updateStatus(status)
    }
    activeSender = sender
    return sender
  }

  @Synchronized
  fun getActiveSender(): VideoSender? = activeSender

  @Synchronized
  fun setStatusListener(listener: ((Map<String, Any>) -> Unit)?) {
    statusListener = listener
  }

  @Synchronized
  private fun updateStatus(status: Map<String, Any>) {
    lastStatus = status
    val state = status["state"] as? String
    if (state == "stopped" || state == "failed") {
      pendingConsentRequest?.reject("ERR_STREAM", "Session $state while awaiting screen consent", null)
      isConsentOutstanding = false
    }
    statusListener?.invoke(status)
  }

  @Synchronized
  fun getStatus(): Map<String, Any> {
    return activeSender?.getStatus() ?: lastStatus
  }

  @Synchronized
  fun isPendingScreenConsent(): Boolean = isConsentOutstanding || (pendingConsentRequest != null && !pendingConsentRequest!!.isSettled)

  @Synchronized
  fun isConsentRequestCode(code: Int): Boolean = code in BASE_REQUEST_CODE until (BASE_REQUEST_CODE + REQUEST_CODE_RANGE)

  @Synchronized
  fun prepareScreenConsent(bitrateMbps: Int, promise: Promise): ConsentRequest? {
    val sender = activeSender ?: run {
      promise.reject("ERR_STREAM", "Connect to the desktop before starting", null)
      return null
    }
    if (!sender.isReady()) {
      promise.reject("ERR_STREAM", "Connect to the desktop before starting", null)
      return null
    }
    if (bitrateMbps !in 2..30) {
      promise.reject("ERR_STREAM", "Choose a bitrate between 2 and 30 Mbps", null)
      return null
    }
    val currentGen = sender.currentGeneration()
    val currentRequest = pendingConsentRequest
    if (currentRequest != null && (currentRequest.isSettled || currentRequest.senderGeneration != currentGen)) {
      pendingConsentRequest = null
      isConsentOutstanding = false
    }
    if (isPendingScreenConsent()) {
      promise.reject("ERR_BUSY", "Screen capture consent is already in progress", null)
      return null
    }

    val id = ++nextConsentId
    val requestCode = BASE_REQUEST_CODE + ((id % REQUEST_CODE_RANGE).toInt())
    val request = ConsentRequest(id, requestCode, sender.currentGeneration(), bitrateMbps, promise)
    pendingConsentRequest = request
    isConsentOutstanding = true
    return request
  }

  @Synchronized
  fun abortConsent(id: Long, code: String, message: String, cause: Throwable? = null) {
    val request = pendingConsentRequest
    if (request != null && request.id == id) {
      request.reject(code, message, cause)
      pendingConsentRequest = null
      isConsentOutstanding = false
    }
  }

  @Synchronized
  fun onConsentResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    val request = pendingConsentRequest ?: return
    if (request.requestCode != requestCode) {
      // Stale result from an older or unknown request code
      return
    }

    // Activity result has returned, so the OS dialog is no longer outstanding
    isConsentOutstanding = false
    pendingConsentRequest = null

    if (request.isSettled) {
      // Already settled earlier (e.g. stopped, failed, or cancelled while dialog was displayed)
      return
    }

    val sender = activeSender
    if (sender == null || sender.currentGeneration() != request.senderGeneration) {
      request.reject("ERR_STALE", "Screen capture consent expired or session changed", null)
      return
    }

    if (resultCode != Activity.RESULT_OK || data == null) {
      sender.onPermissionDenied("Screen capture permission was denied")
      request.reject("ERR_PERMISSION", "Screen capture permission was denied", null)
      return
    }

    val serviceSession = request.senderGeneration
    ScreenCaptureService.start(activity.applicationContext, serviceSession) {
      sender.submitScreen(
        bitrateMbps = request.bitrateMbps,
        resultData = data,
        serviceSession = serviceSession,
        onStarted = { request.resolve() },
        onError = { error ->
          request.reject("ERR_STREAM", error.message ?: "Screen capture failed", error)
        }
      )
    }
  }

  fun background() {
    synchronized(this) {
      if (isPendingScreenConsent()) {
        return
      }
    }
    activeSender?.background()
  }

  fun stop(promise: Promise? = null) {
    synchronized(this) {
      if (pendingConsentRequest != null) {
        pendingConsentRequest?.reject("ERR_CANCELLED", "Screen capture was cancelled", null)
      }
      isConsentOutstanding = false
    }
    val sender = activeSender
    if (sender != null) {
      sender.stop(promise)
    } else {
      promise?.resolve()
    }
  }

  fun onServiceDestroyed() {
    synchronized(this) {
      val sender = activeSender ?: return
      if (sender.getMode() == "screen") {
        stop()
      }
    }
  }

  fun destroy() {
    synchronized(this) {
      pendingConsentRequest?.reject("ERR_DESTROYED", "Screen sharing destroyed", null)
      pendingConsentRequest = null
      isConsentOutstanding = false
      statusListener = null
      activeSender?.destroy()
      activeSender = null
      lastStatus = mapOf("state" to "idle")
    }
  }
}
