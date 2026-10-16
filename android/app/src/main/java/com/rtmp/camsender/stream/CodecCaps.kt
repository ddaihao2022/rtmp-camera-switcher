package com.rtmp.camsender.stream

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.Range
import android.util.Size
import com.rtmp.camsender.rtmp.VideoCodec
import kotlin.math.abs
import kotlin.math.ceil

/**
 * 硬编码器能力查询：分辨率上限、码率范围、帧率范围、档位。
 *
 * 「最高支持到多少」不是写死的常量，而是问系统要：
 *  - 相机侧：[CameraSource.videoSizes] 给出传感器能输出的尺寸；
 *  - 编码器侧：本类给出硬编码器能吃下的尺寸 / 帧率 / 码率；
 * 两者取交集才是这台手机上真正可用的最高分辨率（8K 机型就会列出 7680×4320）。
 */
object CodecCaps {

    /**
     * 某个硬编码器的能力。注意区分：
     *  - 分辨率 / 帧率 / 码率范围来自 [MediaCodecInfo.VideoCapabilities]；
     *  - 颜色格式 / 档位表来自 [MediaCodecInfo.CodecCapabilities]
     *    （VideoCapabilities 并不继承 CodecCapabilities，这是两套接口）。
     */
    class Info(
        val codecName: String,
        val hardware: Boolean,
        val supportsSurface: Boolean,
        val minWidth: Int,
        val maxWidth: Int,
        val minHeight: Int,
        val maxHeight: Int,
        val bitrateRange: IntRange,
        val profiles: List<MediaCodecInfo.CodecProfileLevel>,
        private val videoCaps: MediaCodecInfo.VideoCapabilities?
    ) {
        /** 厂商声明的分辨率上限（仅按宽高，不含帧率）。 */
        val maxPixels: Int get() = maxWidth * maxHeight

        fun supportsSize(width: Int, height: Int): Boolean {
            val caps = videoCaps
            if (caps != null) return runCatching { caps.isSizeSupported(width, height) }.getOrDefault(false)
            return width in minWidth..maxWidth && height in minHeight..maxHeight
        }

        /** 该尺寸下可用的帧率范围。 */
        fun fpsRange(width: Int, height: Int): Range<Double>? {
            val caps = videoCaps ?: return null
            return runCatching { caps.getSupportedFrameRatesFor(width, height) }.getOrNull()
        }

        fun supportsFps(width: Int, height: Int, fps: Int): Boolean {
            if (!supportsSize(width, height)) return false
            val r = fpsRange(width, height) ?: return true
            return fps <= r.upper + 0.01
        }

        /** 该尺寸下允许的最高帧率（拿不到就返回 0 表示未知）。 */
        fun maxFps(width: Int, height: Int): Int {
            val r = fpsRange(width, height) ?: return 0
            return r.upper.toInt()
        }

        /**
         * 码率范围。Android 只为视频编码器暴露「全局码率范围」，
         * 没有按分辨率查询的接口（EncoderCapabilities 里也没有），
         * 因此尺寸参数仅用于保持调用点语义，实际返回全局范围。
         */
        fun bitrateRangeFor(width: Int, height: Int): IntRange = bitrateRange

        /** 把请求码率夹到合法区间。 */
        fun clampBitrate(width: Int, height: Int, wanted: Int): Int {
            val r = bitrateRangeFor(width, height)
            if (r.isEmpty()) return wanted
            return wanted.coerceIn(r.first, r.last)
        }

        fun hasProfile(profile: Int, level: Int): Boolean =
            profiles.any { it.profile == profile && it.level >= level }

        fun maxLevelOf(profile: Int): Int =
            profiles.filter { it.profile == profile }.maxOfOrNull { it.level } ?: 0
    }

    data class CodecSummary(
        val codec: VideoCodec,
        val info: Info?,
        /** 相机与编码器共同支持的分辨率，按像素数从大到小。 */
        val sizes: List<Resolution>
    ) {
        val available: Boolean get() = info != null && sizes.isNotEmpty()
        val maxSize: Resolution? get() = sizes.firstOrNull()
    }

    /** 与 UI 列表共用的分辨率条目。 */
    data class Resolution(
        val width: Int,
        val height: Int,
        val label: String,
        val avcOk: Boolean,
        val hevcOk: Boolean,
        val maxFps: Int
    ) {
        val pixels: Int get() = width * height
        val name: String get() = "$width×$height"
        /** 只有 H.265 能编（8K 基本都是这种）。 */
        val hevcOnly: Boolean get() = hevcOk && !avcOk
    }

