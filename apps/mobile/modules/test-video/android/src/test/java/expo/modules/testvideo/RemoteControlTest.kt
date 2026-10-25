package expo.modules.testvideo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records gestures and lets a test decide when, and how, each one finishes. */
private class FakeInjector(var accept: Boolean = true) : GestureInjector {
  val gestures = mutableListOf<Pair<List<Pair<Int, Int>>, Int>>()
  private var finish: ((GestureOutcome) -> Unit)? = null
  override fun dispatch(points: List<Pair<Int, Int>>, durationMs: Int, onDone: (GestureOutcome) -> Unit): Boolean {
    if (!accept) return false
    gestures.add(Pair(points, durationMs))
    finish = onDone
    return true
  }
  fun complete(outcome: GestureOutcome = GestureOutcome.DONE) = finish!!.invoke(outcome)
}

/** Records what would be typed, without an editor. */
private class FakeTypist(var field: Boolean = true) : TextInjector {
  val typed = mutableListOf<String>()
  var explode = false
  override fun commitText(text: String): TypingOutcome {
    if (explode) throw IllegalStateException("editor went away")
    if (!field) return TypingOutcome.NO_FIELD
    typed.add(text)
    return TypingOutcome.DONE
  }
  override fun press(key: ControlWire.Key): TypingOutcome {
    if (!field) return TypingOutcome.NO_FIELD
    typed.add("<${key.wire}>")
    return TypingOutcome.DONE
  }
}

class RemoteControlTest {
  private val session = "a".repeat(32)
  private val portrait = Geometry(1080, 2400, 0)
  private val landscape = Geometry(2400, 1080, 1)

  private inner class Rig(supported: Boolean = true, service: Boolean = true) {
    var injector: FakeInjector? = if (service) FakeInjector() else null
    var typist: FakeTypist? = if (service) FakeTypist() else null
    val sent = mutableListOf<JSONObject>()
    var changes = 0
    val control = RemoteControl(
      sessionId = session,
      supported = supported,
      injector = { injector },
      send = { sent.add(JSONObject(it)); true },
      post = { it() },
      changed = { changes++ },
      typist = { typist }
    )
    fun lastCaps() = sent.last { it.getString("type") == "caps" }
    fun text(epoch: Int, seq: Int, value: String = "hi") = control.onCommand(
      JSONObject().put("v", 1).put("sessionId", session).put("type", "text").put("epoch", epoch).put("seq", seq)
        .put("text", value).toString()
    )
    fun key(epoch: Int, seq: Int, key: String) = control.onCommand(
      """{"v":1,"sessionId":"$session","type":"key","epoch":$epoch,"seq":$seq,"key":"$key"}"""
    )

    fun lastStatus() = sent.last { it.getString("type") == "status" }
    fun lastResult() = sent.last { it.getString("type") == "result" }
    fun tap(epoch: Int, seq: Int, x: Double = 0.5, y: Double = 0.5) = control.onCommand(
      """{"v":1,"sessionId":"$session","type":"tap","epoch":$epoch,"seq":$seq,"x":$x,"y":$y}"""
    )
    fun swipe(epoch: Int, seq: Int, duration: Int = 300) = control.onCommand(
      """{"v":1,"sessionId":"$session","type":"swipe","epoch":$epoch,"seq":$seq,"durationMs":$duration,"points":[[0.5,0.8],[0.5,0.5],[0.5,0.2]]}"""
    )
    fun allowed(): Int {
      control.setGeometry(portrait)
      assertNull(control.allow())
      return control.snapshot().epoch
    }
  }

  @Test
  fun startsOffEvenWhenTheServiceIsEnabled() {
    val rig = Rig()
    rig.control.setGeometry(portrait)
    assertFalse(rig.control.snapshot().on)
    assertEquals(OffReason.NOT_ALLOWED, rig.control.snapshot().reason)
    assertTrue(rig.control.snapshot().serviceEnabled)
    rig.tap(rig.control.snapshot().epoch, 1)
    assertEquals("rejected", rig.lastResult().getString("status"))
    assertEquals("off", rig.lastResult().getString("reason"))
    assertTrue(rig.injector!!.gestures.isEmpty())
  }

