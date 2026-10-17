package expo.modules.testvideo

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.EglBase
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import java.util.concurrent.locks.LockSupport

/** Decode into GPU textures, pace by clip timestamps, and drop late frames. */
internal class ClipSource(
  private val context: Context,
  private val eglContext: EglBase.Context,
  private val observer: CapturerObserver,
  private val onFailure: (String) -> Unit
) {
  @Volatile private var running = false
  private var worker: Thread? = null

  fun start() {
    check(worker == null) { "Clip already running" }
    running = true
    worker = Thread({ decode() }, "duodesk-clip").apply { start() }
  }

  fun stop() {
    running = false
    worker?.interrupt()
    worker?.join()
    worker = null
  }

  private fun decode() {
    var extractor: MediaExtractor? = null
    var codec: MediaCodec? = null
    var helper: SurfaceTextureHelper? = null
    var surface: Surface? = null
    var started = false
    try {
      extractor = MediaExtractor()
      context.assets.openFd("test-pattern.mp4").use {
        extractor.setDataSource(it.fileDescriptor, it.startOffset, it.length)
      }
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
      } ?: error("Test clip has no video track")
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      helper = checkNotNull(SurfaceTextureHelper.create("duodesk-textures", eglContext))
      helper.setTextureSize(format.getInteger(MediaFormat.KEY_WIDTH), format.getInteger(MediaFormat.KEY_HEIGHT))
      helper.startListening { frame ->
        // Surface timestamps reset when looping; WebRTC requires monotonic capture timestamps.
        if (running) observer.onFrameCaptured(VideoFrame(frame.buffer, frame.rotation, System.nanoTime()))
      }
      surface = Surface(helper.surfaceTexture)
      codec = MediaCodec.createDecoderByType(checkNotNull(format.getString(MediaFormat.KEY_MIME)))
      codec.configure(format, surface, null, 0)
      codec.start()
      started = true
      observer.onCapturerStarted(true)
      val info = MediaCodec.BufferInfo()
      var inputEnded = false
      var epoch = System.nanoTime()
      var firstPts: Long? = null
      while (running && !Thread.currentThread().isInterrupted) {
        if (!inputEnded) {
          val input = codec.dequeueInputBuffer(10_000)
          if (input >= 0) {
            val buffer = checkNotNull(codec.getInputBuffer(input))
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) {
              codec.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputEnded = true
            } else {
              codec.queueInputBuffer(input, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        val output = codec.dequeueOutputBuffer(info, 10_000)
        if (output >= 0) {
          if (info.size > 0) {
            if (firstPts == null) { firstPts = info.presentationTimeUs; epoch = System.nanoTime() }
            val deadline = epoch + (info.presentationTimeUs - firstPts) * 1000
            while (running && System.nanoTime() < deadline && !Thread.currentThread().isInterrupted) {
              LockSupport.parkNanos(minOf(deadline - System.nanoTime(), 10_000_000L))
            }
            codec.releaseOutputBuffer(output, running && System.nanoTime() - deadline < 100_000_000L)
          } else codec.releaseOutputBuffer(output, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 && running) {
            extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
            codec.flush()
            inputEnded = false
            firstPts = null
          }
        }
      }
    } catch (error: Exception) {
      if (running) onFailure("Test clip decoding failed: ${error.message}")
    } finally {
      running = false
      if (started) { runCatching { codec?.stop() }; observer.onCapturerStopped() }
      runCatching { codec?.release() }
      runCatching { extractor?.release() }
      runCatching { surface?.release() }
      runCatching { helper?.stopListening(); helper?.dispose() }
    }
  }
}
