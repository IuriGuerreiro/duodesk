package expo.modules.testvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer

class PlaybackAudioCaptureTest {
  @Test
  fun audioIsOnlyAttemptedWhenRequestedSupportedAndPermitted() {
    assertNull(audioBlockedStatus(requested = true, sdkInt = 29, recordPermissionGranted = true))
    assertNull(audioBlockedStatus(requested = true, sdkInt = 36, recordPermissionGranted = true))
  }

  @Test
  fun blockedAudioReportsWhyInsteadOfFallingBackToTheMicrophone() {
    assertEquals(AudioStatus.OFF, audioBlockedStatus(requested = false, sdkInt = 36, recordPermissionGranted = true))
    assertEquals(AudioStatus.UNSUPPORTED, audioBlockedStatus(requested = true, sdkInt = 28, recordPermissionGranted = true))
    assertEquals(AudioStatus.DENIED, audioBlockedStatus(requested = true, sdkInt = 34, recordPermissionGranted = false))
    // An unsupported OS is reported as such even when the permission is also missing.
    assertEquals(AudioStatus.UNSUPPORTED, audioBlockedStatus(requested = true, sdkInt = 24, recordPermissionGranted = false))
  }

  @Test
  fun frameTimesFollowTheAnchorOnTheMonotonicClock() {
    assertEquals(2_000_000_000L, frameCaptureTimeNs(anchorFrame = 4_800, anchorNs = 2_000_000_000L, frame = 4_800, sampleRate = 48_000))
    // 480 frames at 48 kHz are 10 ms.
    assertEquals(2_010_000_000L, frameCaptureTimeNs(4_800, 2_000_000_000L, 5_280, 48_000))
    assertEquals(1_990_000_000L, frameCaptureTimeNs(4_800, 2_000_000_000L, 4_320, 48_000))
  }

  @Test
  fun silenceIsPacedAndZeroed() {
    val pacer = SilencePacer()
    val buffer = ByteBuffer.allocate(1_920)
    buffer.put(ByteArray(1_920) { 7 })
    val start = System.nanoTime()
    repeat(5) { pacer.fill(buffer, 1_920, PLAYBACK_SAMPLE_RATE, PLAYBACK_BYTES_PER_FRAME) }
    val elapsedMs = (System.nanoTime() - start) / 1_000_000
    // Five 10 ms buffers take about 50 ms; allow scheduling slack but reject an unpaced busy loop.
    assert(elapsedMs in 35..200) { "elapsed $elapsedMs ms" }
    buffer.clear()
    assertEquals(0, buffer.get(0).toInt())
    assertEquals(0, buffer.get(1_919).toInt())
  }
}
