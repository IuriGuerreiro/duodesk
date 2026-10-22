package expo.modules.testvideo

import org.json.JSONObject
import java.net.URI

internal enum class Direction(val wire: String) {
  PhoneToDesktop("phone-to-desktop"),
  DesktopToPhone("desktop-to-phone");

  companion object {
    fun parse(wire: String): Direction = values().firstOrNull { it.wire == wire } ?: error("Invalid stream direction")
  }
}

internal enum class Role { Desktop, Phone }

/**
 * Who may send which message once paired. The offerer is the device that shares its screen.
 * The direction-independent handshake (`pair`, `paired`) is not listed, so it is rejected
 * after the session is established.
 */
internal object SignalRoutes {
  private val table: Map<Direction, Map<Role, Set<String>>> = mapOf(
    Direction.PhoneToDesktop to mapOf(
      Role.Phone to setOf("offer", "candidate", "stop", "pause"),
      Role.Desktop to setOf("answer", "candidate", "stop"),
    ),
    Direction.DesktopToPhone to mapOf(
      Role.Phone to setOf("answer", "candidate", "stop"),
      Role.Desktop to setOf("offer", "candidate", "stop"),
    ),
  )

  fun canSend(direction: Direction, from: Role, type: String): Boolean = table.getValue(direction).getValue(from).contains(type)

  /** Exact JSON keys for each message type the desktop can send, including the `paired` handshake reply. */
  fun desktopFields(direction: Direction, type: String): Set<String> {
    val base = setOf("v", "sessionId", "type")
    return when {
      type == "paired" -> base
      !canSend(direction, Role.Desktop, type) -> error("Unexpected signaling message")
      type == "stop" -> base
      type == "offer" || type == "answer" -> base + "sdp"
      else -> base + setOf("candidate", "sdpMid", "sdpMLineIndex")
    }
  }
}

internal data class Invitation(val direction: Direction, val sessionId: String, val url: String, val token: String, val fingerprint: String) {
  companion object {
    fun parse(text: String): Invitation {
      require(text.toByteArray().size <= 2048) { "Invitation is too large" }
      val json = JSONObject(text)
      require(json.keys().asSequence().toSet() == setOf("v", "direction", "sessionId", "url", "token", "fingerprint", "expiresAt")) { "Invalid invitation fields" }
      val uri = URI(json.getString("url"))
      val now = System.currentTimeMillis()
      require(json.getInt("v") == 1 && json.getString("sessionId").matches(Regex("[a-f0-9]{32}")) &&
        json.getString("token").matches(Regex("[a-f0-9]{64}")) && json.getString("fingerprint").matches(Regex("[a-f0-9]{64}")) &&
        json.getLong("expiresAt") > now && json.getLong("expiresAt") <= now + 300_000 &&
        uri.scheme == "wss" && uri.port in 1..65535 && uri.path == "/" && uri.userInfo == null && uri.query == null && uri.fragment == null &&
        uri.host?.split('.')?.let { parts -> parts.size == 4 && parts.all { it.toIntOrNull() in 0..255 } } == true) { "Invalid or expired invitation. Create a new one on the desktop." }
      return Invitation(Direction.parse(json.getString("direction")), json.getString("sessionId"), uri.toString(), json.getString("token"), json.getString("fingerprint"))
    }
  }
}
