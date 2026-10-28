package expo.modules.testvideo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.CapturerObserver
import org.webrtc.VideoFrame

private class Sink : CapturerObserver {
  val stamps = mutableListOf<Long>()
  override fun onCapturerStarted(success: Boolean) {}
  override fun onCapturerStopped() {}
  override fun onFrameCaptured(frame: VideoFrame) { stamps.add(frame.timestampNs) }
}

/** A buffer the test never renders; only its identity travels through the relay. */
private class NoBuffer : VideoFrame.Buffer {
  override fun getWidth() = 2
  override fun getHeight() = 2
  override fun toI420(): VideoFrame.I420Buffer? = null
  override fun retain() {}
  override fun release() {}
  override fun cropAndScale(x: Int, y: Int, w: Int, h: Int, sw: Int, sh: Int): VideoFrame.Buffer = this
}

class IdleRefreshTest {
  private var now = 0L
  private val tasks = mutableListOf<Pair<Long, () -> Unit>>()
  private var forced = 0
  private val sink = Sink()
  private val frame = { ts: Long -> VideoFrame(NoBuffer(), 0, ts) }
  private lateinit var relay: IdleRefresh

  private fun make(interval: Long = 200) {
    relay = IdleRefresh(sink, interval, force = {
      forced++
      // forceFrame redelivers the last texture with its old timestamp.
      relay.onFrameCaptured(frame(1_000_000))
    }, schedule = { delay, task -> tasks.add(Pair(now + delay * 1_000_000, task)) }, nowNs = { now })
  }

  /** Moves the clock forward, running due tasks in order. */
  private fun advance(ms: Long) {
    val end = now + ms * 1_000_000
    while (true) {
      val next = tasks.minByOrNull { it.first } ?: break
      if (next.first > end) break
      tasks.remove(next); now = next.first; next.second()
    }
    now = end
  }

  @Test
  fun repeatsOnlyWhileIdleAndStampsEveryFrameLater() {
    make()
    relay.onCapturerStarted(true)
    now = 1_000_000; relay.onFrameCaptured(frame(1_000_000))
    advance(100)
    assertEquals(0, forced)
    advance(1000)
    assertTrue(forced in 4..5)
    assertTrue(sink.stamps.zipWithNext().all { (a, b) -> b > a })
    // Repeats do not count as screen changes.
    assertEquals(1L, relay.changedFrames)
  }

  @Test
  fun aBusyScreenIsNeverRepeated() {
    make()
    relay.onCapturerStarted(true)
    repeat(60) {
      advance(16)
      relay.onFrameCaptured(frame(now))
    }
    assertEquals(0, forced)
    assertEquals(60L, relay.changedFrames)
  }

  @Test
  fun stopsRepeatingAfterStop() {
    make()
    relay.onCapturerStarted(true)
    relay.stop()
    advance(2000)
    assertEquals(0, forced)
  }

  @Test
  fun intervalRespectsALowFrameRateCap() {
    assertEquals(200L, IdleRefresh.intervalFor(60))
    assertEquals(200L, IdleRefresh.intervalFor(5))
  }
}
