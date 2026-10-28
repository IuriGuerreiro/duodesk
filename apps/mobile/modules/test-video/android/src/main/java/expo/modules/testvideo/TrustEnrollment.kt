package expo.modules.testvideo

import org.json.JSONObject

/** Enrollment belongs to one pinned, authenticated, consumed-token session. */
internal class TrustEnrollment(
  private val identity: TrustSigningIdentity,
  private val invitation: Invitation,
  private val send: (JSONObject) -> Boolean,
  private val save: (String, String, Boolean) -> Unit,
  private val discard: (String) -> Unit,
  private val event: (Map<String, Any?>) -> Unit,
  private val ownName: String = "DuoDesk phone",
  private val onTimeout: (TrustEnrollment, Int) -> Unit = { enrollment, ticket -> enrollment.expire(ticket) },
) {
  private var phase = "idle"
  private var generation = 0
  private var desktop = ""
  private var dn = ""
  private var pn = ""
  private var peerName = "PC"
  private var label = ""
  private var attempts = 0
  private var timeout: java.util.TimerTask? = null
  private fun emit(state: String) = event(mapOf("type" to "enroll", "state" to state, "peerName" to peerName))
  private fun message(type: String) = JSONObject().put("type", "enroll_$type")
  private fun transcript(role: String) = listOf("duodesk-enroll-v1", role, invitation.sessionId, invitation.fingerprint,
    TrustCrypto.hash(TrustCrypto.bytes(invitation.token)), desktop, identity.publicKey, dn, pn).joinToString("\n")
  fun action(action: String, name: String) {
    label = TrustCrypto.name(name)
    when (action) {
      "start" -> {
        check(phase == "idle" && attempts++ < 3) { "Remember request already open. Pair again to retry." }
        pn = TrustCrypto.nonce(); phase = "requested"; arm()
        check(send(message("request").put("key", identity.publicKey).put("nonce", pn).put("name", ownName)))
        emit("requested")
      }
      "approve" -> {
        check(phase == "incoming"); pn = TrustCrypto.nonce(); phase = "accepted"
        check(send(message("accept").put("key", identity.publicKey).put("nonce", pn).put("name", ownName).put("signature", identity.sign(transcript("phone")))))
        emit("verifying")
      }
      "reject", "cancel" -> cancel()
      else -> error("Invalid remember action")
    }
  }
  private fun arm() {
    timeout?.cancel()
    val ticket = ++generation
    timeout = object : java.util.TimerTask() { override fun run() { onTimeout(this@TrustEnrollment, ticket) } }
    timer.schedule(timeout, 120_000)
  }
  fun receive(v: JSONObject) {
    try {
      val kind = v.getString("type")
      val fields = when (kind) {
        "enroll_request" -> arrayOf("key", "nonce", "name")
        "enroll_accept" -> arrayOf("key", "nonce", "name", "signature")
        "enroll_confirm" -> arrayOf("signature")
        "enroll_saved", "enroll_cancel" -> emptyArray()
        else -> error("Invalid enrollment message")
      }
      TrustCrypto.exact(v, kind, "sessionId", *fields)
      require(v.getString("sessionId") == invitation.sessionId)
      when (kind) {
        "enroll_request" -> {
          check(phase == "idle" && attempts++ < 3)
          desktop = v.getString("key"); TrustCrypto.publicKey(desktop)
          dn = v.getString("nonce"); require(dn.matches(Regex("[a-f0-9]{64}")))
          peerName = TrustCrypto.name(v.getString("name")); phase = "incoming"; arm(); emit("incoming")
        }
        "enroll_accept" -> {
          check(phase == "requested"); desktop = v.getString("key"); TrustCrypto.publicKey(desktop)
          dn = v.getString("nonce"); require(dn.matches(Regex("[a-f0-9]{64}")))
          peerName = TrustCrypto.name(v.getString("name"))
          check(TrustCrypto.verify(desktop, transcript("desktop"), v.getString("signature"))) { "PC identity could not be verified. Pair again." }
          save(desktop, label.ifEmpty { peerName }, false); phase = "confirmed"
          check(send(message("confirm").put("signature", identity.sign(transcript("phone")))))
        }
        "enroll_confirm" -> {
          check(phase == "accepted" && TrustCrypto.verify(desktop, transcript("desktop"), v.getString("signature")))
          save(desktop, label.ifEmpty { peerName }, false); phase = "confirmed"; check(send(message("saved")))
        }
        "enroll_saved" -> {
          if (phase == "done") return
          check(phase == "confirmed"); save(desktop, label.ifEmpty { peerName }, true)
          phase = "done"; timeout?.cancel(); check(send(message("saved"))); emit("saved")
        }
        "enroll_cancel" -> if (phase != "done") { discard(desktop); phase = "idle"; timeout?.cancel(); emit("cancelled") }
      }
    } catch (_: Exception) { cancel(); emit("failed") }
  }
  fun expire(ticket: Int) { if (generation == ticket && phase != "done") cancel() }
  fun cancel() {
    generation++
    timeout?.cancel()
    if (phase != "done") { discard(desktop); send(message("cancel")); phase = "idle" }
    emit("cancelled")
  }
  companion object { private val timer = java.util.Timer("DuoDesk enrollment timeout", true) }
}
