package com.rtmp.camsender.stream

import android.hardware.camera2.CameraCharacteristics

/**
 * 推流画面方向策略。
 */
enum class OrientationMode {
    /** 跟随手机物理方向：横持出横屏，竖持出竖屏。 */
    AUTO,

    /** 强制横屏（导播大屏 / HDMI 输出常用）。 */
    LANDSCAPE,

    /** 强制竖屏（手机竖持短视频风格）。 */
    PORTRAIT
}

/**
 * 视频编码格式选择。
 *
 * [AUTO] 按分辨率自动挑：能 H.264 就 H.264（导播台内置播放器直接能放），
 * 只有 H.265 编得动（例如 8K）才用 H.265。
 */
enum class CodecChoice(val label: String) {
    AUTO("自动（按分辨率选）"),
    AVC("H.264（导播台可直接播放）"),
    HEVC("H.265/HEVC（8K 必需）");

    companion object {
        val labels: List<String> get() = entries.map { it.label }
    }
}

/**
 * 一路推流的完整参数。
 *
 * 注意：[width] x [height] 始终是「相机传感器坐标系」的尺寸（横置，宽>=高），
 * 例如 1920x1080。最终推流画面的宽高由 [rotationDegrees] 决定：
 * 0/180 时为 width x height，90/270 时自动交换为 height x width。
 */
data class StreamConfig(
    val host: String,
    val port: Int = 1935,
    val app: String = "live",
    val streamKey: String,
    val width: Int = 1920,
    val height: Int = 1080,
    val fps: Int = 30,
    val videoBitrate: Int = 4_000_000,
    val keyFrameIntervalSec: Int = 1,
    val audioSampleRate: Int = 44100,
    val audioBitrate: Int = 96_000,
    val stereo: Boolean = false,
    val lensFacing: Int = CameraCharacteristics.LENS_FACING_BACK,
    val orientationMode: OrientationMode = OrientationMode.AUTO,
    /** 非空时忽略 [orientationMode]，直接使用该角度（0/90/180/270）。 */
    val manualRotation: Int? = null,
    /** 期望的编码格式；实际生效的格式见 [StreamEngine.codecInUse]。 */
    val codecChoice: CodecChoice = CodecChoice.AUTO
) {
    val rtmpUrl: String get() = "rtmp://$host:$port/$app/$streamKey"

    /** 该角度下最终输出的宽高。 */
    fun outputSize(rotationDegrees: Int): Pair<Int, Int> =
        if (rotationDegrees % 180 == 0) width to height else height to width
}
