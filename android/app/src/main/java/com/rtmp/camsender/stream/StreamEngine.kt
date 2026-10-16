package com.rtmp.camsender.stream

import android.content.Context
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import com.rtmp.camsender.rtmp.FlvTag
import com.rtmp.camsender.rtmp.RtmpPublisher
import com.rtmp.camsender.rtmp.VideoCodec
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 把「相机 + 麦克风 → H.264/AAC → FLV → RTMP」整条链路串起来。
 *
 * 线程模型：
 *  - [start] 在内部子线程完成 RTMP 连接（阻塞数秒，禁止主线程网络 IO），随后编码/采集各自起线程；
 *  - 音视频回调来自编码器线程，直接投递到 [RtmpPublisher] 的发送队列；
 *  - 统计线程每秒回调一次码率/帧率。
 */
class StreamEngine(
    private val context: Context,
    private val config: StreamConfig,
    private val callback: Callback
) {

    interface Callback {
        fun onState(state: State, detail: String)
        fun onLog(message: String)
        fun onError(message: String)
        fun onStats(stats: Stats)
    }

    enum class State { IDLE, CONNECTING, LIVE, ERROR, STOPPED }

    data class Stats(
        val durationMs: Long = 0,
        val videoKbps: Int = 0,
        val audioKbps: Int = 0,
        val fps: Int = 0,
        val dropped: Long = 0,
        val queue: Int = 0
    )

    private val running = AtomicBoolean(false)
    private val failing = AtomicBoolean(false)

    private var publisher: RtmpPublisher? = null
    private var videoEncoder: VideoEncoder? = null
    private var audioEncoder: AudioEncoder? = null
    private var camera: CameraSource? = null
    private var glRenderer: GlRotateRenderer? = null
    private var statThread: Thread? = null
    private var reconnectThread: Thread? = null

    @Volatile private var previewSurface: Surface? = null
    @Volatile private var currentFacing: Int = config.lensFacing
    @Volatile private var cameraId: String = ""
    @Volatile private var cameraSize: Size = Size(config.width, config.height)
    @Volatile private var rotationDegrees: Int = 0
    @Volatile private var baseBootUs: Long = 0
    @Volatile private var startedAtMs: Long = 0
    @Volatile private var reconnectAttempts: Int = 0

    /** 计划使用的编码格式（可能被 VideoEncoder 因机型不支持而降级）。 */
    @Volatile private var plannedCodec: VideoCodec = VideoCodec.AVC

    /** 实际生效的编码格式。 */
    @Volatile private var actualCodecValue: VideoCodec = VideoCodec.AVC

    /** 编排后的实际帧率（可能被编码器上限夹过）。 */
    @Volatile private var effectiveFps: Int = config.fps

    @Volatile private var planNotes: List<String> = emptyList()

    // 时间戳锚点（先到的音频/视频各自锚在自己的起始时刻，保持相对间隔）
    private val tsLock = Any()
    private var videoAnchorMs = -1L
    private var firstVideoPtsUs = -1L
    private var lastVideoMs = 0L
    private var lastAudioMs = 0L

    // 统计
    @Volatile private var videoBytes = 0L
    @Volatile private var audioBytes = 0L
    @Volatile private var videoFrames = 0L

    val currentRotation: Int get() = rotationDegrees
    val currentCameraSize: Size get() = cameraSize
    val currentFps: Int get() = effectiveFps
    val codecInUse: VideoCodec get() = actualCodecValue
    val rtmpUrl: String get() = config.rtmpUrl
    val isLive: Boolean get() = running.get()

    init {
        currentFacing = config.lensFacing
    }

    // ------------------------------------------------------------------ public

    fun start(preview: Surface?) {
        previewSurface = preview
        failing.set(false)
        running.set(true)
        callback.onState(State.CONNECTING, "连接 ${config.host}:${config.port} …")

        cameraId = CameraSource.cameraIdFor(context, currentFacing)
            ?: CameraSource.cameraIdFor(context, CameraSource.otherFacing(currentFacing))
            ?: run {
                callback.onError("设备上没有可用摄像头")
                running.set(false)
                callback.onState(State.ERROR, "无可用摄像头")
                return
            }

        baseBootUs = SystemClock.elapsedRealtimeNanos() / 1000
        startedAtMs = SystemClock.elapsedRealtime()
        synchronized(tsLock) {
            videoAnchorMs = -1L
            firstVideoPtsUs = -1L
            lastVideoMs = 0L
            lastAudioMs = 0L
        }
        videoBytes = 0
        audioBytes = 0
        videoFrames = 0

        // RTMP 建连是阻塞网络 IO（Socket connect + 握手可达数秒），
        // 禁止在主线程执行，否则 Android 抛 NetworkOnMainThreadException。
        // 能力枚举（CameraManager + MediaCodecList）同样有几十到几百毫秒，
        // 一律放进这个后台线程；重连线程 / 切摄像头重启等所有调用方都走这里。
        Thread({
            if (!running.get()) return@Thread // start 期间被 stop 打断
            try {
                // 先按机身实际能力定下「分辨率 + 编码格式 + 帧率」
                val plan = planFor(cameraId)
                cameraSize = Size(plan.width, plan.height)
                plannedCodec = plan.codec
                actualCodecValue = plan.codec
                effectiveFps = plan.fps
                planNotes = plan.notes
                rotationDegrees =
                    resolveRotation(CameraSource.sensorOrientation(context, cameraId), config)

                val (outW, outH) = config.outputSize(rotationDegrees)
                callback.onLog(
                    "采集 ${cameraSize.width}x${cameraSize.height}@${effectiveFps}fps " +
                        "${config.videoBitrate / 1000}kbps ${plan.codec.displayName} " +
                        "旋转=$rotationDegrees 推流画幅=${outW}x$outH"
                )
                for (note in plan.notes) callback.onLog("· $note")

                val pub = RtmpPublisher(publisherListener)
                publisher = pub
                pub.connectAndPublish(config.host, config.port, config.app, config.streamKey)
            } catch (e: Throwable) {
                if (!running.get()) return@Thread // stop 引发的中断，静默收场
                callback.onError("RTMP 连接失败：${e.message ?: e.javaClass.simpleName}")
                teardown()
                running.set(false)
                callback.onState(State.ERROR, "连接失败")
                return@Thread
            }

            try {
                if (!running.get()) {
                    teardown()
                    return@Thread
                }
                // 先起编码器（拿到实际生效的编码格式 / 码率），再发 onMetaData，
                // 否则降级成 H.264 时元数据会写错编码 ID。
                startVideo()
                publishMetadata()
                startAudio()
                startCamera()
                startStats()
                reconnectAttempts = 0
                callback.onState(State.LIVE, config.rtmpUrl)
                callback.onLog("推流已上线（${actualCodecValue.displayName}）")
            } catch (e: Throwable) {
                callback.onError("启动采集失败：${e.message}")
                teardown()
                running.set(false)
                callback.onState(State.ERROR, "启动失败")
            }
        }, "stream-start").apply { isDaemon = true; start() }
    }

    /** 按摄像头实际能力编排「分辨率 + 编码格式 + 帧率」。 */
    private fun planFor(id: String): CodecCaps.Plan = CodecCaps.plan(
        cameraSizes = CameraSource.videoSizes(context, id),
        wantWidth = config.width,
        wantHeight = config.height,
        choice = config.codecChoice,
        wantFps = config.fps
    )

    fun setPreviewSurface(surface: Surface?) {
        previewSurface = surface
        camera?.setPreviewSurface(surface)
    }

    /** 前后摄像头切换；尺寸一致时只重启相机会话，不动编码器与 RTMP。 */
    fun switchCamera() {
        if (!running.get()) return
        val newFacing = CameraSource.otherFacing(currentFacing)
        val newId = CameraSource.cameraIdFor(context, newFacing)
        if (newId == null) {
            callback.onLog("没有另一个摄像头可切换")
            return
        }
        val plan = planFor(newId)
        val newSize = Size(plan.width, plan.height)
        currentFacing = newFacing
        if (newSize != cameraSize || plan.codec != actualCodecValue || plan.fps != effectiveFps) {
            callback.onLog(
                "切换摄像头（${cameraSize.width}x${cameraSize.height} " +
                    "${actualCodecValue.shortLabel} → ${plan.width}x${plan.height} " +
                    "${plan.codec.shortLabel}），重启编码链路…"
            )
            restart()
            return
        }
        callback.onLog("切换到摄像头 $newId")
        runCatching { camera?.stop() }
        camera = null
        cameraId = newId
        rotationDegrees = resolveRotation(CameraSource.sensorOrientation(context, newId), config)
        startCamera()
    }

    fun requestKeyFrame() {
        videoEncoder?.requestSyncFrame()
    }

    fun restart() {
        val surface = previewSurface
        teardown()
        running.set(false)
        start(surface)
    }

    fun stop() {
        running.set(false)
        teardown()
        callback.onState(State.STOPPED, "已停止")
    }

    // ---------------------------------------------------------------- rotation

    /**
     * 决定交给编码器的旋转角度。
     *  - 自动：跟随手机物理方向（横持→0/180，竖持→90/270）
     *  - 横屏：物理方向吸附到 90/270，输出始终是 width×height
     *  - 竖屏：物理方向吸附到 0/180，输出始终是 height×width
     */
    private fun resolveRotation(sensorOrientation: Int, cfg: StreamConfig): Int {
        cfg.manualRotation?.let { return ((it % 360) + 360) % 360 }

        var device = OrientationMonitor.lastOrientationDegrees
        when (cfg.orientationMode) {
            OrientationMode.AUTO -> Unit
            OrientationMode.LANDSCAPE -> if (device == 0 || device == 180) device = 90
            OrientationMode.PORTRAIT -> if (device == 90 || device == 270) device = 0
        }
        return ((sensorOrientation - device) % 360 + 360) % 360
    }

    // ------------------------------------------------------------------ pieces

    private fun publishMetadata() {
        val pub = publisher ?: return
        val (outW, outH) = config.outputSize(rotationDegrees)
        val codec = actualCodecValue
        val meta = FlvTag.metadata(
            width = outW,
            height = outH,
            fps = effectiveFps,
            videoKbps = effectiveVideoBitrate / 1000,
            audioKbps = config.audioBitrate / 1000,
            sampleRate = config.audioSampleRate,
            stereo = config.stereo,
            videoCodec = codec
        )
        pub.sendData(meta, 0)
        callback.onLog("已发送 onMetaData ${outW}x$outH ${codec.displayName}")
    }

    /** 编码器实际生效的码率（可能被机型允许范围夹过）。 */
    private val effectiveVideoBitrate: Int
        get() = videoEncoder?.effectiveBitrate ?: config.videoBitrate

    private fun startVideo() {
        val enc = VideoEncoder(
            videoCodec = plannedCodec,
            width = cameraSize.width,
            height = cameraSize.height,
            fps = effectiveFps,
            bitrate = config.videoBitrate,
            keyFrameIntervalSec = config.keyFrameIntervalSec,
            listener = object : VideoEncoder.Listener {
                override fun onLog(message: String) = callback.onLog(message)

                override fun onParamSets(codec: VideoCodec, nals: List<ByteArray>) {
                    actualCodecValue = codec
                    val payload = FlvTag.sequenceHeader(codec, nals)
                    if (payload == null) {
                        callback.onError(
                            "参数集不完整，无法生成 ${codec.displayName} 序列头" +
                                "（需要 " + (if (codec.enhanced) "VPS+SPS+PPS" else "SPS+PPS") + "）"
                        )
                        return
                    }
                    publisher?.sendVideo(payload, synchronized(tsLock) { lastVideoMs })
                    callback.onLog(
                        "已发送 ${codec.displayName} sequence header（" +
                            nals.joinToString(" + ") { "${it.size}B" } + "）"
                    )
                }

                override fun onFrame(
                    codec: VideoCodec,
                    payload: ByteArray,
                    ptsUs: Long,
                    keyFrame: Boolean
                ) {
                    val pub = publisher ?: return
                    val nowUs = SystemClock.elapsedRealtimeNanos() / 1000
                    val ms = synchronized(tsLock) {
                        if (firstVideoPtsUs < 0) {
                            firstVideoPtsUs = ptsUs
                            videoAnchorMs = ((nowUs - baseBootUs) / 1000).coerceAtLeast(0)
                        }
                        val v = (videoAnchorMs + (ptsUs - firstVideoPtsUs) / 1000).coerceAtLeast(lastVideoMs)
                        lastVideoMs = v
                        v
                    }
                    val tag = FlvTag.frame(codec, payload, keyFrame, 0)
                    pub.sendVideo(tag, ms)
                    videoBytes += tag.size
                    videoFrames++
                }

                override fun onError(message: String, cause: Throwable?) {
                    callback.onError(message)
                    handlePipelineFailure()
                }
            }
        )
        enc.start()
        videoEncoder = enc
        actualCodecValue = enc.codecInUse

        if (rotationDegrees == 0) {
            startCamera()
            return
        }

        // 旋转走 GL 渲染管线：物理旋转像素，不依赖编码器 KEY_ROTATION（部分机型会静默忽略）
        val outW = cameraSize.height
        val outH = cameraSize.width
        val renderer = GlRotateRenderer(
            encoderSurface = enc.surface,
            inWidth = cameraSize.width,
            inHeight = cameraSize.height,
            outWidth = outW,
            outHeight = outH,
            rotationDegrees = rotationDegrees,
            listener = object : GlRotateRenderer.Listener {
                override fun onLog(message: String) = callback.onLog(message)
                override fun onError(message: String, cause: Throwable?) {
                    callback.onError(message)
                    handlePipelineFailure()
                }
            }
        )
        renderer.start()
        glRenderer = renderer
        startCamera()
    }

    /** 相机输出应连接的目标面：有 GL 旋转管线时连管线的输入面，否则直连编码器。 */
    private fun cameraTargetSurface(): Surface {
        val enc = videoEncoder ?: error("视频编码器尚未启动")
        return glRenderer?.surface ?: enc.surface
    }

    private fun startAudio() {
        val enc = AudioEncoder(
            sampleRate = config.audioSampleRate,
            bitrate = config.audioBitrate,
            stereo = config.stereo,
            listener = object : AudioEncoder.Listener {
                override fun onLog(message: String) = callback.onLog(message)

                override fun onAsc(audioSpecificConfig: ByteArray) {
                    val payload = FlvTag.audioSequenceHeader(audioSpecificConfig)
                    publisher?.sendAudio(payload, synchronized(tsLock) { lastAudioMs })
                    callback.onLog("已发送 AAC sequence header（${audioSpecificConfig.size}B）")
                }

                override fun onFrame(aac: ByteArray, ptsUs: Long) {
                    val pub = publisher ?: return
                    val ms = synchronized(tsLock) {
                        val v = ((ptsUs - baseBootUs) / 1000).coerceAtLeast(lastAudioMs)
                        lastAudioMs = v
                        v
                    }
                    val payload = FlvTag.audioFrame(aac, 0, aac.size)
                    pub.sendAudio(payload, ms)
                    audioBytes += payload.size
                }

                override fun onError(message: String, cause: Throwable?) {
                    callback.onError(message)
                    handlePipelineFailure()
                }
            }
        )
        enc.start()
        audioEncoder = enc
    }

    private fun startCamera() {
        val cam = CameraSource(context, object : CameraSource.Listener {
            override fun onLog(message: String) = callback.onLog(message)
            override fun onStarted(id: String, sensorOrientation: Int, size: Size) = Unit
            override fun onError(message: String, cause: Throwable?) {
                callback.onError(message)
                handlePipelineFailure()
            }
        })
        camera = cam
        cam.start(cameraId, cameraTargetSurface(), previewSurface, cameraSize, effectiveFps)
    }

    private fun startStats() {
        val t = Thread({
            var prevVideo = 0L
            var prevAudio = 0L
            var prevFrames = 0L
            var prevTime = SystemClock.elapsedRealtime()
            while (running.get()) {
                try {
                    Thread.sleep(1000)
                } catch (e: InterruptedException) {
                    return@Thread
                }
                val now = SystemClock.elapsedRealtime()
                val elapsed = (now - prevTime).coerceAtLeast(1)
                val v = videoBytes
                val a = audioBytes
                val f = videoFrames
                val pub = publisher
                callback.onStats(
                    Stats(
                        durationMs = now - startedAtMs,
                        videoKbps = ((v - prevVideo) * 8 / elapsed).toInt(),
                        audioKbps = ((a - prevAudio) * 8 / elapsed).toInt(),
                        fps = ((f - prevFrames) * 1000 / elapsed).toInt(),
                        dropped = pub?.droppedPackets?.get() ?: 0,
                        queue = pub?.queueSize ?: 0
                    )
                )
                prevVideo = v
                prevAudio = a
                prevFrames = f
                prevTime = now
            }
        }, "stream-stats")
        t.isDaemon = true
        statThread = t
        t.start()
    }

    private val publisherListener = object : RtmpPublisher.Listener {
        override fun onLog(message: String) = callback.onLog(message)
        override fun onError(message: String, cause: Throwable?) {
            callback.onError(message)
            handlePipelineFailure()
        }

        override fun onClosed() {
            if (running.get()) {
                callback.onLog("RTMP 连接已关闭")
                handlePipelineFailure()
            }
        }
    }

    // ------------------------------------------------------------------ failure

    /** 链路任一处挂掉：有限次自动重连，仍失败则置 ERROR 并停流。 */
    private fun handlePipelineFailure() {
        if (!running.get()) return
        if (!failing.compareAndSet(false, true)) return

        reconnectAttempts++
        if (reconnectAttempts > MAX_RECONNECT) {
            callback.onError("连续 $MAX_RECONNECT 次重连失败，已停止推流（请确认导播台已启动且 1935 端口可达）")
            running.set(false)
            teardown()
            callback.onState(State.ERROR, "重连失败")
            return
        }
        callback.onLog("链路异常，${RECONNECT_DELAY_MS / 1000}s 后进行第 $reconnectAttempts 次重连…")

        val t = Thread({
            try {
                Thread.sleep(RECONNECT_DELAY_MS)
            } catch (e: InterruptedException) {
                return@Thread
            }
            if (!running.get()) {
                failing.set(false)
                return@Thread
            }
            val surface = previewSurface
            teardown()
            if (!running.get()) {
                failing.set(false)
                return@Thread
            }
            start(surface)
        }, "stream-reconnect")
        t.isDaemon = true
        reconnectThread = t
        t.start()
    }

    private fun teardown() {
        runCatching { statThread?.interrupt() }
        statThread = null
        runCatching { camera?.stop() }
        camera = null
        // GL 渲染器持有编码器输入面的 EGL 窗口，必须先于编码器释放
        runCatching { glRenderer?.release() }
        glRenderer = null
        runCatching { videoEncoder?.stop() }
        videoEncoder = null
        runCatching { audioEncoder?.stop() }
        audioEncoder = null
        runCatching { publisher?.close() }
        publisher = null
    }

    companion object {
        private const val MAX_RECONNECT = 5
        private const val RECONNECT_DELAY_MS = 1500L
    }
}
