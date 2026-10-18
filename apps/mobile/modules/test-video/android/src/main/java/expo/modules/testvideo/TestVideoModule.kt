package expo.modules.testvideo

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TestVideoModule : Module() {
  private val pairing = PairingTransport()
  private val pairingQueue = java.util.concurrent.Executors.newSingleThreadExecutor()
  private var sender: VideoSender? = null
  private fun session(): VideoSender = sender ?: VideoSender(
    requireNotNull(appContext.reactContext).applicationContext
  ) { sendEvent("onStatus", it) }.also { sender = it }
  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Events("onStatus")
    AsyncFunction("pairRequest") { address: String, message: String, fresh: Boolean, promise: Promise ->
      val ticket = pairing.ticket()
      pairingQueue.execute {
        try { promise.resolve(pairing.request(address, message, fresh, ticket)) }
        catch (error: Exception) { pairing.close(); promise.reject("ERR_PAIRING", "Pairing failed. Check the desktop address, code and Wi-Fi. Create a new code if expired or locked.", error) }
      }
    }
    AsyncFunction("pairClose") { pairing.close() }
    AsyncFunction("connect") { invitation: String, promise: Promise -> session().submit(promise) { connect(invitation) } }
    AsyncFunction("start") { bitrateMbps: Int, promise: Promise -> session().submit(promise) { start(bitrateMbps) } }
    AsyncFunction("stop") { promise: Promise -> sender?.submit(promise) { stop() } ?: promise.resolve() }
    OnActivityEntersBackground { pairing.close(); sender?.background() }
    OnDestroy { pairing.close(); pairingQueue.shutdownNow(); sender?.destroy(); sender = null }
  }
}
