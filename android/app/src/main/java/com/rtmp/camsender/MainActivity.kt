package com.rtmp.camsender

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Bundle
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.rtmp.camsender.databinding.ActivityMainBinding
import com.rtmp.camsender.net.ServerProbe
import com.rtmp.camsender.rtmp.VideoCodec
import com.rtmp.camsender.service.StreamService
import com.rtmp.camsender.stream.CameraSource
import com.rtmp.camsender.stream.CodecCaps
import com.rtmp.camsender.stream.OrientationMode
import com.rtmp.camsender.stream.OrientationMonitor
import com.rtmp.camsender.stream.StreamEngine
import com.rtmp.camsender.stream.StreamPresets
import kotlinx.coroutines.launch
import kotlin.math.min

class MainActivity : AppCompatActivity(), StreamService.Listener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs
    private lateinit var orientation: OrientationMonitor

    private var previewSurface: Surface? = null
    private var previewTexture: SurfaceTexture? = null
    private var streaming = false
    private var lastLogAt = 0L
    private val logLines = ArrayDeque<String>()

    /** 按机身实际能力枚举出的可选分辨率（后台线程生成）。 */
    private var resolutions: List<CodecCaps.Resolution> = emptyList()

    /** 当前参数编排结果（分辨率 + 编码格式 + 帧率），与 StreamEngine 用的同一套规则。 */
    private var plan: CodecCaps.Plan? = null

    private var scanning = false

    private val permissionRequestCode = 1001

    private val requiredPermissions: Array<String>
        get() {
            val list = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                list.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            return list.toTypedArray()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = Prefs(this)
        orientation = OrientationMonitor(this)

        setupSpinners()
        setupPreview()
        setupButtons()

        binding.etServer.setText(prefs.host)
        binding.etStreamKey.setText(prefs.streamKey.ifBlank { Prefs.defaultStreamKey() })
        binding.tvServerStatus.text = "等待探测…"
        refreshUrlPreview()
        updatePreviewLayout()
    }

    override fun onResume() {
        super.onResume()
        StreamService.uiListener = this
        orientation.enable()
        StreamService.instance?.logs?.forEach { appendLog(it, push = false) }
        renderLog()

        val svc = StreamService.instance
        streaming = svc != null && svc.lastState == StreamEngine.State.LIVE
        setUiStreaming(streaming, svc?.lastState ?: StreamEngine.State.IDLE)
        StreamingFlags.screenOn(this, streaming)
        if (streaming) attachPreviewSurface()
    }

    override fun onPause() {
        super.onPause()
        if (StreamService.uiListener === this) StreamService.uiListener = null
        orientation.disable()
        // 界面不可见时撤掉预览面，让相机会话只保留编码输出（息屏也能继续推流）
        if (streaming) StreamService.instance?.setPreviewSurface(null)
    }

    override fun onDestroy() {
        if (streaming) StreamService.instance?.setPreviewSurface(null)
        previewSurface?.let { s -> android.os.Handler(mainLooper).postDelayed({ runCatching { s.release() } }, 400) }
        previewSurface = null
        previewTexture = null
        StreamingFlags.screenOn(this, false)
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 权限

    private fun hasPermissions(): Boolean = requiredPermissions.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestPermissions() {
        requestPermissions(requiredPermissions, permissionRequestCode)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != permissionRequestCode) return
        if (hasPermissions()) startStream() else toast("缺少相机或麦克风权限，无法推流")
    }

    // ------------------------------------------------------------------ UI 初始化

    private fun setupSpinners() {
        fun bind(view: Spinner, labels: List<String>, index: Int, onPick: (Int) -> Unit) {
            view.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
            view.setSelection(index)
            view.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: View?, position: Int, id: Long) = onPick(position)
                override fun onNothingSelected(p: AdapterView<*>?) = Unit
            }
        }

        // 分辨率列表要问相机与硬编码器（MediaCodecList 枚举 + 尺寸交集），
        // 主线程做会有明显卡顿，所以先占位、后台枚举完再填充。
        binding.spResolution.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, listOf("检测中…")
        )
        binding.spResolution.isEnabled = false
        binding.spResolution.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, position: Int, id: Long) {
                val res = resolutions.getOrNull(position) ?: return
                // 已经是当前请求值就别动（refreshCapabilities 同步选中项时也会走到这里，
                // 不能把刚算好的编排结果清掉）
                if (prefs.resWidth == res.width && prefs.resHeight == res.height) return
                prefs.resWidth = res.width
                prefs.resHeight = res.height
                plan = null
                updatePreviewLayout()
            }

            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }

        bind(binding.spCodec, StreamPresets.codecLabels, prefs.codecIndex) {
            prefs.codecIndex = it
            plan = null
            updatePreviewLayout()
            // 换编码格式会改变可行的分辨率/帧率上限，重新编排
            refreshCapabilities()
        }
        bind(binding.spFps, StreamPresets.fpsOptions.map { "$it fps" }, prefs.fpsIndex) {
            prefs.fpsIndex = it
            plan = null
            updatePreviewLayout()
            refreshCapabilities()
        }
        bind(binding.spVideoBitrate, StreamPresets.videoBitrates.map { it.label }, prefs.videoBitrateIndex) {
            prefs.videoBitrateIndex = it; updatePreviewLayout()
        }
        bind(binding.spAudio, StreamPresets.audioOptions.map { it.label }, prefs.audioIndex) {
            prefs.audioIndex = it; updatePreviewLayout()
        }
        bind(binding.spOrientation, StreamPresets.orientationLabels, prefs.orientationIndex) {
            prefs.orientationIndex = it; updatePreviewLayout()
        }
        bind(binding.spCamera, StreamPresets.cameraLabels, prefs.cameraIndex) {
            prefs.cameraIndex = it
            plan = null
            // 前后摄的能力完全不同，切镜头要重新枚举分辨率
            refreshCapabilities()
        }

        binding.btnRescan.setOnClickListener { refreshCapabilities() }
        refreshCapabilities()
    }

    /** 后台枚举「相机输出 × 硬编码器支持」，刷新分辨率下拉框与能力提示。 */
    private fun refreshCapabilities() {
        if (scanning) return
        scanning = true
        binding.tvCapability.text = "正在读取相机与编码器能力…"
        val facing = if (prefs.cameraIndex == 0) {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
        } else {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
        }
        val wantFps = StreamPresets.fps(prefs.fpsIndex)
        val choice = StreamPresets.codecChoice(prefs.codecIndex)
        val wantW = prefs.resWidth
        val wantH = prefs.resHeight

        Thread({
            val cameraId = CameraSource.cameraIdFor(this, facing)
            val sizes = cameraId?.let { CameraSource.videoSizes(this, it) } ?: emptyList()
            val list = CodecCaps.buildResolutions(sizes, only = null, fps = wantFps)
            val planned = CodecCaps.plan(sizes, wantW, wantH, choice, wantFps)
            val avc = CodecCaps.info(VideoCodec.AVC)
            val hevc = CodecCaps.info(VideoCodec.HEVC)
            runOnUiThread {
                scanning = false
                resolutions = list
                plan = planned
                val labels = if (list.isEmpty()) {
                    listOf("无可用分辨率")
                } else {
                    list.map { it.label }
                }
                binding.spResolution.adapter = ArrayAdapter(
                    this, android.R.layout.simple_spinner_dropdown_item, labels
                )
                binding.spResolution.isEnabled = list.isNotEmpty()
                // 下拉框选中「请求的尺寸」；若该尺寸在这台机器上不存在（相机没有这个输出档），
                // 就退到编排结果并把它写回设置，保证「显示 = 实际」。
                var index = list.indexOfFirst { it.width == wantW && it.height == wantH }
                if (index < 0) {
                    index = list.indexOfFirst { it.width == planned.width && it.height == planned.height }
                    if (index >= 0) {
                        prefs.resWidth = planned.width
                        prefs.resHeight = planned.height
                    }
                }
                if (index >= 0) binding.spResolution.setSelection(index)
                // 放在 setSelection 之后：即使它同步触发了 onItemSelected，也不会清掉这个结果
                plan = planned
                binding.tvCapability.text = capabilityText(sizes, avc, hevc)
                updatePreviewLayout()
            }
        }, "capability-scan").apply { isDaemon = true; start() }
    }

    private fun capabilityText(
        sizes: List<android.util.Size>,
        avc: CodecCaps.Info?,
        hevc: CodecCaps.Info?
    ): String {
        if (sizes.isEmpty()) return "未能读取相机能力（可能缺少相机权限）"
        val camMax = sizes.first()
        val lines = ArrayList<String>(3)
        lines.add("相机最高 ${camMax.width}×${camMax.height}")
        lines.add("H.264 编码上限 ${avc?.maxWidth ?: 0}×${avc?.maxHeight ?: 0}")
        lines.add("H.265 编码上限 ${hevc?.maxWidth ?: 0}×${hevc?.maxHeight ?: 0}")
        return lines.joinToString(" · ")
    }

    private fun setupPreview() {
        binding.preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                attachPreviewSurface()
            }

            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
                applyPreviewTransform()
            }

            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                StreamService.instance?.setPreviewSurface(null)
                // 返回 false：SurfaceTexture 由我们自己管理生命周期，
                // 避免相机会话还在用它时被 View 直接释放。
                return false
            }

            override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
        }
    }

    private fun setupButtons() {
        binding.btnProbe.setOnClickListener { probeServer() }
        binding.btnDiscover.setOnClickListener { discoverServer() }

        binding.btnStart.setOnClickListener {
            prefs.host = binding.etServer.text.toString()
            prefs.streamKey = binding.etStreamKey.text.toString()
            if (prefs.toConfig() == null) {
                toast("请先填写服务器地址与机位名称")
                return@setOnClickListener
            }
            if (!hasPermissions()) {
                requestPermissions()
                return@setOnClickListener
            }
            startStream()
        }

        binding.btnStop.setOnClickListener { stopStream() }
        binding.btnSwitchCamera.setOnClickListener { switchCamera() }
        binding.btnClearLog.setOnClickListener {
            logLines.clear()
            renderLog()
        }

        binding.etStreamKey.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                val raw = binding.etStreamKey.text.toString()
                prefs.streamKey = raw
                val fixed = Prefs.sanitizeStreamKey(raw).ifBlank { Prefs.defaultStreamKey() }
                binding.etStreamKey.setText(fixed)
                prefs.streamKey = fixed
                if (fixed != raw.trim()) {
                    toast("机位名只能用英文/数字/下划线，已改为「$fixed」")
                }
                refreshUrlPreview()
            }
        }
        binding.etServer.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                prefs.host = binding.etServer.text.toString()
                refreshUrlPreview()
            }
        }
    }

    // ------------------------------------------------------------------ 服务器

    private fun probeServer() {
        val host = binding.etServer.text.toString().trim()
        if (host.isBlank()) {
            toast("请先填写服务器地址")
            return
        }
        prefs.host = host
        lifecycleScope.launch {
            binding.tvServerStatus.text = "正在探测 $host:${prefs.apiPort} …"
            val info = ServerProbe.probe(host, prefs.apiPort)
            if (info != null) {
                binding.etServer.setText(info.host)
                prefs.host = info.host
                binding.tvServerStatus.text = "✅ 已连接导播系统\n" +
                    "RTMP ${info.rtmpPort} · HTTP-FLV ${info.httpFlvPort} · API ${info.apiPort}\n" +
                    "服务器内网地址：${info.lanIp}"
            } else {
                binding.tvServerStatus.text = "❌ 未探测到导播系统（$host:${prefs.apiPort}）\n" +
                    "排查：① 手机与电脑连同一 Wi-Fi；② 电脑防火墙放行 3001/1935；③ 这里只填 IP，不要带 http:// 或端口"
            }
            refreshUrlPreview()
        }
    }

    private fun discoverServer() {
        lifecycleScope.launch {
            val prefix = ServerProbe.localSubnetPrefix()
            if (prefix == null) {
                binding.tvServerStatus.text = "未获取到局域网地址，请确认已连接 Wi-Fi"
                return@launch
            }
            binding.tvServerStatus.text = "正在扫描 $prefix.0/24 …"
            val info = ServerProbe.discover(apiPort = prefs.apiPort) { done, total ->
                if (done % 16 == 0 || done == total) {
                    runOnUiThread { binding.tvServerStatus.text = "正在扫描 $prefix.0/24 … $done/$total" }
                }
            }
            if (info != null) {
                binding.etServer.setText(info.host)
                prefs.host = info.host
                binding.tvServerStatus.text =
                    "✅ 已找到导播系统：${info.host}\nRTMP ${info.rtmpPort} · HTTP-FLV ${info.httpFlvPort}"
                refreshUrlPreview()
            } else {
                val local = ServerProbe.localAddresses().joinToString(", ").ifBlank { "无" }
                binding.tvServerStatus.text = "未找到导播系统。\n本机地址：$local\n" +
                    "请确认电脑端已执行 npm run server，且与手机在同一网段；也可以直接手填电脑 IP。"
            }
        }
    }

    private fun refreshUrlPreview() {
        val key = Prefs.sanitizeStreamKey(binding.etStreamKey.text.toString())
            .ifBlank { Prefs.defaultStreamKey() }
        val host = binding.etServer.text.toString().trim().ifBlank { "--" }
        binding.tvRtmpUrl.text = "rtmp://$host:1935/live/$key"
    }

    // ------------------------------------------------------------------ 推流控制

    private fun startStream() {
        prefs.host = binding.etServer.text.toString()
        prefs.streamKey = binding.etStreamKey.text.toString()
        val config = prefs.toConfig() ?: run {
            toast("请先填写服务器地址与机位名称")
            return
        }
        attachPreviewSurface()
        streaming = true
        StreamingFlags.screenOn(this, true)
        appendLog("开始推流 → ${config.rtmpUrl}")
        StreamService.start(this, config, previewSurface)
        setUiStreaming(true, StreamEngine.State.CONNECTING)
    }

    private fun stopStream() {
        streaming = false
        StreamingFlags.screenOn(this, false)
        val svc = StreamService.instance
        if (svc != null) svc.stopStream() else StreamService.requestStop(this)
        setUiStreaming(false, StreamEngine.State.STOPPED)
        binding.tvStats.text = "码率 -- kbps · 帧率 -- fps · 已推 --"
    }

    private fun switchCamera() {
        val next = if (binding.spCamera.selectedItemPosition == 0) 1 else 0
        binding.spCamera.setSelection(next)
        prefs.cameraIndex = next
        plan = null
        // 前后摄能力差异很大（尤其 8K / H.265 支持），必须重新枚举
        refreshCapabilities()
        updatePreviewLayout()
        if (streaming) StreamService.requestSwitchCamera(this)
    }

    private fun setUiStreaming(active: Boolean, state: StreamEngine.State) {
        binding.btnStart.isEnabled = !active
        binding.btnStop.isEnabled = active
        binding.tvPreviewHint.visibility = if (active) View.GONE else View.VISIBLE
        when (state) {
            StreamEngine.State.LIVE -> {
                binding.tvStatus.text = "推流中"
                binding.dotStatus.setBackgroundResource(R.drawable.dot_live)
            }
            StreamEngine.State.CONNECTING -> {
                binding.tvStatus.text = "连接中…"
                binding.dotStatus.setBackgroundResource(R.drawable.dot_idle)
            }
            StreamEngine.State.ERROR -> {
                binding.tvStatus.text = "异常"
                binding.dotStatus.setBackgroundResource(R.drawable.dot_live)
            }
            else -> {
                binding.tvStatus.text = "未推流"
                binding.dotStatus.setBackgroundResource(R.drawable.dot_idle)
            }
        }
    }

    // ------------------------------------------------------------------ 预览

    /** 采集缓冲尺寸：优先用服务里实际生效的，其次用编排结果，最后用设置里的。 */
    private fun bufferSize(): Pair<Int, Int> {
        val svc = StreamService.instance
        val size = svc?.cameraSize
        if (svc != null && size != null) return size.width to size.height
        plan?.let { return it.width to it.height }
        return prefs.resWidth to prefs.resHeight
    }

    /** 与 StreamEngine.resolveRotation 完全一致的口径，用来让预览和推流画幅对齐。 */
    private fun expectedRotation(): Int {
        if (streaming) {
            val r = StreamService.instance?.currentRotation ?: 0
            if (r != 0) return r
        }
        val facing = if (prefs.cameraIndex == 0) {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK
        } else {
            android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT
        }
        val id = CameraSource.cameraIdFor(this, facing) ?: return 0
        val sensor = CameraSource.sensorOrientation(this, id)
        var device = OrientationMonitor.lastOrientationDegrees
        when (StreamPresets.orientation(prefs.orientationIndex)) {
            OrientationMode.AUTO -> Unit
            OrientationMode.LANDSCAPE -> if (device == 0 || device == 180) device = 90
            OrientationMode.PORTRAIT -> if (device == 90 || device == 270) device = 0
        }
        return ((sensor - device) % 360 + 360) % 360
    }

    private fun updatePreviewLayout() {
        val (bufW, bufH) = bufferSize()
        val rotation = expectedRotation()
        val outW = if (rotation % 180 == 0) bufW else bufH
        val outH = if (rotation % 180 == 0) bufH else bufW

        binding.previewBox.post {
            val width = binding.previewBox.width
            if (width > 0) {
                val lp = binding.previewBox.layoutParams
                lp.height = (width.toLong() * outH / outW).toInt().coerceAtLeast(120)
                binding.previewBox.layoutParams = lp
            }
            applyPreviewTransform()
        }
        binding.tvPreviewInfo.text = "${outW}×${outH} · ${StreamPresets.fps(prefs.fpsIndex)}fps · 旋转${rotation}°"
        binding.tvEncoderInfo.text = encoderInfo(outW, outH)
        refreshUrlPreview()
    }

    /**
     * TextureView 默认把整帧拉伸铺满控件，这里换算成「等比 fit + 旋转」，
     * 保证预览里看到的就是编码器即将推出去的那一帧。
     */
    private fun applyPreviewTransform() {
        val view = binding.preview
        val vw = view.width.toFloat()
        val vh = view.height.toFloat()
        if (vw <= 0f || vh <= 0f) return

        val (bufW, bufH) = bufferSize()
        val rotation = expectedRotation()
        val rotW = (if (rotation % 180 == 0) bufW else bufH).toFloat()
        val rotH = (if (rotation % 180 == 0) bufH else bufW).toFloat()

        val scale = min(vw / rotW, vh / rotH)
        val kx = rotW * scale / vw
        val ky = rotH * scale / vh

        val m = Matrix()
        m.postTranslate(-vw / 2f, -vh / 2f)
        m.postScale(kx, ky)
        m.postRotate(rotation.toFloat())
        m.postTranslate(vw / 2f, vh / 2f)
        view.setTransform(m)
    }

    private fun attachPreviewSurface() {
        val st = binding.preview.surfaceTexture ?: return
        val (bufW, bufH) = bufferSize()
        runCatching { st.setDefaultBufferSize(bufW, bufH) }
        if (previewTexture !== st || previewSurface == null) {
            previewSurface?.let { old -> android.os.Handler(mainLooper).postDelayed({ runCatching { old.release() } }, 400) }
            previewTexture = st
            previewSurface = Surface(st)
        }
        applyPreviewTransform()
        StreamService.instance?.setPreviewSurface(previewSurface)
    }

    private fun encoderInfo(outW: Int, outH: Int): String {
        val v = StreamPresets.videoBitrate(prefs.videoBitrateIndex)
        val a = StreamPresets.audio(prefs.audioIndex)
        val codec = plan?.codec ?: VideoCodec.AVC
        val fps = plan?.fps ?: StreamPresets.fps(prefs.fpsIndex)
        val sb = StringBuilder()
        sb.append("编码：${codec.displayName} $outW×$outH @${fps}fps · ${v.bps / 1000} kbps · 关键帧 1s")
        sb.append("\n音频：AAC-LC ${a.bitrate / 1000} kbps ${a.sampleRate / 1000} kHz ")
        sb.append(if (a.stereo) "立体声" else "单声道")

        val recommended = StreamPresets.recommendedBitrateBps(outW, outH, fps)
        if (v.bps < recommended) {
            sb.append("\n⚠ 该画幅建议 ≥${recommended / 1_000_000} Mbps，当前只有 ${v.bps / 1_000_000} Mbps，画面会糊")
        }
        if (outW >= 7680 || outH >= 4320) {
            sb.append("\n⚠ 8K 码流极大，请用有线网或 5GHz/千兆局域网，并确认导播台电脑能实时解码 H.265")
        }
        if (codec == VideoCodec.HEVC) {
            sb.append("\n⚠ H.265 无法在导播台内置播放器（flv.js）里播放，该路会显示「编码不受支持」；")
            sb.append("要直接在导播台看画面请选 H.264，或用支持 H.265 的播放器（VLC/ffplay）拉流")
        }
        for (note in plan?.notes.orEmpty()) sb.append("\n· $note")
        return sb.toString()
    }

    // ------------------------------------------------------------- 服务回调

    override fun onState(state: StreamEngine.State, detail: String) {
        runOnUiThread {
            when (state) {
                StreamEngine.State.LIVE -> {
                    streaming = true
                    appendLog("✅ 推流中：$detail")
                    updatePreviewLayout()
                }
                StreamEngine.State.CONNECTING -> {
                    streaming = true
                    updatePreviewLayout()
                }
                StreamEngine.State.ERROR, StreamEngine.State.STOPPED, StreamEngine.State.IDLE -> {
                    streaming = false
                    StreamingFlags.screenOn(this, false)
                }
            }
            setUiStreaming(streaming, state)
        }
    }

    override fun onLog(message: String) {
        runOnUiThread { appendLog(message) }
    }

    override fun onError(message: String) {
        runOnUiThread { appendLog("❌ $message") }
    }

    override fun onStats(stats: StreamEngine.Stats) {
        runOnUiThread {
            val dur = stats.durationMs / 1000
            val time = if (dur >= 3600) {
                String.format(java.util.Locale.US, "%d:%02d:%02d", dur / 3600, (dur % 3600) / 60, dur % 60)
            } else {
                String.format(java.util.Locale.US, "%02d:%02d", dur / 60, dur % 60)
            }
            binding.tvStats.text = "视频 ${stats.videoKbps} kbps · 音频 ${stats.audioKbps} kbps · ${stats.fps} fps\n" +
                "已推 $time · 丢帧 ${stats.dropped} · 待发 ${stats.queue}"
        }
    }

    // ------------------------------------------------------------------ 日志

    private fun appendLog(line: String, push: Boolean = true) {
        if (push) {
            val now = System.currentTimeMillis()
            if (now - lastLogAt < 30) return
            lastLogAt = now
        }
        logLines.addLast(line)
        while (logLines.size > 60) logLines.removeFirst()
        renderLog()
    }

    private fun renderLog() {
        binding.tvLog.text = logLines.joinToString("\n")
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }
}

/** 推流期间保持屏幕常亮。 */
private object StreamingFlags {
    fun screenOn(activity: AppCompatActivity, on: Boolean) {
        if (on) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
