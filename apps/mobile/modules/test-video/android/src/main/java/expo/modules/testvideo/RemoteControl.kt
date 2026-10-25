package expo.modules.testvideo

/** Real size of the captured display in its current rotation, in physical pixels. */
internal data class Geometry(val width: Int, val height: Int, val rotation: Int)

internal enum class GestureOutcome { DONE, CANCELLED }

/** Performs one finite single-pointer gesture. Implemented by the accessibility service. */
internal interface GestureInjector {
  /**
   * Starts the gesture and returns true, or returns false without touching the screen.
   * After true, [onDone] runs exactly once, on any thread. [points] holds one point for a tap.
   */
  fun dispatch(points: List<Pair<Int, Int>>, durationMs: Int, onDone: (GestureOutcome) -> Unit): Boolean
}

internal enum class OffReason(val wire: String) {
  UNSUPPORTED("unsupported"),
  SERVICE_DISABLED("service-disabled"),
  NOT_ALLOWED("not-allowed"),
  REVOKED("revoked"),
  GEOMETRY_UNKNOWN("geometry-unknown")
}

/** What the phone UI and the desktop are told. */
internal data class ControlSnapshot(val epoch: Int, val geometry: Geometry?, val reason: OffReason?, val serviceEnabled: Boolean) {
  val on: Boolean get() = geometry != null
}

/**
 * One streaming session's remote control grant. Off until the phone owner allows it; ends on revoke, loss of
 * the accessibility service, unknown display geometry, or [close]. Touch input is accepted only while on, only
 * for the current [epoch], and only one gesture at a time.
 *
 * Not thread safe: every call, including [post] callbacks, must run on one thread (the sender queue).
 */
internal class RemoteControl(
  private val sessionId: String,
  private val supported: Boolean,
  private val injector: () -> GestureInjector?,
  /** Sends one control channel message. Returns false when the channel is not open. */
  private val send: (String) -> Boolean,
  /** Runs [block] on the thread that owns this object. Used by asynchronous gesture callbacks. */
  private val post: (() -> Unit) -> Unit,
  /** The snapshot changed, so the phone UI should refresh. */
  private val changed: () -> Unit
) {
  private var allowed = false
  private var offReason = OffReason.NOT_ALLOWED
  private var geometry: Geometry? = null
  private var epoch = 0
  private var lastSeq = 0
  private var inFlight = false
  private var closed = false
  @Volatile
  private var current = compute()

  fun snapshot(): ControlSnapshot = current

  private fun compute(): ControlSnapshot {
    val enabled = supported && injector() != null
    val reason = when {
      !supported -> OffReason.UNSUPPORTED
      !enabled -> OffReason.SERVICE_DISABLED
      // Reported before "not allowed" so the phone UI waits for the size instead of allowing too early.
      geometry == null -> OffReason.GEOMETRY_UNKNOWN
      !allowed -> offReason
      else -> null
    }
    return ControlSnapshot(epoch, if (reason == null) geometry else null, reason, enabled)
  }

  private fun refresh() {
    current = compute()
    changed()
    publish()
  }

  /** Sends the current status. Called after every change and on the heartbeat. */
  fun publish() {
    if (closed) return
    val snap = current
    send(ControlWire.status(sessionId, snap.epoch, snap.geometry, snap.reason?.wire))
  }

  /** The phone owner pressed Allow. Returns an explanation if control cannot start. */
  fun allow(): String? {
    if (closed) return "The session has ended."
    if (!supported) return "Remote control is only available while sharing the screen."
    if (injector() == null) return "Turn on the DuoDesk accessibility service first."
    if (geometry == null) return "The screen size is not known yet. Try again in a moment."
    allowed = true
    epoch++
    refresh()
    return null
  }

  /** Stops accepting input at once. A gesture already handed to Android (2 s at most) cannot be recalled. */
  fun revoke(reason: OffReason = OffReason.REVOKED) {
    if (closed || !allowed) return
    allowed = false
    offReason = reason
    epoch++
    refresh()
  }

  /** The captured display changed size or rotation. `null` means it cannot be determined. */
  fun setGeometry(next: Geometry?) {
    if (closed || next == geometry) return
    geometry = next
    if (next == null) {
      // Mapping is uncertain: control stays off until the owner allows it again.
      allowed = false
      offReason = OffReason.GEOMETRY_UNKNOWN
    } else if (!allowed && offReason == OffReason.GEOMETRY_UNKNOWN) {
      offReason = OffReason.NOT_ALLOWED
    }
    epoch++
    refresh()
  }

  /** The accessibility service connected or disconnected. */
  fun serviceChanged() {
    if (closed) return
    if (injector() == null && allowed) {
      allowed = false
      offReason = OffReason.SERVICE_DISABLED
      epoch++
    } else if (!allowed && offReason == OffReason.SERVICE_DISABLED) {
      offReason = OffReason.NOT_ALLOWED
    }
    refresh()
  }

  /** Session over: disconnect, stop, capture end, failure. */
  fun close() {
    if (closed) return
    allowed = false
    closed = true
    epoch++
    current = ControlSnapshot(epoch, null, OffReason.REVOKED, false)
  }

  fun onCommand(text: String) {
    if (closed) return
    val command = try { ControlWire.parseCommand(text, sessionId) } catch (_: IllegalArgumentException) { return }
    val reject = { reason: ControlWire.Rejection ->
      send(ControlWire.result(sessionId, command.epoch, command.seq, "rejected", reason))
      Unit
    }
    val snap = current
    val geometry = snap.geometry
    if (command.seq <= lastSeq) return reject(ControlWire.Rejection.STALE)
    lastSeq = command.seq
    if (geometry == null) return reject(ControlWire.Rejection.OFF)
    if (command.epoch != epoch) return reject(ControlWire.Rejection.STALE)
    if (inFlight) return reject(ControlWire.Rejection.BUSY)
    val target = injector() ?: return reject(ControlWire.Rejection.OFF)

    val (points, duration) = when (command) {
      is ControlWire.Command.Tap -> Pair(listOf(pixel(command.x, command.y, geometry)), TAP_MS)
      is ControlWire.Command.Swipe -> Pair(command.points.map { pixel(it.first, it.second, geometry) }, command.durationMs)
    }
    inFlight = true
    val started = try {
      target.dispatch(points, duration) { outcome ->
        post {
          inFlight = false
          val status = if (outcome == GestureOutcome.DONE) "done" else "cancelled"
          send(ControlWire.result(sessionId, command.epoch, command.seq, status))
        }
      }
    } catch (_: RuntimeException) {
      false
    }
    if (!started) {
      inFlight = false
      send(ControlWire.result(sessionId, command.epoch, command.seq, "failed"))
    }
  }

  companion object {
    /** Short enough to count as a tap, long enough for the touch screen driver to register it. */
    const val TAP_MS = 50

    /** The last pixel is `size - 1`, matching `toPixel` in the shared protocol package. */
    fun pixel(x: Double, y: Double, geometry: Geometry): Pair<Int, Int> = Pair(
      Math.round(x * (geometry.width - 1)).toInt().coerceIn(0, geometry.width - 1),
      Math.round(y * (geometry.height - 1)).toInt().coerceIn(0, geometry.height - 1)
    )
  }
}