  @Test
  fun explainsWhyAllowFails() {
    val noService = Rig(service = false)
    noService.control.setGeometry(portrait)
    assertNotNull(noService.control.allow())
    assertEquals(OffReason.SERVICE_DISABLED, noService.control.snapshot().reason)
    assertFalse(noService.control.snapshot().serviceEnabled)

    val noGeometry = Rig()
    assertNotNull(noGeometry.control.allow())
    assertFalse(noGeometry.control.snapshot().on)

    val clip = Rig(supported = false)
    clip.control.setGeometry(portrait)
    assertNotNull(clip.control.allow())
    assertEquals(OffReason.UNSUPPORTED, clip.control.snapshot().reason)
  }

  @Test
  fun allowTurnsControlOnAndReportsGeometry() {
    val rig = Rig()
    val epoch = rig.allowed()
    val status = rig.lastStatus()
    assertEquals("on", status.getString("state"))
    assertEquals(epoch, status.getInt("epoch"))
    assertEquals(1080, status.getJSONObject("geometry").getInt("width"))
  }

  @Test
  fun tapLandsOnTheMappedPixelAndReportsCompletion() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.tap(epoch, 1, 0.5, 0.25)
    val (points, duration) = rig.injector!!.gestures.single()
    assertEquals(listOf(Pair(540, 600)), points)
    assertEquals(RemoteControl.TAP_MS, duration)
    rig.injector!!.complete()
    assertEquals("done", rig.lastResult().getString("status"))
    assertEquals(1, rig.lastResult().getInt("seq"))
  }

  @Test
  fun displayEdgesStayInsideTheScreen() {
    assertEquals(Pair(0, 0), RemoteControl.pixel(0.0, 0.0, portrait))
    assertEquals(Pair(1079, 2399), RemoteControl.pixel(1.0, 1.0, portrait))
    assertEquals(Pair(2399, 0), RemoteControl.pixel(1.0, 0.0, landscape))
  }

  @Test
  fun swipeFollowsTheWholePath() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.swipe(epoch, 1, 400)
    val (points, duration) = rig.injector!!.gestures.single()
    assertEquals(listOf(Pair(540, 1919), Pair(540, 1200), Pair(540, 480)), points)
    assertEquals(400, duration)
  }

  @Test
  fun cancelledGestureIsReportedAsCancelled() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.tap(epoch, 1)
    rig.injector!!.complete(GestureOutcome.CANCELLED)
    assertEquals("cancelled", rig.lastResult().getString("status"))
  }

  @Test
  fun refusedGestureIsReportedAsFailedAndDoesNotBlockTheNext() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.injector!!.accept = false
    rig.tap(epoch, 1)
    assertEquals("failed", rig.lastResult().getString("status"))
    rig.injector!!.accept = true
    rig.tap(epoch, 2)
    assertEquals(1, rig.injector!!.gestures.size)
  }

  @Test
  fun oneGestureAtATimeAndNothingIsQueued() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.tap(epoch, 1)
    rig.tap(epoch, 2)
    assertEquals("busy", rig.lastResult().getString("reason"))
    rig.injector!!.complete()
    // The refused command is gone for good; it does not run after the first one finishes.
    assertEquals(1, rig.injector!!.gestures.size)
    rig.tap(epoch, 3)
    assertEquals(2, rig.injector!!.gestures.size)
  }

  @Test
  fun replayedAndOldSequenceNumbersAreRefused() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.tap(epoch, 5)
    rig.injector!!.complete()
    rig.tap(epoch, 5)
    assertEquals("stale", rig.lastResult().getString("reason"))
    rig.tap(epoch, 4)
    assertEquals("stale", rig.lastResult().getString("reason"))
    assertEquals(1, rig.injector!!.gestures.size)
  }

  @Test
  fun malformedCommandsDoNothing() {
    val rig = Rig()
    rig.allowed()
    val before = rig.sent.size
    rig.control.onCommand("garbage")
    rig.control.onCommand("""{"v":1,"sessionId":"${"b".repeat(32)}","type":"tap","epoch":1,"seq":1,"x":0.5,"y":0.5}""")
    rig.control.onCommand("""{"v":1,"sessionId":"$session","type":"tap","epoch":1,"seq":1,"x":9,"y":0.5}""")
    assertEquals(before, rig.sent.size)
    assertTrue(rig.injector!!.gestures.isEmpty())
  }

  @Test
  fun revokeStopsInputAtOnceAndOldCommandsStayRefused() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.control.revoke()
    assertEquals("off", rig.lastStatus().getString("state"))
    assertEquals("revoked", rig.lastStatus().getString("reason"))
    rig.tap(epoch, 1)
    assertTrue(rig.injector!!.gestures.isEmpty())
    // Allowing again starts a new epoch, so a command made for the old grant cannot ride on it.
    assertNull(rig.control.allow())
    rig.tap(epoch, 2)
    assertEquals("stale", rig.lastResult().getString("reason"))
    assertTrue(rig.injector!!.gestures.isEmpty())
  }

  @Test
  fun rotationStartsANewEpochAndRefusesCommandsForTheOldShape() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.control.setGeometry(landscape)
    val next = rig.control.snapshot().epoch
    assertTrue(next > epoch)
    assertEquals(2400, rig.lastStatus().getJSONObject("geometry").getInt("width"))
    rig.tap(epoch, 1)
    assertEquals("stale", rig.lastResult().getString("reason"))
    assertTrue(rig.injector!!.gestures.isEmpty())
    rig.tap(next, 2, 1.0, 0.0)
    assertEquals(listOf(Pair(2399, 0)), rig.injector!!.gestures.single().first)
  }

  @Test
  fun unchangedGeometryDoesNotInvalidateCommands() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.control.setGeometry(Geometry(1080, 2400, 0))
    assertEquals(epoch, rig.control.snapshot().epoch)
  }

  @Test
  fun reportsUnknownGeometryBeforeTheScreenSizeArrives() {
    val rig = Rig()
    assertEquals(OffReason.GEOMETRY_UNKNOWN, rig.control.snapshot().reason)
    rig.control.setGeometry(portrait)
    assertEquals(OffReason.NOT_ALLOWED, rig.control.snapshot().reason)
  }

  @Test
  fun unknownGeometryTurnsControlOffUntilAllowedAgain() {
    val rig = Rig()
    rig.allowed()
    rig.control.setGeometry(null)
    assertFalse(rig.control.snapshot().on)
    assertEquals(OffReason.GEOMETRY_UNKNOWN, rig.control.snapshot().reason)
    rig.control.setGeometry(portrait)
    assertFalse("a known size alone must not bring control back", rig.control.snapshot().on)
    assertEquals(OffReason.NOT_ALLOWED, rig.control.snapshot().reason)
  }

  @Test
  fun disablingTheServiceRevokesAndReenablingDoesNotResume() {
    val rig = Rig()
    val epoch = rig.allowed()
    val service = rig.injector
    rig.injector = null
    rig.control.serviceChanged()
    assertEquals("service-disabled", rig.lastStatus().getString("reason"))
    rig.tap(epoch, 1)
    assertTrue(service!!.gestures.isEmpty())
    rig.injector = service
    rig.control.serviceChanged()
    assertFalse(rig.control.snapshot().on)
    assertTrue(rig.control.snapshot().serviceEnabled)
  }

  @Test
  fun closingTheSessionEndsControlForGood() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.control.close()
    assertFalse(rig.control.snapshot().on)
    val before = rig.sent.size
    rig.tap(epoch, 1)
    rig.control.publish()
    assertEquals(before, rig.sent.size)
    assertTrue(rig.injector!!.gestures.isEmpty())
    assertNotNull(rig.control.allow())
  }

  @Test
  fun lateGestureResultAfterRevokeIsStillReportedHonestly() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.swipe(epoch, 1)
    rig.control.revoke()
    rig.injector!!.complete()
    assertEquals("done", rig.lastResult().getString("status"))
    // Revoked state is not overwritten by the late result.
    assertFalse(rig.control.snapshot().on)
  }

  @Test
  fun heartbeatRepeatsTheSameEpoch() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.control.publish()
    rig.control.publish()
    val statuses = rig.sent.filter { it.getString("type") == "status" }
    assertEquals(epoch, statuses.last().getInt("epoch"))
    assertEquals(statuses[statuses.size - 1].toString(), statuses[statuses.size - 2].toString())
  }

  @Test
  fun capsFollowEveryStatusAndAdvertiseTextOnlyWhileOnWithATypist() {
    val rig = Rig()
    rig.control.setGeometry(portrait)
    rig.control.publish()
    assertFalse("off", rig.lastCaps().getBoolean("text"))
    val epoch = rig.allowed()
    assertTrue(rig.lastCaps().getBoolean("text"))
    assertEquals(epoch, rig.lastCaps().getInt("epoch"))
    // Pre Android 13, or the input method flag not yet granted.
    rig.typist = null
    rig.control.publish()
    assertFalse(rig.lastCaps().getBoolean("text"))
    rig.typist = FakeTypist()
    rig.control.revoke()
    assertFalse(rig.lastCaps().getBoolean("text"))
    assertEquals(rig.control.snapshot().epoch, rig.lastCaps().getInt("epoch"))
  }

  @Test
  fun typesOnlyWhileAllowedForTheCurrentEpoch() {
    val rig = Rig()
    rig.control.setGeometry(portrait)
    rig.text(rig.control.snapshot().epoch, 1)
    assertEquals("off", rig.lastResult().getString("reason"))
    val epoch = rig.allowed()
    rig.text(epoch - 1, 2)
    assertEquals("stale", rig.lastResult().getString("reason"))
    rig.text(epoch, 3, "héllo 👍")
    assertEquals("done", rig.lastResult().getString("status"))
    rig.text(epoch, 3, "again")
    assertEquals("stale", rig.lastResult().getString("reason"))
    rig.key(epoch, 4, "backspace")
    rig.key(epoch, 5, "enter")
    assertEquals(listOf("héllo 👍", "<backspace>", "<enter>"), rig.typist!!.typed)
    rig.control.revoke()
    rig.text(epoch, 6)
    assertEquals("rejected", rig.lastResult().getString("status"))
    assertEquals(3, rig.typist!!.typed.size)
    // Results never echo the text.
    assertTrue(rig.sent.none { it.toString().contains("héllo") })
  }

  @Test
  fun reportsNoFieldFailureAndBusy() {
    val rig = Rig()
    val epoch = rig.allowed()
    rig.typist!!.field = false
    rig.text(epoch, 1)
    assertEquals("nofield", rig.lastResult().getString("reason"))
    rig.typist!!.field = true
    rig.typist!!.explode = true
    rig.text(epoch, 2)
    assertEquals("failed", rig.lastResult().getString("status"))
    rig.typist!!.explode = false
    // A gesture in flight blocks typing: one command at a time.
    rig.tap(epoch, 3)
    rig.text(epoch, 4)
    assertEquals("busy", rig.lastResult().getString("reason"))
    rig.injector!!.complete()
    rig.text(epoch, 5)
    assertEquals("done", rig.lastResult().getString("status"))
    rig.typist = null
    rig.key(epoch, 6, "delete")
    assertEquals("off", rig.lastResult().getString("reason"))
  }

  @Test
  fun enterFollowsTheFieldsDeclaredAction() {
    val text = 0x1
    val multiLine = text or 0x20000
    val search = 0x3
    val noEnterAction = 0x40000000
    assertEquals(EnterPlan.Action(search), EnterPlan.of(text, search))
    assertEquals(EnterPlan.NewLine, EnterPlan.of(multiLine, search or noEnterAction))
    assertEquals(EnterPlan.NewLine, EnterPlan.of(multiLine, 0))
    assertEquals(EnterPlan.Key, EnterPlan.of(text, 0))
    assertEquals(EnterPlan.Key, EnterPlan.of(text, 0x1))
    assertEquals(EnterPlan.Key, EnterPlan.of(text, search or noEnterAction))
    // Not a text class: the multi-line bit means nothing.
    assertEquals(EnterPlan.Key, EnterPlan.of(0x2 or 0x20000, 0))
  }
}
