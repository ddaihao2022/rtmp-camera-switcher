package com.rtmp.camsender.stream

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.view.Surface
import com.rtmp.camsender.rtmp.VideoCodec
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 硬编码器（H.264 或 H.265，由 [videoCodec] 指定）。
 *
 * 输入面直接给相机（Camera2）或 GL 旋转渲染器当输出目标，做到零拷贝：
 *   Camera2 → encoder input Surface → H.264/H.265 → FLV/RTMP
 *   Camera2 → GL(旋转) → encoder input Surface → H.264/H.265 → FLV/RTMP
 *
 * 旋转不依赖 MediaFormat.KEY_ROTATION——部分机型硬编码器会静默忽略该参数，
 * 统一由 GlRotateRenderer 在 GL 里物理旋转像素，保证所有机型行为一致。
 *
 * 8K 只可能走 H.265：手机上的 AVC 硬编码器普遍止步于 4096 宽。请求 H.265 时
 * 若该机型编不动，会自动降级到 H.264（仅当分辨率在 AVC 能力范围内），
 * 并把实际生效的格式通过 [codecInUse] 暴露出去。
 */
class VideoEncoder(
    private val videoCodec: VideoCodec,
    private val width: Int,
    private val height: Int,
    private val fps: Int,
    private val bitrate: Int,
    private val keyFrameIntervalSec: Int,
    private val listener: Listener
) {

    interface Listener {
        fun onLog(message: String)

        /**
         * 参数集（序列头内容）就绪或发生变化，顺序为
         * H.264 → [SPS, PPS]，H.265 → [VPS, SPS, PPS]（缺的就少）。
         */
        fun onParamSets(codec: VideoCodec, nals: List<ByteArray>)

        /** @param payload 已是「4 字节大端长度 + NAL」格式 */
        fun onFrame(codec: VideoCodec, payload: ByteArray, ptsUs: Long, keyFrame: Boolean)

        fun onError(message: String, cause: Throwable?)
    }

    companion object {
        private const val DEQUEUE_TIMEOUT_US = 10_000L
    }

    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var drainThread: Thread? = null
    private val running = AtomicBoolean(false)
    private val bufferInfo = MediaCodec.BufferInfo()

    /** 实际生效的编码格式（可能因机型不支持而从 H.265 降级为 H.264）。 */
    @Volatile var codecInUse: VideoCodec = videoCodec
        private set

    /** 实际生效的码率（可能被编码器允许范围夹过）。 */
    @Volatile var effectiveBitrate: Int = bitrate
        private set

    @Volatile private var paramTag: String = ""

    val surface: Surface get() = inputSurface ?: error("VideoEncoder 尚未启动")

    fun start() {
        val c = createCodec()
        codec = c
        inputSurface = c.createInputSurface()
        c.start()
        running.set(true)

        val enc = CodecCaps.info(codecInUse)
        listener.onLog(
            "视频编码器已启动 ${codecInUse.displayName} ${width}x$height@${fps}fps " +
                "${effectiveBitrate / 1000}kbps" + (enc?.codecName?.let { "（$it）" } ?: "")
        )
        if (effectiveBitrate != bitrate) {
            listener.onLog(
                "注：请求码率 ${bitrate / 1000}kbps 超出编码器允许范围" +
                    "（${enc?.bitrateRangeFor(width, height)?.first?.div(1000)}–" +
                    "${enc?.bitrateRangeFor(width, height)?.last?.div(1000)} kbps），" +
                    "已夹到 ${effectiveBitrate / 1000}kbps"
            )
        }

        val t = Thread({ drainLoop(c) }, "video-drain")
        t.isDaemon = true
        drainThread = t
        t.start()
    }

    private fun buildFormat(c: VideoCodec, profileLevel: Pair<Int, Int>?): MediaFormat =
        MediaFormat.createVideoFormat(c.mime, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, effectiveBitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, keyFrameIntervalSec)
            runCatching {
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                )
            }
            if (profileLevel != null) {
                setInteger(MediaFormat.KEY_PROFILE, profileLevel.first)
                setInteger(MediaFormat.KEY_LEVEL, profileLevel.second)
            }
        }

    /**
     * 逐级降级：请求的编码格式（指定档位 → 默认档位）→ 另一编码格式（H.265 降 H.264）。
     * 各机型对档位 / CBR / 高分辨率的支持差异极大，逐级降级比直接失败更稳。
     */
    private fun createCodec(): MediaCodec {
        val order = ArrayList<VideoCodec>(2)
        order.add(videoCodec)
        if (videoCodec != VideoCodec.AVC) order.add(VideoCodec.AVC)

        var lastError: Throwable? = null
        var lastMime = ""
        for (c in order) {
            val info = CodecCaps.info(c)
            if (info != null && !info.supportsSize(width, height)) {
                lastMime = c.mime
                lastError = IllegalStateException(
                    "${c.displayName} 编码器不支持 $width×$height" +
                        "（上限 ${info.maxWidth}×${info.maxHeight}）"
                )
                continue
            }

            effectiveBitrate = info?.clampBitrate(width, height, bitrate) ?: bitrate
            val profileLevel = CodecCaps.profileLevelFor(c, width, height, fps)
            lastMime = c.mime
            val attempts = if (profileLevel != null) listOf(profileLevel, null) else listOf<Pair<Int, Int>?>(null)

            for (pl in attempts) {
                var candidate: MediaCodec? = null
                try {
                    candidate = MediaCodec.createEncoderByType(c.mime)
                    candidate.configure(
                        buildFormat(c, pl),
                        null,
                        null,
                        MediaCodec.CONFIGURE_FLAG_ENCODE
                    )
                    codecInUse = c
                    listener.onLog(
                        when {
                            c != videoCodec -> "视频编码器：$width×$height 无法用 ${videoCodec.displayName} 编码，已降级为 ${c.displayName}"
                            pl != null -> "视频编码器：${c.displayName} 档位 profile=${pl.first} level=${pl.second}"
                            else -> "视频编码器：${c.displayName} 默认档位"
                        }
                    )
                    return candidate
                } catch (t: Throwable) {
                    lastError = t
                    runCatching { candidate?.release() }
                }
            }
        }
        throw IllegalStateException(
            "没有可用的视频编码器（$lastMime $width×$height）：${lastError?.message}",
            lastError
        )
    }

    fun requestSyncFrame() {
        runCatching {
            val params = Bundle()
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            codec?.setParameters(params)
        }
    }

    fun setBitrate(newBitrate: Int) {
        runCatching {
            val params = Bundle()
            params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, newBitrate)
            codec?.setParameters(params)
        }
    }

    fun stop() {
        running.set(false)
        runCatching { drainThread?.join(1200) }
        drainThread = null
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        runCatching { inputSurface?.release() }
        inputSurface = null
    }

    // ------------------------------------------------------------------ drain

    private fun drainLoop(c: MediaCodec) {
        try {
            while (running.get()) {
                val index = c.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> Unit

                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val fmt = c.outputFormat
                        handleCodecConfig(
                            fmt.getByteBuffer("csd-0"),
                            fmt.getByteBuffer("csd-1"),
                            codecInUse
                        )
                    }

                    index >= 0 -> {
                        val buf = c.getOutputBuffer(index)
                        val info = bufferInfo
                        val activeCodec = codecInUse
                        if (buf != null && info.size > 0) {
                            val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                            val keyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                            val raw = ByteArray(info.size)
                            buf.position(info.offset)
                            buf.limit(info.offset + info.size)
                            buf.get(raw)
                            if (isConfig) {
                                handleCodecConfigRaw(raw, activeCodec)
                            } else {
                                val payload = NalUtil.toAvcc(raw, raw.size)
                                if (payload.isNotEmpty()) {
                                    // 顺带捕获参数集变化（部分机型只在关键帧里带上参数集）
                                    if (keyFrame) {
                                        val found = NalUtil.findParamSets(payload, payload.size, activeCodec)
                                        if (NalUtil.hasCompleteParamSets(found, activeCodec)) {
                                            updateParamSets(activeCodec, found)
                                        }
                                    }
                                    listener.onFrame(activeCodec, payload, info.presentationTimeUs, keyFrame)
                                }
                            }
                        }
                        runCatching { c.releaseOutputBuffer(index, false) }
                    }
                }
            }
        } catch (e: IllegalStateException) {
            if (running.get()) listener.onError("视频编码器异常：${e.message}", e)
        } catch (e: Throwable) {
            if (running.get()) listener.onError("视频编码线程异常：${e.message}", e)
        }
    }

    private fun handleCodecConfig(
        csd0: java.nio.ByteBuffer?,
        csd1: java.nio.ByteBuffer?,
        codec: VideoCodec
    ) {
        val raw0 = csd0?.let { b -> ByteArray(b.remaining()).also { b.get(it) } }
        val raw1 = csd1?.let { b -> ByteArray(b.remaining()).also { b.get(it) } }

        // H.264: csd-0 = SPS(+PPS)，csd-1 = PPS；H.265: csd-0 = VPS+SPS+PPS
        for (raw in listOfNotNull(raw0, raw1)) {
            val found = NalUtil.findParamSets(raw, raw.size, codec)
            if (NalUtil.hasCompleteParamSets(found, codec)) {
                updateParamSets(codec, found)
                return
            }
        }
        // 两个 csd 拼起来也可能才凑齐（个别机型把 PPS 单放 csd-1）
        val merged = listOfNotNull(raw0, raw1).flatMap { NalUtil.extractNals(it, it.size) }
        val found = NalUtil.findParamSets(merged, codec)
        if (NalUtil.hasCompleteParamSets(found, codec)) {
            updateParamSets(codec, found)
        } else {
            listener.onLog(
                "警告：未能从 csd 中解析出完整的参数集" +
                    "（${codec.displayName} 需要 " +
                    (if (codec == VideoCodec.HEVC) "VPS+SPS+PPS" else "SPS+PPS") + "）"
            )
        }
    }

    private fun handleCodecConfigRaw(raw: ByteArray, codec: VideoCodec) {
        val found = NalUtil.findParamSets(raw, raw.size, codec)
        if (NalUtil.hasCompleteParamSets(found, codec)) updateParamSets(codec, found)
    }

    private fun updateParamSets(codec: VideoCodec, nals: List<ByteArray>) {
        val tag = NalUtil.fingerprint(nals)
        if (tag == paramTag) return
        paramTag = tag
        listener.onParamSets(codec, nals)
    }
}
