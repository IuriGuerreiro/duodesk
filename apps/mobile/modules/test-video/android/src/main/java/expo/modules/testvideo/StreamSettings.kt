package expo.modules.testvideo

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build

/**
 * The sender's chosen picture box (long side × short side, following the capture's orientation) and frame-rate
 * cap. Mirrors `StreamSettings` in `@duodesk/protocol`; the limits must stay in step with `STREAM_LIMITS`.
 */
internal data class StreamSettings(val maxLongSide: Int, val maxShortSide: Int, val frameRate: Int) {
  /** Returns why these values are unusable, or `null` when they are inside every sender's limits. */
  fun problem(): String? = when {
    maxLongSide !in MIN_LONG..MAX_LONG -> "Width must be from $MIN_LONG to $MAX_LONG pixels."
    maxShortSide !in MIN_SHORT..MAX_SHORT -> "Height must be from $MIN_SHORT to $MAX_SHORT pixels."
    maxShortSide > maxLongSide -> "Height cannot be larger than width. Enter the long side as the width; portrait screens are rotated to match."
    frameRate !in MIN_FPS..MAX_FPS -> "Frame rate must be from $MIN_FPS to $MAX_FPS fps."
    else -> null
  }

  fun toMap(): Map<String, Any> = mapOf("maxLongSide" to maxLongSide, "maxShortSide" to maxShortSide, "frameRate" to frameRate)

  companion object {
    const val MIN_LONG = 320
    const val MAX_LONG = 3840
    const val MIN_SHORT = 240
    const val MAX_SHORT = 2160
    const val MIN_FPS = 5
    /** Android screen capture renders at most once per display refresh, and WebRTC's capturer path is tuned for 60. */
    const val MAX_FPS = 60
    val DEFAULT = StreamSettings(1920, 1080, 60)
  }
}

/** Answers whether an encoder can take `width` × `height` at `fps`; `null` means the device gave no answer. */
internal typealias EncoderCheck = (width: Int, height: Int, fps: Int) -> Boolean?

/**
 * Explains why the capture the settings produce for this display cannot be encoded, or `null` if it can.
 * The display can rotate mid-stream, so both orientations must be encodable.
 */
internal fun encoderProblem(display: Geometry?, settings: StreamSettings, supports: EncoderCheck): String? {
  val dims = if (display != null) {
    computeCaptureDimensions(display.width, display.height, settings.maxLongSide, settings.maxShortSide)
  } else {
    computeCaptureDimensions(0, 0, settings.maxLongSide, settings.maxShortSide)
  }
  for ((w, h) in listOf(dims.width to dims.height, dims.height to dims.width)) {
    if (supports(w, h, settings.frameRate) == false) {
      return "This phone's video encoder cannot send ${dims.width} × ${dims.height} at ${settings.frameRate} fps. Choose a smaller size or frame rate."
    }
  }
  return null
}

/**
 * Asks Android's hardware H.264 encoders, which WebRTC uses for this stream. Returns `null` when the device lists
 * none, so the sender's own "no H.264 encoder" check (and the emulator VP8 fallback) still decides.
 * https://developer.android.com/reference/android/media/MediaCodecInfo.VideoCapabilities#areSizeAndRateSupported(int,%20int,%20double)
 */
internal val hardwareAvcCheck: EncoderCheck = { width, height, fps ->
  val encoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { info ->
    info.isEncoder && MediaFormat.MIMETYPE_VIDEO_AVC in info.supportedTypes.map { it.lowercase() } && isHardware(info)
  }
  if (encoders.isEmpty()) null
  else encoders.any { info ->
    runCatching { info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities?.areSizeAndRateSupported(width, height, fps.toDouble()) == true }
      .getOrDefault(false)
  }
}

private fun isHardware(info: MediaCodecInfo): Boolean =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated
  else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android.")
