package expo.modules.testvideo

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

internal fun recoveryScheduler(queue: ScheduledExecutorService): (Long, () -> Unit) -> (() -> Unit) = { delay, action ->
  val future = queue.schedule(action, delay, TimeUnit.MILLISECONDS)
  val cancel: () -> Unit = { future.cancel(false); Unit }
  cancel
}

/** Runs only on the peer's queue. The peer cancels this budget on Stop and rejects old callbacks by generation. */
internal class ConnectionRecovery(
  private val schedule: (Long, () -> Unit) -> (() -> Unit),
  private val changed: (String) -> Unit,
  private val exhausted: () -> Unit,
  private val restart: (() -> Unit)? = null
) {
  var active = false
    private set
  private var running = false
  private var attempt = 0
  private var timer: (() -> Unit)? = null
  private var deadline: (() -> Unit)? = null

  fun fields(): Map<String, Any> = if (!active) emptyMap() else mapOf(
    "attempt" to attempt,
    "canReconnect" to (restart != null && !running && attempt < 2)
  )

  fun interrupt() {
    if (active) return
    active = true
    attempt = 0
    publish()
    deadline = schedule(25_000) { exhaust() }
    if (restart != null) timer = schedule(3_000) { reconnect() }
  }

  fun reconnect() {
    if (!active || running || restart == null) return
    timer?.invoke()
    if (attempt >= 2) return exhaust()
    running = true
    attempt++
    publish()
    timer = schedule(8_000) {
      running = false
      if (attempt >= 2) exhaust() else {
        publish()
        timer = schedule(2_000) { reconnect() }
      }
    }
    restart.invoke()
  }

  fun connected() {
    active = false
    running = false
    timer?.invoke(); timer = null
    deadline?.invoke(); deadline = null
  }

  private fun publish() = changed(if (running) "reconnecting" else "interrupted")

  private fun exhaust() {
    if (!active) return
    connected()
    exhausted()
  }
}
