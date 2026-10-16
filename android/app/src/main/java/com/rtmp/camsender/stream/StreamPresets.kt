package com.rtmp.camsender.stream

/**
 * UI 下拉框使用的静态预设表。
 *
 * 分辨率**不在这里**：它是按机身实际能力枚举出来的（见 [CodecCaps.buildResolutions]），
 * 本文件只放与机型无关的档位。
 */
object StreamPresets {

    data class AudioOption(
        val label: String,
        val bitrate: Int,
        val sampleRate: Int,
        val stereo: Boolean
    )

    data class BitrateOption(val label: String, val bps: Int)

    /** 60fps 追加在末尾，保持既有下标（0=30fps）不变，避免老设置错位。 */
    val fpsOptions = listOf(30, 25, 24, 15, 60)

    val videoBitrates = listOf(
        BitrateOption("8 Mbps  极清", 8_000_000),          // 0
        BitrateOption("6 Mbps  高清", 6_000_000),          // 1
        BitrateOption("4 Mbps  推荐", 4_000_000),          // 2 ← 默认
        BitrateOption("2.5 Mbps 流畅", 2_500_000),         // 3
        BitrateOption("1.5 Mbps 省流", 1_500_000),         // 4
        BitrateOption("1 Mbps  弱网", 1_000_000),          // 5
        BitrateOption("12 Mbps 准 4K", 12_000_000),        // 6
        BitrateOption("20 Mbps 4K", 20_000_000),           // 7
        BitrateOption("40 Mbps 4K 高码", 40_000_000),      // 8
        BitrateOption("60 Mbps 8K 入门", 60_000_000),      // 9
        BitrateOption("80 Mbps 8K", 80_000_000),           // 10
        BitrateOption("120 Mbps 8K 高码", 120_000_000)     // 11
    )

    val audioOptions = listOf(
        AudioOption("128 kbps 48kHz 立体声", 128_000, 48_000, true),
        AudioOption("96 kbps 44.1kHz 单声道", 96_000, 44_100, false),
        AudioOption("64 kbps 44.1kHz 单声道", 64_000, 44_100, false)
    )

    val orientationLabels = listOf(
        "自动跟随手机方向",
        "强制横屏（HDMI/大屏）",
        "强制竖屏（手机竖屏）"
    )

    val orientationModes = listOf(
        OrientationMode.AUTO,
        OrientationMode.LANDSCAPE,
        OrientationMode.PORTRAIT
    )

    val cameraLabels = listOf("后置摄像头", "前置摄像头")

    val codecChoices = CodecChoice.entries

    val codecLabels: List<String> get() = CodecChoice.labels

    fun fps(index: Int): Int = fpsOptions[index.coerceIn(0, fpsOptions.size - 1)]

    fun videoBitrate(index: Int): BitrateOption =
        videoBitrates[index.coerceIn(0, videoBitrates.size - 1)]

    fun audio(index: Int): AudioOption = audioOptions[index.coerceIn(0, audioOptions.size - 1)]

    fun orientation(index: Int): OrientationMode =
        orientationModes[index.coerceIn(0, orientationModes.size - 1)]

    fun codecChoice(index: Int): CodecChoice =
        codecChoices[index.coerceIn(0, codecChoices.size - 1)]

    /**
     * 按分辨率给出的「建议最低码率」。8K 用 4 Mbps 会糊成一片，
     * 界面据此提示用户，而不是替用户改设置。
     */
    fun recommendedBitrateBps(width: Int, height: Int, fps: Int): Int {
        val pixels = width.toLong() * height
        val base = when {
            pixels >= 7680L * 4320 -> 80_000_000
            pixels >= 5120L * 2880 -> 60_000_000
            pixels >= 3840L * 2160 -> 40_000_000
            pixels >= 2560L * 1440 -> 20_000_000
            pixels >= 1920L * 1080 -> 8_000_000
            pixels >= 1280L * 720 -> 4_000_000
            else -> 2_000_000
        }
        return if (fps >= 60) base * 3 / 2 else base
    }

    /** 建议码率对应的档位下标（取不小于建议值的最近一档）。 */
    fun recommendedBitrateIndex(width: Int, height: Int, fps: Int): Int {
        val want = recommendedBitrateBps(width, height, fps)
        val idx = videoBitrates.indexOfFirst { it.bps >= want }
        return if (idx >= 0) idx else videoBitrates.lastIndex
    }
}
