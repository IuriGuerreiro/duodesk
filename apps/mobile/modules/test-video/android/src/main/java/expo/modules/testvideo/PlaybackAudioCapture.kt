package expo.modules.testvideo

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.projection.MediaProjection
import android.os.Process
import androidx.annotation.RequiresApi
import java.nio.ByteBuffer
import java.util.concurrent.locks.LockSupport

internal const val PLAYBACK_SAMPLE_RATE = 48_000
internal const val PLAYBACK_CHANNELS = 2
internal const val PLAYBACK_BYTES_PER_FRAME = PLAYBACK_CHANNELS * 2
private const val MAX_SKEW_NS = 1_000_000_000L

/** What the sender reports about audio. Anything other than "active" means the stream is video-only or silent. */
internal object AudioStatus {
  const val OFF = "off"
  const val STARTING = "starting"
  const val ACTIVE = "active"
  const val DENIED = "denied"
  const val UNSUPPORTED = "unsupported"
  const val FAILED = "failed"
}

/** Returns the terminal status when audio must not be captured, or null when capture should be attempted. */
internal fun audioBlockedStatus(requested: Boolean, sdkInt: Int, recordPermissionGranted: Boolean): String? = when {
  !requested -> AudioStatus.OFF
  sdkInt < 29 -> AudioStatus.UNSUPPORTED
  !recordPermissionGranted -> AudioStatus.DENIED
  else -> null
}

/** Maps a frame index to the monotonic clock using one AudioRecord.getTimestamp anchor. */
internal fun frameCaptureTimeNs(anchorFrame: Long, anchorNs: Long, frame: Long, sampleRate: Int): Long =
  anchorNs + (frame - anchorFrame) * 1_000_000_000L / sampleRate

/**
 * Captures what other apps play (media, games, unknown usages) from the same MediaProjection that
 * owns the screen capture. It never records the microphone: the only AudioRecord is built from an
 * AudioPlaybackCaptureConfiguration.
 *
 * The WebRTC audio device module runs in "recordingless" mode and calls [readInto] every 10 ms from its
 * own audio thread. [readInto] blocks on the capture buffer, so this class also paces the WebRTC clock.
 */
@RequiresApi(29)
internal class PlaybackAudioCapture(
  projection: MediaProjection,
  private val onFailure: (String) -> Unit
) {
  private val lock = Any()
  private val timestamp = AudioTimestamp()
  private var scratch = ByteArray(0)
  private var framesRead = 0L
  private var failed = false

  @Volatile
  private var stopped = false

  @Volatile
  private var record: AudioRecord?

  init {
    val config = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
      .excludeUid(Process.myUid())
      .build()
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(PLAYBACK_SAMPLE_RATE)
      .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
      .build()
    val minimum = AudioRecord.getMinBufferSize(PLAYBACK_SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
    check(minimum > 0) { "Playback audio capture is not supported on this device" }
    val created = AudioRecord.Builder()
      .setAudioPlaybackCaptureConfig(config)
      .setAudioFormat(format)
      .setBufferSizeInBytes(maxOf(minimum * 2, PLAYBACK_SAMPLE_RATE / 5 * PLAYBACK_BYTES_PER_FRAME))
      .build()
    try {
      check(created.state == AudioRecord.STATE_INITIALIZED) { "Playback audio capture could not be initialized" }
      created.startRecording()
      check(created.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Playback audio capture did not start" }
    } catch (error: Exception) {
      runCatching { created.release() }
      throw error
    }
    record = created
  }

  /**
   * Fills [buffer] with [size] bytes of 48 kHz stereo PCM16 and returns its capture time on the monotonic
   * clock, or -1 when no real audio could be produced (the caller then supplies paced silence).
   */
  fun readInto(buffer: ByteBuffer, size: Int): Long {
    synchronized(lock) {
      val active = record ?: return -1
      if (stopped || size <= 0 || size % PLAYBACK_BYTES_PER_FRAME != 0) return -1
      if (scratch.size < size) scratch = ByteArray(size)
      var offset = 0
      while (offset < size) {
        if (stopped) return -1
        val count = active.read(scratch, offset, size - offset, AudioRecord.READ_BLOCKING)
        if (count < 0) {
          if (!stopped && !failed) {
            failed = true
            onFailure("Audio capture stopped unexpectedly (error $count). Video continues without sound.")
          }
          return -1
        }
        offset += count
      }
      buffer.clear()
      buffer.put(scratch, 0, size)
      buffer.clear()
      val frames = (size / PLAYBACK_BYTES_PER_FRAME).toLong()
      val chunkStart = framesRead
      framesRead += frames
      val now = System.nanoTime()
      val captured = if (active.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
        frameCaptureTimeNs(timestamp.framePosition, timestamp.nanoTime, chunkStart, PLAYBACK_SAMPLE_RATE)
      } else {
        now - frames * 1_000_000_000L / PLAYBACK_SAMPLE_RATE
      }
      return if (captured > now || now - captured > MAX_SKEW_NS) now else captured
    }
  }

  /** Safe from any thread and repeatable. Unblocks a pending read before releasing the AudioRecord. */
  fun stop() {
    if (stopped) return
    stopped = true
    // Stopping first wakes a blocked read; releasing during a read can abort the process.
    runCatching { record?.stop() }
    synchronized(lock) {
      runCatching { record?.release() }
      record = null
    }
  }
}

/** Paces silent 10 ms buffers at real time so the WebRTC audio clock keeps running without captured audio. */
internal class SilencePacer {
  @Volatile
  private var deadlineNs = 0L

  fun reset() {
    deadlineNs = 0L
  }

  fun fill(buffer: ByteBuffer, size: Int, sampleRate: Int, bytesPerFrame: Int): Long {
    val now = System.nanoTime()
    val step = size / bytesPerFrame * 1_000_000_000L / sampleRate
    if (deadlineNs == 0L || now - deadlineNs > 5 * step) deadlineNs = now
    deadlineNs += step
    val wait = deadlineNs - System.nanoTime()
    if (wait > 0) LockSupport.parkNanos(wait)
    buffer.clear()
    buffer.put(ByteArray(size))
    buffer.clear()
    return System.nanoTime()
  }
}
