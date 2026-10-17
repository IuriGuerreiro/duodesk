package expo.modules.testvideo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build

/** Keeps capture alive while another app is visible. Never restarts without new consent. */
class ScreenCaptureService : Service() {
  @Volatile internal var onStopped: (() -> Unit)? = null
  private var stopped = false
  @Synchronized private fun markStopped() {
    if (stopped) return
    stopped = true
    onStopped?.invoke()
  }
  @Synchronized internal fun startCapture(onStop: () -> Unit, start: () -> Unit) {
    check(!stopped) { "Screen sharing service has stopped. Start a new session." }
    onStopped = onStop
    promote()
    start()
  }
  private fun finish() { markStopped(); stopSelf() }
  private val screenOff = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { finish() }
  }
  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
    else registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
  }
  inner class LocalBinder : Binder() { val service get() = this@ScreenCaptureService }
  override fun onBind(intent: Intent) = LocalBinder()
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) {
      finish()
    } else {
      try { synchronized(this) { if (!stopped) promote() } } catch (error: Exception) { finish() }
    }
    return START_NOT_STICKY
  }
  private fun promote() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, 1, Intent(this, ScreenCaptureService::class.java).setAction(STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 2, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    val notification = builder.setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle("DuoDesk is sharing your screen")
      .setContentText("Tap Stop to end screen sharing.")
      .setContentIntent(open).setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    else startForeground(1001, notification)
  }
  override fun onTaskRemoved(rootIntent: Intent?) { finish() }
  override fun onDestroy() {
    unregisterReceiver(screenOff)
    markStopped(); onStopped = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  companion object {
    private const val CHANNEL = "duodesk-screen"
    private const val STOP = "expo.modules.testvideo.STOP_SCREEN"
  }
}