    private val cache = HashMap<VideoCodec, Optional>()

    private class Optional(val info: Info?)

    /** 取得该编码格式下最合适的硬编码器（优先硬件、分辨率上限最大）。 */
    fun info(codec: VideoCodec): Info? {
        synchronized(cache) {
            cache[codec]?.let { return it.info }
            val resolved = resolve(codec)
            cache[codec] = Optional(resolved)
            return resolved
        }
    }

    private fun resolve(codec: VideoCodec): Info? {
        val list = runCatching { MediaCodecList(MediaCodecList.REGULAR_CODECS) }.getOrNull() ?: return null
        var best: Info? = null
        for (ci in list.codecInfos) {
            if (!ci.isEncoder) continue
            val cc = runCatching { ci.getCapabilitiesForType(codec.mime) }.getOrNull() ?: continue
            // 没有 VideoCapabilities 的编码器（极少见）无法可靠判断尺寸，直接跳过
            val vc = cc.videoCapabilities ?: continue
            val info = runCatching {
                Info(
                    codecName = ci.name,
                    hardware = isHardware(ci),
                    supportsSurface = cc.colorFormats?.contains(
                        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                    ) == true,
                    minWidth = vc.supportedWidths.lower,
                    maxWidth = vc.supportedWidths.upper,
                    minHeight = vc.supportedHeights.lower,
                    maxHeight = vc.supportedHeights.upper,
                    bitrateRange = vc.bitrateRange.lower..vc.bitrateRange.upper,
                    profiles = cc.profileLevels?.toList() ?: emptyList(),
                    videoCaps = vc
                )
            }.getOrNull() ?: continue

            val prev = best
            best = when {
                prev == null -> info
                info.hardware && !prev.hardware -> info
                info.hardware == prev.hardware && info.maxPixels > prev.maxPixels -> info
                else -> prev
            }
        }
        return best
    }

