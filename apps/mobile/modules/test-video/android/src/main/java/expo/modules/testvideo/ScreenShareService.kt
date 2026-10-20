package expo.modules.testvideo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Android only allows screen capture while a visible mediaProjection foreground service runs. */
class ScreenShareService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
    val notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("DuoDesk is sharing your screen")
      .setContentText("Stop from the DuoDesk app.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
      startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    else startForeground(ID, notification)
    ready?.invoke(); ready = null
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL = "duodesk-screen-share"
    private const val ID = 4201
    private var ready: (() -> Unit)? = null

    /** Starts the service and calls [onReady] once it is in the foreground, as getMediaProjection requires. */
    fun start(context: Context, onReady: () -> Unit) {
      ready = onReady
      context.startForegroundService(Intent(context, ScreenShareService::class.java))
    }
    fun stop(context: Context) { context.stopService(Intent(context, ScreenShareService::class.java)) }
  }
}
