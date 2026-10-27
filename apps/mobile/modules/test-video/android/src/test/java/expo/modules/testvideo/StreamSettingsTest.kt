package expo.modules.testvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamSettingsTest {
  @Test
  fun acceptsCustomValuesInsideTheLimits() {
    assertNull(StreamSettings(1600, 900, 45).problem())
    assertNull(StreamSettings.DEFAULT.problem())
  }

  @Test
  fun rejectsOutOfRangeAndSwappedValues() {
    assertTrue(StreamSettings(5000, 1080, 30).problem()!!.startsWith("Width"))
    assertTrue(StreamSettings(1920, 100, 30).problem()!!.startsWith("Height must"))
    assertTrue(StreamSettings(720, 1280, 30).problem()!!.contains("cannot be larger"))
    assertTrue(StreamSettings(1920, 1080, 120).problem()!!.startsWith("Frame rate"))
    assertTrue(StreamSettings(1920, 1080, 1).problem()!!.startsWith("Frame rate"))
  }

  @Test
  fun customBoxFollowsTheDisplayOrientationWithoutDistortion() {
    // Same values as `fitCapture` in the protocol package tests.
    assertEquals(CaptureDimensions(576, 1280), computeCaptureDimensions(1080, 2400, 1280, 720))
    assertEquals(CaptureDimensions(1280, 576), computeCaptureDimensions(2400, 1080, 1280, 720))
    assertEquals(CaptureDimensions(1280, 720), computeCaptureDimensions(1280, 720, 3840, 2160))
  }

  @Test
  fun encoderCheckCoversBothOrientationsAndExplainsTheRefusal() {
    val asked = mutableListOf<Triple<Int, Int, Int>>()
    val landscapeOnly: EncoderCheck = { w, h, fps -> asked.add(Triple(w, h, fps)); w >= h }
    val problem = encoderProblem(Geometry(1080, 2400, 0), StreamSettings(1280, 720, 30), landscapeOnly)
    assertNotNull(problem)
    assertTrue(problem!!.contains("576 × 1280 at 30 fps"))
    assertEquals(Triple(576, 1280, 30), asked.first())

    assertNull(encoderProblem(Geometry(1080, 2400, 0), StreamSettings(1280, 720, 30)) { _, _, _ -> true })
    // A device that cannot answer does not block the stream; the sender's H.264 check still applies.
    assertNull(encoderProblem(Geometry(1080, 2400, 0), StreamSettings(1280, 720, 30)) { _, _, _ -> null })
  }

  @Test
  fun aTapOnTheDownscaledPictureLandsOnTheSameDisplayPixel() {
    val display = Geometry(1080, 2400, 0)
    val video = computeCaptureDimensions(display.width, display.height, 1280, 720)
    // The viewer normalizes against the picture it shows, then the phone maps onto the real display.
    val (x, y) = RemoteControl.pixel(288.0 / (video.width - 1), 640.0 / (video.height - 1), display)
    assertTrue(kotlin.math.abs(x - 540) <= 1)
    assertTrue(kotlin.math.abs(y - 1200) <= 1)
    assertEquals(Pair(1079, 2399), RemoteControl.pixel(1.0, 1.0, display))
  }
}
