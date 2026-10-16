package com.rtmp.camsender

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import com.rtmp.camsender.stream.StreamConfig
import com.rtmp.camsender.stream.StreamPresets

/** 轻量设置持久化。 */
class Prefs(context: Context) {

    private val sp = context.getSharedPreferences("rtmp_camsender", Context.MODE_PRIVATE)

    var host: String
        get() = sp.getString("host", "") ?: ""
        set(v) = sp.edit().putString("host", v.trim()).apply()

    var apiPort: Int
        get() = sp.getInt("apiPort", 3001)
        set(v) = sp.edit().putInt("apiPort", v).apply()

    var streamKey: String
        get() = sp.getString("streamKey", "") ?: ""
        set(v) = sp.edit().putString("streamKey", v.trim()).apply()

    /**
     * 分辨率按「宽 × 高」存，因为可选列表是按机身实际能力动态生成的
     * （8K 机型会多出 7680×4320 这类条目），存下标会错位。
     */
    var resWidth: Int
        get() = sp.getInt("resW", legacySize().first)
        set(v) = sp.edit().putInt("resW", v).apply()

    var resHeight: Int
        get() = sp.getInt("resH", legacySize().second)
        set(v) = sp.edit().putInt("resH", v).apply()

    /** 编码格式选择下标，对应 [com.rtmp.camsender.stream.CodecChoice]。 */
    var codecIndex: Int
        get() = sp.getInt("codec", 0)
        set(v) = sp.edit().putInt("codec", v).apply()

    var fpsIndex: Int
        get() = sp.getInt("fps", 0)
        set(v) = sp.edit().putInt("fps", v).apply()

    var videoBitrateIndex: Int
        get() = sp.getInt("videoBitrate", 2)
        set(v) = sp.edit().putInt("videoBitrate", v).apply()

    var audioIndex: Int
        get() = sp.getInt("audio", 1)
        set(v) = sp.edit().putInt("audio", v).apply()

    var orientationIndex: Int
        get() = sp.getInt("orientation", 0)
        set(v) = sp.edit().putInt("orientation", v).apply()

    var cameraIndex: Int
        get() = sp.getInt("camera", 0)
        set(v) = sp.edit().putInt("camera", v).apply()

    /** 老版本存的是静态分辨率表下标（0=1080p / 1=720p / 2=480p / 3=360p），做一次迁移。 */
    private fun legacySize(): Pair<Int, Int> = when (sp.getInt("resolution", 0)) {
        1 -> 1280 to 720
        2 -> 854 to 480
        3 -> 640 to 360
        else -> 1920 to 1080
    }

    fun toConfig(): StreamConfig? {
        val h = host
        if (h.isBlank()) return null
        val key = sanitizeStreamKey(streamKey)
        if (key.isBlank()) return null
        val audio = StreamPresets.audio(audioIndex)
        return StreamConfig(
            host = h,
            port = 1935,
            app = "live",
            streamKey = key,
            width = resWidth,
            height = resHeight,
            fps = StreamPresets.fps(fpsIndex),
            videoBitrate = StreamPresets.videoBitrate(videoBitrateIndex).bps,
            keyFrameIntervalSec = 1,
            audioSampleRate = audio.sampleRate,
            audioBitrate = audio.bitrate,
            stereo = audio.stereo,
            lensFacing = if (cameraIndex == 0) {
                CameraCharacteristics.LENS_FACING_BACK
            } else {
                CameraCharacteristics.LENS_FACING_FRONT
            },
            orientationMode = StreamPresets.orientation(orientationIndex),
            codecChoice = StreamPresets.codecChoice(codecIndex)
        )
    }

    companion object {
        /**
         * 机位名会被拼进 URL 路径，也是导播台左侧列表显示的设备名。
         *
         * 这里限制为 ASCII（字母/数字/下划线/点/连字符），不只是 URL 安全考虑：
         * node-media-server 的 AMF0 编码器对非 ASCII 字符串写错长度字段
         * （amf.js:287 用 str.length 而不是 Buffer.byteLength），
         * 服务端回包里的 onStatus 描述含机位名，会导致 publish 应答无法解析。
         * 详见 android/README.md「已知限制」。
         */
        fun sanitizeStreamKey(raw: String): String {
            val replaced = raw.trim().replace(Regex("[^A-Za-z0-9_.-]+"), "_")
            return replaced.trim('_', '.', '-').take(32)
        }

        /** 没填名字时按时间生成一个，避免两台手机撞成同一路。 */
        fun defaultStreamKey(): String {
            val t = System.currentTimeMillis() / 1000
            return "phone_${t % 100000}"
        }
    }
}
