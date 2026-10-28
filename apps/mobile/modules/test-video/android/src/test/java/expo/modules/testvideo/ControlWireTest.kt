package expo.modules.testvideo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlWireTest {
  private val session = "a".repeat(32)
  private fun tap(extra: String = "", x: String = "0.5", y: String = "0.25", epoch: String = "3", seq: String = "7", id: String = session) =
    """{"v":1,"sessionId":"$id","type":"tap","epoch":$epoch,"seq":$seq,"x":$x,"y":$y$extra}"""

  private fun swipe(points: String = "[[0.5,0.8],[0.5,0.2]]", duration: String = "300", extra: String = "") =
    """{"v":1,"sessionId":"$session","type":"swipe","epoch":1,"seq":2,"durationMs":$duration,"points":$points$extra}"""

  private fun refuses(text: String) {
    assertThrows(text, IllegalArgumentException::class.java) { ControlWire.parseCommand(text, session) }
  }

  @Test
  fun parsesTapAndSwipe() {
    assertEquals(ControlWire.Command.Tap(3, 7, 0.5, 0.25), ControlWire.parseCommand(tap(), session))
    val parsed = ControlWire.parseCommand(swipe(), session) as ControlWire.Command.Swipe
    assertEquals(300, parsed.durationMs)
    assertEquals(listOf(Pair(0.5, 0.8), Pair(0.5, 0.2)), parsed.points)
    // Edges of the display are valid.
    ControlWire.parseCommand(tap(x = "0", y = "1"), session)
  }

  @Test
  fun refusesWrongSessionVersionAndUnknownFields() {
    refuses(tap(id = "b".repeat(32)))
    refuses(tap().replace("\"v\":1", "\"v\":2"))
    refuses(tap(extra = ""","extra":1"""))
    refuses(tap().replace("\"type\":\"tap\"", "\"type\":\"key\""))
    refuses("not json")
    refuses("")
  }

  @Test
  fun refusesOutOfRangeAndWrongTypedNumbers() {
    refuses(tap(x = "1.0001"))
    refuses(tap(y = "-0.01"))
    refuses(tap(x = "\"0.5\""))
    refuses(tap(x = "null"))
    refuses(tap(seq = "0"))
    refuses(tap(seq = "1.5"))
    refuses(tap(epoch = "-1"))
    refuses(tap(seq = "2147483648"))
  }

  @Test
  fun boundsSwipeShapeAndDuration() {
    refuses(swipe(duration = "49"))
    refuses(swipe(duration = "2001"))
    refuses(swipe(duration = "100.5"))
    refuses(swipe(points = "[[0.1,0.1]]"))
    refuses(swipe(points = "[[0.1,0.1],[0.2]]"))
    refuses(swipe(points = "[[0.1,0.1],[0.2,1.2]]"))
    refuses(swipe(points = "\"none\""))
    refuses(swipe(extra = ""","x":0.5"""))
    val many = (0 until 33).joinToString(",", "[", "]") { "[0.${it % 10},0.5]" }
    refuses(swipe(points = many))
    val ok = (0 until 32).joinToString(",", "[", "]") { "[0.${it % 10},0.5]" }
    ControlWire.parseCommand(swipe(points = ok), session)
  }

  @Test
  fun refusesOversizedMessages() {
    refuses(tap(extra = ""","pad":"${"x".repeat(3000)}""""))
  }

  @Test
  fun writesStatusAndResultMessages() {
    val on = JSONObject(ControlWire.status(session, 4, Geometry(1080, 2400, 1), null))
    assertEquals("on", on.getString("state"))
    assertEquals(4, on.getInt("epoch"))
    assertEquals(1, on.getJSONObject("geometry").getInt("rotation"))
    assertEquals(setOf("v", "sessionId", "type", "epoch", "state", "geometry"), on.keys().asSequence().toSet())

    val off = JSONObject(ControlWire.status(session, 5, null, "service-disabled"))
    assertEquals(setOf("v", "sessionId", "type", "epoch", "state", "reason"), off.keys().asSequence().toSet())
    assertEquals("service-disabled", off.getString("reason"))

    val done = JSONObject(ControlWire.result(session, 4, 9, "done"))
    assertEquals(setOf("v", "sessionId", "type", "epoch", "seq", "status"), done.keys().asSequence().toSet())
    val rejected = JSONObject(ControlWire.result(session, 4, 9, "rejected", ControlWire.Rejection.STALE))
    assertEquals("stale", rejected.getString("reason"))
    assertTrue(rejected.has("reason"))
  }

  @Test
  fun parsesAndBoundsNavigation() {
    val nav = { action: String, extra: String -> """{"v":1,"sessionId":"$session","type":"nav","epoch":3,"seq":7,"action":$action$extra}""" }
    assertEquals(ControlWire.Command.Nav(3, 7, NavAction.HOME), ControlWire.parseCommand(nav("\"home\"", ""), session))
    refuses(nav("\"power\"", ""))
    refuses(nav("\"BACK\"", ""))
    refuses(nav("1", ""))
    refuses(nav("\"back\"", ",\"x\":0.5"))
    val caps = JSONObject(ControlWire.navCaps(session, 4, setOf(NavAction.RECENTS, NavAction.BACK)))
    assertEquals(setOf("v", "sessionId", "type", "epoch", "actions"), caps.keys().asSequence().toSet())
    assertEquals("nav-caps", caps.getString("type"))
    assertEquals("[\"back\",\"recents\"]", caps.getJSONArray("actions").toString())
  }

  private fun text(value: String) = JSONObject()
    .put("v", 1).put("sessionId", session).put("type", "text").put("epoch", 1).put("seq", 2).put("text", value)
    .toString()

  @Test
  fun parsesTextAndKeys() {
    for (value in listOf("a", "héllo\tworld\nline", "👍🏽 👨‍👩‍👧", "مرحبا", "x".repeat(500)))
      assertEquals(ControlWire.Command.Text(1, 2, value), ControlWire.parseCommand(text(value), session))
    for (key in ControlWire.Key.entries) {
      val json = """{"v":1,"sessionId":"$session","type":"key","epoch":1,"seq":2,"key":"${key.wire}"}"""
      assertEquals(ControlWire.Command.Press(1, 2, key), ControlWire.parseCommand(json, session))
    }
    // Typed text never appears in a command's string form.
    assertTrue(!ControlWire.Command.Text(1, 2, "secret").toString().contains("secret"))
  }

  @Test
  fun refusesUntypeableTextAndUnknownKeys() {
    for (value in listOf("", "x".repeat(501), "a\rb", "\u0000", "\u001b[A", "\u007f", "\u0085", "\ud83d", "a\ude00b"))
      refuses(text(value))
    refuses("""{"v":1,"sessionId":"$session","type":"text","epoch":1,"seq":2,"text":5}""")
    refuses("""{"v":1,"sessionId":"$session","type":"text","epoch":1,"seq":2,"text":"a","x":1}""")
    refuses("""{"v":1,"sessionId":"$session","type":"key","epoch":1,"seq":2,"key":"escape"}""")
  }

  @Test
  fun decodesOnlyWellFormedUtf8() {
    assertEquals("é👍", ControlWire.decodeUtf8("é👍".toByteArray(Charsets.UTF_8)))
    assertEquals(null, ControlWire.decodeUtf8(byteArrayOf(0x61, 0xff.toByte())))
    // An encoded lone surrogate (CESU style) is not UTF-8.
    assertEquals(null, ControlWire.decodeUtf8(byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0xbd.toByte())))
  }

  @Test
  fun writesCapsAndNoFieldResults() {
    val caps = JSONObject(ControlWire.caps(session, 5, true))
    assertEquals(setOf("v", "sessionId", "type", "epoch", "text"), caps.keys().asSequence().toSet())
    assertEquals("caps", caps.getString("type"))
    assertTrue(caps.getBoolean("text"))
    val result = JSONObject(ControlWire.result(session, 5, 3, "rejected", ControlWire.Rejection.NO_FIELD))
    assertEquals("nofield", result.getString("reason"))
  }
}
