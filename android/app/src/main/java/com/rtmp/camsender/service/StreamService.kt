package com.rtmp.camsender.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.view.Surface
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.rtmp.camsender.MainActivity
import com.rtmp.camsender.Prefs
import com.rtmp.camsender.R
import com.rtmp.camsender.stream.StreamConfig
import com.rtmp.camsender.stream.StreamEngine
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 推流前台服务。
 *
 * 相机/麦克风在后台被系统限制，必须挂前台服务才能息屏继续推流。
 * 界面通过 [uiListener]（同进程静态引用）接收状态与日志。
 */
class StreamService : Service(), StreamEngine.Callback {

    interface Listener {
        fun onState(state: StreamEngine.State, detail: String)
        fun onLog(message: String)
        fun onError(message: String)
        fun onStats(stats: StreamEngine.Stats)
    }

    companion object {
        const val ACTION_STOP = "com.rtmp.camsender.action.STOP"
        const val ACTION_SWITCH_CAMERA = "com.rtmp.camsender.action.SWITCH"

        private const val CHANNEL_ID = "rtmp_stream"
        private const val NOTIFICATION_ID = 4711

        @Volatile
        var instance: StreamService? = null
            private set

        @Volatile
        var uiListener: Listener? = null

        /** 界面线程放进来、由服务接手的资源。 */
        @Volatile
        var pendingConfig: StreamConfig? = null

        @Volatile
        var pendingPreview: Surface? = null

        fun start(context: Context, config: StreamConfig, preview: Surface?) {
            instance?.stopStream()
            pendingConfig = config
            pendingPreview = preview
            // 记录“用户要求推流”：进程被系统杀掉后服务重启时据此自动恢复
            Prefs(context.applicationContext).autoResume = true
            val intent = Intent(context, StreamService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun requestStop(context: Context) {
            context.startService(Intent(context, StreamService::class.java).setAction(ACTION_STOP))
        }

        fun requestSwitchCamera(context: Context) {
            context.startService(
                Intent(context, StreamService::class.java).setAction(ACTION_SWITCH_CAMERA)
            )
        }
    }

    private var engine: StreamEngine? = null
    private var currentConfig: StreamConfig? = null
    private var foreground = false

    // 长时间推流必须自己抓住 CPU 和 Wi-Fi：否则息屏/Doze 后编码器停摆，
    // 服务端 12 秒收不到包就判定无画面，现场看起来就是“推一会儿自己掉”。
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "camsender:stream").also {
                it.setReferenceCounted(false)
                runCatching { it.acquire() }
            }
        }
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "camsender:wifi").also {
                it.setReferenceCounted(false)
                runCatching { it.acquire() }
            }
        }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wifiLock = null
    }

    /** 当前链路状态，供界面重新进入时对齐 UI。 */
    @Volatile
    var lastState: StreamEngine.State = StreamEngine.State.IDLE
        private set

    /** 实际生效的采集尺寸与旋转角（相机不支持预设尺寸时会自动就近选择）。 */
    val cameraSize: android.util.Size? get() = engine?.currentCameraSize
    val currentRotation: Int get() = engine?.currentRotation ?: 0

    /** 界面重进时可以把历史日志补上。 */
    val logs = CopyOnWriteArrayList<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // intent == null：进程被系统回收后由 START_STICKY 自动拉起。
        // 如果用户之前没有主动停止，就用上次的设置自动恢复推流。
        if (intent == null && engine == null) {
            val prefs = Prefs(applicationContext)
            val saved = if (prefs.autoResume) prefs.toConfig() else null
            if (saved == null) {
                // 用户已经手动停止（或配置不完整）：不要留在后台空转
                stopSelf()
                return START_NOT_STICKY
            }
            startForegroundCompat("正在推流 · ${saved.streamKey}")
            currentConfig = saved
            val e = StreamEngine(applicationContext, saved, this)
            engine = e
            acquireLocks()
            pushLog("进程被系统回收，已按上次设置自动恢复推流：${saved.rtmpUrl}")
            e.start(null)
            return START_STICKY
        }

        when (intent?.action) {
            ACTION_STOP -> {
                stopStream()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SWITCH_CAMERA -> {
                engine?.switchCamera()
                return START_STICKY
            }
        }

        val config = pendingConfig ?: currentConfig
        if (config == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (engine != null && currentConfig == config) {
            // 服务已在推流，仅更新预览面
            engine?.setPreviewSurface(pendingPreview)
            return START_STICKY
        }

        startForegroundCompat("正在推流 · ${config.streamKey}")
        currentConfig = config
        val e = StreamEngine(applicationContext, config, this)
        engine = e
        acquireLocks()
        pushLog("服务已启动，配置：${config.rtmpUrl}")
        e.start(pendingPreview)
        return START_STICKY
    }

    fun setPreviewSurface(surface: Surface?) {
        pendingPreview = surface
        engine?.setPreviewSurface(surface)
    }

    fun switchCamera() {
        engine?.switchCamera()
    }

    fun stopStream() {
        // 用户主动停止：取消自动恢复，否则服务被系统重启后又会自己推起来
        Prefs(applicationContext).autoResume = false
        releaseLocks()
        engine?.stop()
        engine = null
        currentConfig = null
        pendingConfig = null
        pendingPreview = null
        if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foreground = false
        }
        pushLog("推流已停止")
    }

    override fun onDestroy() {
        releaseLocks()
        engine?.stop()
        engine = null
        instance = null
        super.onDestroy()
    }

    // ------------------------------------------------------------- engine 回调

    override fun onState(state: StreamEngine.State, detail: String) {
        lastState = state
        pushLog("状态：$state $detail")
        if (state == StreamEngine.State.LIVE) {
            updateNotification("正在推流 · $detail")
        }
        uiListener?.onState(state, detail)
    }

    override fun onLog(message: String) {
        pushLog(message)
        uiListener?.onLog(message)
    }

    override fun onError(message: String) {
        pushLog("错误：$message")
        uiListener?.onError(message)
    }

    override fun onStats(stats: StreamEngine.Stats) {
        uiListener?.onStats(stats)
    }

    // ------------------------------------------------------------------ 通知

    private fun pushLog(message: String) {
        val line = "[${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())}] $message"
        logs.add(line)
        while (logs.size > 300) logs.removeAt(0)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, StreamService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_stream)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "停止推流", stop)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startForegroundCompat(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        foreground = true
    }

    private fun updateNotification(text: String) {
        if (!foreground) return
        runCatching {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(text))
        }
    }
}
