package expo.modules.testvideo

import org.webrtc.CapturerObserver
import org.webrtc.VideoFrame

/**
 * Screen capture only produces a frame when the display changes, so a still screen sends nothing. After a pause
 * the first new frame then arrives at a cold link and viewer, which shows up as lag. This sits between the
 * capturer and WebRTC and, while the screen is idle, asks for the last frame again at a low rate.
 *
 * Repeats come from `SurfaceTextureHelper.forceFrame`, so the picture stays on the GPU. That call reuses the
 * texture's timestamp, which the encoder would drop as a duplicate, so every frame leaving here is stamped
 * strictly later than the previous one.
 *
 * All methods run on the capture texture thread.
 */
internal class IdleRefresh(
  private val downstream: CapturerObserver,
  /** Gap between repeats while idle. Kept at or above the user's frame interval. */
  private val intervalMs: Long,
  private val force: () -> Unit,
  private val schedule: (delayMs: Long, task: () -> Unit) -> Unit,
  private val nowNs: () -> Long = System::nanoTime
) : CapturerObserver {
  @Volatile
  private var running = false
  private var lastFrameNs = 0L
  private var lastStampNs = Long.MIN_VALUE
  private var forced = false
  /** Frames caused by real screen changes, for the "screen idle" status. Repeats are not counted. */
  @Volatile
  var changedFrames = 0L
    private set

  override fun onCapturerStarted(success: Boolean) {
    downstream.onCapturerStarted(success)
    if (!success || running) return
    running = true
    lastFrameNs = nowNs()
    tick()
  }

  override fun onCapturerStopped() {
    running = false
    downstream.onCapturerStopped()
  }

  /** Stops repeats without waiting for the capturer to report it stopped. */
  fun stop() {
    running = false
  }

  override fun onFrameCaptured(frame: VideoFrame) {
    if (forced) forced = false else changedFrames++
    lastFrameNs = nowNs()
    val stamp = if (frame.timestampNs > lastStampNs) frame.timestampNs else maxOf(lastFrameNs, lastStampNs + 1_000_000)
    lastStampNs = stamp
    if (stamp == frame.timestampNs) {
      downstream.onFrameCaptured(frame)
    } else {
      // The new frame shares the buffer; the caller still owns and releases the original.
      downstream.onFrameCaptured(VideoFrame(frame.buffer, frame.rotation, stamp))
    }
  }

  private fun tick() {
    if (!running) return
    val idleMs = (nowNs() - lastFrameNs) / 1_000_000
    if (idleMs >= intervalMs) {
      forced = true
      force()
      schedule(intervalMs) { tick() }
    } else {
      schedule(intervalMs - idleMs) { tick() }
    }
  }

  companion object {
    /** About 5 repeats a second while idle, or fewer if the user chose a lower frame rate. */
    fun intervalFor(frameRate: Int): Long = maxOf(200L, 1000L / frameRate)
  }
}