    private fun isHardware(ci: MediaCodecInfo): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return ci.isHardwareAccelerated
        // API 29 以下没有官方标志：按命名习惯排除软编（google / android 开头的是软编）
        val n = ci.name.lowercase()
        return !(n.startsWith("omx.google") || n.contains("android.soft") || n.contains("sw."))
    }

    // ------------------------------------------------------------- 档位选择

    /**
     * 按分辨率挑一个够用的 H.264 Level。
     * 表来自 ITU-T H.264 Annex A（MaxFS 宏块数 / MaxMBPS 宏块率）。
     */
    private val avcLevels = listOf(
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel31, 3600, 108000),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel4, 8192, 245760),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel41, 8192, 245760),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel42, 8704, 522240),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel5, 22080, 589824),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel51, 36864, 983040),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel52, 36864, 2073600),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel6, 139264, 4177920),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel61, 139264, 8355840),
        Triple(MediaCodecInfo.CodecProfileLevel.AVCLevel62, 139264, 16711680)
    )

    /** ITU-T H.265 Annex A：MaxLumaPs 亮度采样数 / MaxLumaSr 采样率。 */
    private val hevcLevels = listOf(
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel4, 2228224, 66846720),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel41, 2228224, 66846720),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel5, 8912896, 267386880),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel51, 8912896, 534773760),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel52, 8912896, 1069547520),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel6, 35651584, 1069547520),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel61, 35651584, 2139095040),
        Triple(MediaCodecInfo.CodecProfileLevel.HEVCMainTierLevel62, 35651584, 4278190080L.toInt())
    )

    private fun avcLevelFor(width: Int, height: Int, fps: Int): Int {
        val mb = ceil(width / 16.0).toInt() * ceil(height / 16.0).toInt()
        val mbps = mb.toLong() * fps.coerceAtLeast(1)
        return avcLevels.firstOrNull { mb <= it.second && mbps <= it.third.toLong() }?.first
            ?: avcLevels.last().first
    }

    private fun hevcLevelFor(width: Int, height: Int, fps: Int): Int {
        val luma = width.toLong() * height.toLong()
        val rate = luma * fps.coerceAtLeast(1)
        return hevcLevels.firstOrNull { luma <= it.second && rate <= it.third.toLong() }?.first
            ?: hevcLevels.last().first
    }

    /**
     * 该编码格式 + 分辨率下，编码器愿意接受的 (profile, level)。
     * 返回 null 表示「不指定，交给编码器自己决定」——很多机型对显式档位更挑剔，
     * 指定会比不指定更容易 configure 失败，所以只在厂商确实声明支持时才写。
     */
    fun profileLevelFor(codec: VideoCodec, width: Int, height: Int, fps: Int): Pair<Int, Int>? {
        val enc = info(codec) ?: return null
        return when (codec) {
            VideoCodec.AVC -> {
                // 超过 1080p 就别指望 Baseline（Baseline 不支持 B 帧以外的高档特性，多数机型 >1080p 只给 High）
                val profile = if (width * height <= 1920 * 1080) {
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
                } else {
                    MediaCodecInfo.CodecProfileLevel.AVCProfileHigh
                }
                val level = avcLevelFor(width, height, fps)
                val effective = if (enc.hasProfile(profile, level)) {
                    level
                } else {
                    enc.maxLevelOf(profile)
                }
                if (effective == 0) null else profile to effective
            }

            VideoCodec.HEVC -> {
                val profile = MediaCodecInfo.CodecProfileLevel.HEVCProfileMain
                val level = hevcLevelFor(width, height, fps)
                val effective = if (enc.hasProfile(profile, level)) {
                    level
                } else {
                    enc.maxLevelOf(profile)
                }
                if (effective == 0) null else profile to effective
            }
        }
    }

    /**
     * 组装「相机能出 × 编码器能吃」的分辨率表。
     *
     * @param cameraSizes 相机输出尺寸（横置，宽 >= 高）
     * @param only 只保留该编码格式支持的项（null = AVC 与 HEVC 都考虑）
     * @param fps 目标帧率：编码器在该尺寸下跑不动这个帧率就剔除
     */
    fun buildResolutions(
        cameraSizes: List<Size>,
        only: VideoCodec?,
        fps: Int
    ): List<Resolution> {
        val avc = info(VideoCodec.AVC)
        val hevc = info(VideoCodec.HEVC)
        val out = ArrayList<Resolution>(cameraSizes.size)
        for (size in cameraSizes) {
            val w = maxOf(size.width, size.height)
            val h = minOf(size.width, size.height)
            if (w <= 0 || h <= 0) continue
            val avcOk = avc?.let { it.supportsSurface && it.supportsFps(w, h, fps) } == true
            val hevcOk = hevc?.let { it.supportsSurface && it.supportsFps(w, h, fps) } == true
            if (!avcOk && !hevcOk) continue
            if (only == VideoCodec.AVC && !avcOk) continue
            if (only == VideoCodec.HEVC && !hevcOk) continue
            val maxFps = maxOf(
                if (avcOk) avc?.maxFps(w, h) ?: 0 else 0,
                if (hevcOk) hevc?.maxFps(w, h) ?: 0 else 0
            )
            out.add(
                Resolution(
                    width = w,
                    height = h,
                    label = describe(w, h, avcOk, hevcOk),
                    avcOk = avcOk,
                    hevcOk = hevcOk,
                    maxFps = maxFps
                )
            )
        }
        // 同一尺寸可能相机报了两遍（横/竖），去重后按像素数降序
        return out.distinctBy { it.width to it.height }
            .sortedWith(compareByDescending<Resolution> { it.pixels }.thenByDescending { it.width })
    }

    // ------------------------------------------------------------- 方案编排

    /** 编排结果：这台设备上真正会跑的采集/编码参数。 */
    data class Plan(
        val width: Int,
        val height: Int,
        val codec: VideoCodec,
        val fps: Int,
        val notes: List<String>
    ) {
        val name: String get() = "$width×$height"
    }

    /** 读不到能力时的兜底表（不代表设备上限，只保证能出流）。 */
    private val fallbackSizes = listOf(
        Size(1920, 1080), Size(1280, 720), Size(854, 480), Size(640, 360)
    )

    /**
     * 把「想要的分辨率 + 编码格式 + 帧率」落到这台设备真正能做到的组合上。
     *
     * 1. 候选 = 相机输出 ∩ 硬编码器支持（含帧率），按像素数降序；
     * 2. 先精确匹配，其次同宽高比最近，最后全局最近；
     * 3. [CodecChoice.AUTO]：该分辨率 H.264 编得动就用 H.264（导播台可直接放），
     *    只有 H.265 编得动（8K/部分 4K）才用 H.265；指定格式但该分辨率编不动时
     *    退到该格式能编动的最大分辨率，并记一条说明；
     * 4. 帧率超过该分辨率的编码上限就夹到上限。
     */
    fun plan(
        cameraSizes: List<Size>,
        wantWidth: Int,
        wantHeight: Int,
        choice: CodecChoice,
        wantFps: Int
    ): Plan {
        val notes = ArrayList<String>(3)
        val base = if (cameraSizes.isEmpty()) fallbackSizes else cameraSizes
        if (cameraSizes.isEmpty()) notes.add("未能读取相机输出尺寸，按常见分辨率尝试")

        var pool = buildResolutions(base, only = null, fps = wantFps)
        if (pool.isEmpty()) {
            // 目标帧率在小尺寸上也可能被拒（罕见），放宽到 15fps 再试一次
            pool = buildResolutions(base, only = null, fps = 15)
        }
        if (pool.isEmpty() && base !== fallbackSizes) {
            pool = buildResolutions(fallbackSizes, only = null, fps = wantFps)
        }

        var candidates = when (choice) {
            CodecChoice.AUTO -> pool
            CodecChoice.AVC -> pool.filter { it.avcOk }
            CodecChoice.HEVC -> pool.filter { it.hevcOk }
        }
        if (candidates.isEmpty() && choice != CodecChoice.AUTO && pool.isNotEmpty()) {
            notes.add("该机型没有 ${choice.label} 能编动的分辨率，已改用另一种编码格式")
            candidates = pool
        }
        if (candidates.isEmpty()) {
            notes.add("相机与编码器没有共同支持的分辨率，按 1920×1080 H.264 尝试")
            return Plan(1920, 1080, VideoCodec.AVC, wantFps.coerceIn(15, 30), notes)
        }

        val picked = pickClosest(candidates, wantWidth, wantHeight)
        // 兜底：指定格式但连一个该格式的分辨率都没有时，按实际能编的选
        val codec = when (choice) {
            CodecChoice.AUTO -> if (picked.avcOk) VideoCodec.AVC else VideoCodec.HEVC
            CodecChoice.AVC -> if (picked.avcOk) VideoCodec.AVC else VideoCodec.HEVC
            CodecChoice.HEVC -> if (picked.hevcOk) VideoCodec.HEVC else VideoCodec.AVC
        }
        if (choice == CodecChoice.AUTO && codec == VideoCodec.HEVC) {
            notes.add("${picked.name} 超出 H.264 编码上限，自动使用 H.265")
        }
        if (picked.width != wantWidth || picked.height != wantHeight) {
            notes.add(
                "请求 ${wantWidth}×${wantHeight} 不可用，已改用 ${picked.name}（${codec.shortLabel}）"
            )
        }

        var fps = wantFps
        val cap = picked.maxFps
        if (cap in 1 until fps) {
            notes.add("${picked.name} 编码上限 $cap fps，已从 $fps fps 夹到 $cap")
            fps = cap
        }
        return Plan(picked.width, picked.height, codec, fps, notes)
    }

    private fun pickClosest(list: List<Resolution>, wantW: Int, wantH: Int): Resolution {
        list.firstOrNull { it.width == wantW && it.height == wantH }?.let { return it }
        val wantArea = wantW.toLong() * wantH
        val wantRatio = wantW.toDouble() / wantH
        val sameRatio = list.filter { abs(it.width.toDouble() / it.height - wantRatio) < 0.02 }
        val pool = sameRatio.ifEmpty { list }
        return pool.minByOrNull { abs(it.pixels.toLong() - wantArea) } ?: list.first()
    }

    private fun describe(w: Int, h: Int, avcOk: Boolean, hevcOk: Boolean): String {
        val name = when {
            w >= 7680 -> "8K"
            w >= 5120 -> "5K"
            w >= 3840 -> "4K"
            w >= 2560 -> "2.5K/1440p"
            w >= 1920 -> "1080p"
            w >= 1280 -> "720p"
            w >= 854 -> "480p"
            else -> "低清"
        }
        val note = when {
            hevcOk && !avcOk -> "  · 仅 H.265"
            else -> ""
        }
        return "$name  $w×$h$note"
    }
}
