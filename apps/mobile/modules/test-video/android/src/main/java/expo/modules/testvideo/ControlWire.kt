package expo.modules.testvideo

import org.json.JSONArray
import org.json.JSONObject

/** Mirrors `packages/protocol/src/control`. Both sides validate strictly and reject unknown fields. */
internal object ControlWire {
  const val CONTROL_LABEL = "duodesk-control"
  const val CONTROL_ID = 1
  const val INPUT_LABEL = "duodesk-input"
  const val INPUT_ID = 2
  const val INPUT_PACKET_LIFETIME_MS = 500
  const val HEARTBEAT_MS = 1000L

  const val MAX_BYTES = 2048
  const val MAX_SWIPE_POINTS = 32
  const val MIN_GESTURE_MS = 50
  const val MAX_GESTURE_MS = 2000
  private const val MAX_COUNTER = Int.MAX_VALUE.toLong()

  /** Why a command was refused before it reached the touch screen. */
  enum class Rejection(val wire: String) { STALE("stale"), OFF("off"), INVALID("invalid"), BUSY("busy") }

  sealed class Command {
    abstract val epoch: Int
    abstract val seq: Int
    data class Tap(override val epoch: Int, override val seq: Int, val x: Double, val y: Double) : Command()
    data class Swipe(
      override val epoch: Int,
      override val seq: Int,
      val durationMs: Int,
      val points: List<Pair<Double, Double>>
    ) : Command()
  }

  /** Throws [IllegalArgumentException] for anything that is not exactly a version 1 tap or swipe for [sessionId]. */
  fun parseCommand(text: String, sessionId: String): Command {
    require(text.toByteArray().size <= MAX_BYTES) { "Control message is too large" }
    val json = try { JSONObject(text) } catch (error: Exception) { throw IllegalArgumentException("Not JSON") }
    val base = setOf("v", "sessionId", "type", "epoch", "seq")
    require(counter(json, "v", 1) == 1L && json.opt("sessionId") == sessionId) { "Wrong session" }
    val epoch = counter(json, "epoch", 0).toInt()
    val seq = counter(json, "seq", 1).toInt()
    return when (json.opt("type")) {
      "tap" -> {
        requireKeys(json, base + setOf("x", "y"))
        Command.Tap(epoch, seq, unit(json, "x"), unit(json, "y"))
      }
      "swipe" -> {
        requireKeys(json, base + setOf("durationMs", "points"))
        val duration = counter(json, "durationMs", MIN_GESTURE_MS.toLong())
        require(duration <= MAX_GESTURE_MS) { "Gesture is too long" }
        val array = json.opt("points") as? JSONArray ?: throw IllegalArgumentException("No points")
        require(array.length() in 2..MAX_SWIPE_POINTS) { "Bad point count" }
        val points = (0 until array.length()).map { index ->
          val pair = array.opt(index) as? JSONArray ?: throw IllegalArgumentException("Bad point")
          require(pair.length() == 2) { "Bad point" }
          Pair(unitValue(pair.opt(0)), unitValue(pair.opt(1)))
        }
        Command.Swipe(epoch, seq, duration.toInt(), points)
      }
      else -> throw IllegalArgumentException("Unknown command")
    }
  }

  fun status(sessionId: String, epoch: Int, geometry: Geometry?, reason: String?): String {
    val message = base(sessionId, "status").put("epoch", epoch)
    if (geometry != null) {
      message.put("state", "on").put(
        "geometry",
        JSONObject().put("width", geometry.width).put("height", geometry.height).put("rotation", geometry.rotation)
      )
    } else {
      message.put("state", "off").put("reason", requireNotNull(reason))
    }
    return message.toString()
  }

  fun result(sessionId: String, epoch: Int, seq: Int, status: String, rejection: Rejection? = null): String {
    val message = base(sessionId, "result").put("epoch", epoch).put("seq", seq).put("status", status)
    rejection?.let { message.put("reason", it.wire) }
    return message.toString()
  }

  private fun base(sessionId: String, type: String) = JSONObject().put("v", 1).put("sessionId", sessionId).put("type", type)

  private fun requireKeys(json: JSONObject, expected: Set<String>) =
    require(json.keys().asSequence().toSet() == expected) { "Unexpected fields" }

  private fun integral(value: Any?): Long {
    val number = value as? Number ?: throw IllegalArgumentException("Expected a number")
    val double = number.toDouble()
    require(double.isFinite() && double == Math.floor(double) && double in 0.0..MAX_COUNTER.toDouble()) { "Expected a counter" }
    return double.toLong()
  }

  private fun counter(json: JSONObject, key: String, min: Long): Long =
    integral(json.opt(key)).also { require(it >= min) { "$key is too small" } }

  private fun unitValue(value: Any?): Double {
    val number = value as? Number ?: throw IllegalArgumentException("Expected a coordinate")
    val double = number.toDouble()
    require(double.isFinite() && double in 0.0..1.0) { "Coordinate outside the display" }
    return double
  }

  private fun unit(json: JSONObject, key: String) = unitValue(json.opt(key))
}
