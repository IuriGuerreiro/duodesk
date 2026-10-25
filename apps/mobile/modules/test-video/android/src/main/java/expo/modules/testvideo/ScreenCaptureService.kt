package expo.modules.testvideo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat

class ScreenCaptureService : Service() {
  companion object {
    const val ACTION_START = "expo.modules.testvideo.action.START"
    const val ACTION_STOP = "expo.modules.testvideo.action.STOP"
    const val ACTION_STOP_CONTROL = "expo.modules.testvideo.action.STOP_CONTROL"
    const val EXTRA_SESSION_ID = "expo.modules.testvideo.extra.SESSION_ID"
    private const val CHANNEL_ID = "duodesk_screen_capture"
    private const val NOTIFICATION_ID = 4040

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    private var isStarting: Boolean = false

    @Volatile
    private var isStopping: Boolean = false

    @Volatile
    private var activeSessionId: Long = 0L

    @Volatile
    private var onForegroundedCallback: (() -> Unit)? = null

    private val lock = Any()

    @Volatile
    private var controlActive: Boolean = false

    @Volatile
    private var instance: ScreenCaptureService? = null

    /** The phone owner must always be able to see, and end, a PC controlling the phone from the notification. */
    fun setControlActive(active: Boolean) {
      if (controlActive == active) return
      controlActive = active
      instance?.refreshNotification()
    }

    fun start(context: Context, sessionId: Long, onForegrounded: () -> Unit) {
      synchronized(lock) {
        if (isRunning && activeSessionId == sessionId) {
          onForegrounded()
          return
        }
        activeSessionId = sessionId
        isStarting = true
        isStopping = false
        onForegroundedCallback = onForegrounded
      }
      val intent = Intent(context, ScreenCaptureService::class.java).apply {
        action = ACTION_START
        putExtra(EXTRA_SESSION_ID, sessionId)
      }
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context, sessionId: Long? = null) {
      synchronized(lock) {
        if (sessionId != null && sessionId != activeSessionId) {
          return
        }
        onForegroundedCallback = null
        if (!isRunning && !isStarting) {
          return
        }
        isRunning = false
        isStarting = false
        isStopping = true
      }
      try {
        context.stopService(Intent(context, ScreenCaptureService::class.java))
      } catch (_: Exception) {}
    }
  }

  private var instanceSessionId: Long = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    instance = this
  }

  private fun refreshNotification() {
    if (!isRunning) return
    getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification(instanceSessionId))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val intentSessionId = intent?.getLongExtra(EXTRA_SESSION_ID, 0L) ?: 0L

    if (intent?.action == ACTION_STOP_CONTROL) {
      synchronized(lock) {
        if (intentSessionId != 0L && intentSessionId != activeSessionId) return START_NOT_STICKY
      }
      VideoSenderManager.revokeControl()
      return START_NOT_STICKY
    }

    if (intent?.action == ACTION_STOP) {
      synchronized(lock) {
        if (intentSessionId != 0L && intentSessionId != activeSessionId) {
          return START_NOT_STICKY
        }
        isRunning = false
        isStarting = false
        isStopping = true
        onForegroundedCallback = null
      }
      VideoSenderManager.stop()
      stopForegroundService()
      stopSelf()
      return START_NOT_STICKY
    }

    if (intent?.action != ACTION_START) {
      stopForegroundService()
      stopSelf()
      return START_NOT_STICKY
    }

    val callback: (() -> Unit)?
    synchronized(lock) {
      if (intentSessionId != 0L && intentSessionId != activeSessionId) {
        stopForegroundService()
        stopSelf()
        return START_NOT_STICKY
      }
      instanceSessionId = intentSessionId
      isRunning = true
      isStarting = false
      callback = onForegroundedCallback
      onForegroundedCallback = null
    }

    val notification = buildNotification(instanceSessionId)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    callback?.invoke()

    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    controlActive = false
    val notifyManager: Boolean
    synchronized(lock) {
      if (instanceSessionId != 0L && instanceSessionId != activeSessionId) {
        notifyManager = false
      } else {
        val wasRunning = isRunning
        val wasStopping = isStopping
        isRunning = false
        isStarting = false
        isStopping = false
        onForegroundedCallback = null
        notifyManager = wasRunning && !wasStopping
      }
    }
    stopForegroundService()
    if (notifyManager) {
      VideoSenderManager.onServiceDestroyed()
    }
    super.onDestroy()
  }

  private fun stopForegroundService() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "DuoDesk Screen Sharing",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Persistent notification while screen sharing to Windows receiver"
      }
      val manager = getSystemService(NotificationManager::class.java)
      manager?.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(sessionId: Long = 0L): Notification {
    val stopIntent = Intent(this, ScreenCaptureService::class.java).apply {
      action = ACTION_STOP
      if (sessionId != 0L) {
        putExtra(EXTRA_SESSION_ID, sessionId)
      }
    }
    val stopPendingIntent = PendingIntent.getService(
      this,
      0,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    val iconRes = if (applicationInfo.icon != 0) applicationInfo.icon else android.R.drawable.ic_menu_share
    builder
      .setContentTitle("DuoDesk")
      .setContentText(
        if (controlActive) "Your PC can tap, swipe and type on this phone" else "Sharing screen with Windows receiver"
      )
      .setSmallIcon(iconRes)
      .setOngoing(true)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val action = Notification.Action.Builder(
        Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
        "Stop",
        stopPendingIntent
      ).build()
      builder.addAction(action)
    } else {
      @Suppress("DEPRECATION")
      builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
    }

    if (controlActive) {
      val stopControl = Intent(this, ScreenCaptureService::class.java).apply {
        action = ACTION_STOP_CONTROL
        if (sessionId != 0L) putExtra(EXTRA_SESSION_ID, sessionId)
      }
      builder.addAction(
        Notification.Action.Builder(
          Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
          "Stop control",
          PendingIntent.getService(this, 1, stopControl, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        ).build()
      )
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    if (launchIntent != null) {
      val contentPendingIntent = PendingIntent.getActivity(
        this,
        0,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      builder.setContentIntent(contentPendingIntent)
    }

    return builder.build()
  }
}
