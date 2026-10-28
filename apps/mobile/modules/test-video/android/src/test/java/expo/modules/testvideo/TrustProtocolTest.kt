package expo.modules.testvideo

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.math.BigInteger
import java.security.*
import java.security.spec.*

class TrustProtocolTest {
  private val vectors get() = JSONObject(requireNotNull(javaClass.classLoader?.getResourceAsStream("trust-v1.json")).bufferedReader().readText())
  @Test fun sharedCanonicalVectorsVerifyAndRejectOtherTranscripts() {
    val v = vectors; val d = v.getJSONObject("desktop"); val p = v.getJSONObject("phone"); val e = v.getJSONObject("enroll"); val r = v.getJSONObject("reconnect")
    assertEquals(d.getString("fingerprint"), TrustCrypto.hash(TrustCrypto.bytes(d.getString("publicKey"))))
    assertEquals(d.getString("publicKey"), TrustCrypto.point(TrustCrypto.publicKey(d.getString("publicKey")) as java.security.interfaces.ECPublicKey))
    assertTrue(TrustCrypto.verify(d.getString("publicKey"), e.getString("desktopTranscript"), e.getString("desktopSignature")))
    assertTrue(TrustCrypto.verify(p.getString("publicKey"), e.getString("phoneTranscript"), e.getString("phoneSignature")))
    assertTrue(TrustCrypto.verify(p.getString("publicKey"), r.getString("transcript"), r.getString("phoneSignature")))
    assertFalse(TrustCrypto.verify(d.getString("publicKey"), e.getString("phoneTranscript"), e.getString("desktopSignature")))
    assertFalse(TrustCrypto.verify(p.getString("publicKey"), r.getString("transcript") + "x", r.getString("phoneSignature")))
  }
  @Test fun enrollmentStaysPendingUntilSavedAndRefusesReplay() {
    val v = vectors; val e = v.getJSONObject("enroll"); val phone = v.getJSONObject("phone")
    val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    val private = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(phone.getString("privateScalar"), 16), params))
    val identity = object : TrustSigningIdentity {
      override val publicKey = phone.getString("publicKey")
      override fun sign(text: String) = Signature.getInstance("SHA256withECDSA").run { initSign(private); update(text.toByteArray()); TrustCrypto.hex(sign()) }
    }
    val messages = mutableListOf<JSONObject>(); val saved = mutableListOf<Boolean>(); val events = mutableListOf<Map<String, Any?>>()
    val invitation = Invitation(Direction.PhoneToDesktop, e.getString("sessionId"), "wss://192.168.1.2:12345/", v.getString("token"), e.getString("certificateFingerprint"))
    val enrollment = TrustEnrollment(identity, invitation, { messages.add(it); true }, { _, _, active -> saved.add(active) }, {}, { events.add(it) })
    // Desktop starts; approval signs the actual nonce, not the fixture nonce.
    fun message(type: String) = JSONObject().put("v", 1).put("type", type).put("sessionId", invitation.sessionId)
    enrollment.receive(message("enroll_request").put("key", e.getString("desktopKey")).put("nonce", e.getString("desktopNonce")).put("name", "Desk"))
    assertTrue(saved.isEmpty()); enrollment.action("approve", "My PC"); assertTrue(saved.isEmpty())
    // A valid signature from another exchange must not be accepted.
    enrollment.receive(message("enroll_confirm").put("signature", e.getString("desktopSignature")))
    assertTrue(saved.isEmpty()); assertEquals("failed", events.last()["state"])
    assertEquals("enroll_cancel", messages.last().getString("type"))
    enrollment.receive(message("enroll_request").put("key", e.getString("desktopKey")).put("nonce", e.getString("desktopNonce")).put("name", "Desk"))
    enrollment.action("approve", "My PC")
    val accepted = messages.last()
    val transcript = listOf("duodesk-enroll-v1", "desktop", invitation.sessionId, invitation.fingerprint,
      TrustCrypto.hash(TrustCrypto.bytes(invitation.token)), e.getString("desktopKey"), identity.publicKey, e.getString("desktopNonce"), accepted.getString("nonce")).joinToString("\n")
    val desktopPrivate = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(v.getJSONObject("desktop").getString("privateScalar"), 16), params))
    val signature = Signature.getInstance("SHA256withECDSA").run { initSign(desktopPrivate); update(transcript.toByteArray()); TrustCrypto.hex(sign()) }
    enrollment.receive(message("enroll_confirm").put("signature", signature))
    assertEquals(listOf(false), saved)
    enrollment.receive(message("enroll_saved"))
    assertEquals(listOf(false, true), saved)
    enrollment.receive(message("enroll_saved"))
    assertEquals(listOf(false, true), saved)
  }
  @Test fun rememberedAddressesArePrivateLanOnly() {
    assertTrue(TrustManager.lan("192.168.1.2:12345")); assertTrue(TrustManager.lan("169.254.1.2:1234"))
    for (value in listOf("example.com:1234", "127.0.0.1:1234", "8.8.8.8:1234", "100.64.1.2:1234", "192.168.1.2:0", "192.168.1.2:1234/path")) assertFalse(value, TrustManager.lan(value))
  }
}
