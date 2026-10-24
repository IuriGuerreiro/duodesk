package expo.modules.testvideo

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory

internal class WebRtc(val factory: PeerConnectionFactory, val egl: EglBase)

/** Process initialization and EGL context shared by capture, the viewer and renderers.
 * The sender owns a separate factory for its playback-audio device module. */
internal object WebRtcFactory {
  private var instance: WebRtc? = null

  @Synchronized
  fun get(context: Context): WebRtc = instance ?: run {
    PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
    val egl = EglBase.create()
    val factory = PeerConnectionFactory.builder()
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext)).createPeerConnectionFactory()
    WebRtc(factory, egl).also { instance = it }
  }
}
