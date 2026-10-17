package expo.modules.testvideo

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TestVideoModule : Module() {
  private var sender: VideoSender? = null
  private fun session(): VideoSender = sender ?: VideoSender(
    requireNotNull(appContext.reactContext).applicationContext
  ) { sendEvent("onStatus", it) }.also { sender = it }
  override fun definition() = ModuleDefinition {
    Name("DuoDeskTestVideo")
    Events("onStatus")
    AsyncFunction("connect") { invitation: String, promise: Promise -> session().submit(promise) { connect(invitation) } }
    AsyncFunction("start") { bitrateMbps: Int, promise: Promise -> session().submit(promise) { start(bitrateMbps) } }
    AsyncFunction("stop") { promise: Promise -> sender?.submit(promise) { stop() } ?: promise.resolve() }
    OnActivityEntersBackground { sender?.background() }
    OnDestroy { sender?.destroy(); sender = null }
  }
}
