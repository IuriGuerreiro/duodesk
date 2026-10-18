package expo.modules.testvideo

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory

internal class WebRtc(val factory: PeerConnectionFactory, val egl: EglBase)

/** One factory and EGL context for the process, shared by the sender, the viewer and their renderers. */
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
