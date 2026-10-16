package com.rtmp.camsender.stream

import com.rtmp.camsender.rtmp.NalParse
import com.rtmp.camsender.rtmp.VideoCodec

/**
 * NAL 工具的薄封装，实际解析逻辑在 [NalParse]（rtmp 包，纯 Kotlin，可被协议自测覆盖）。
 *
 * 保留原有 H.264 专用 API 以免影响既有调用点，并补上按 [VideoCodec] 分派的通用 API。
 */
object NalUtil {

    const val NAL_SPS = NalParse.AVC_NAL_SPS
    const val NAL_PPS = NalParse.AVC_NAL_PPS
    const val NAL_IDR = NalParse.AVC_NAL_IDR

    /** 判断是否为 Annex-B（以 00 00 00 01 / 00 00 01 开头）。 */
    fun isAnnexB(data: ByteArray, length: Int = data.size): Boolean = NalParse.isAnnexB(data, length)

    /** 拆出裸 NAL（不含起始码 / 长度前缀），两种封装都能处理。 */
    fun extractNals(data: ByteArray, length: Int = data.size): List<ByteArray> =
        NalParse.extractNals(data, length)

    /** 把编码器输出统一转成「4 字节长度前缀 + NAL」。 */
    fun toAvcc(data: ByteArray, length: Int = data.size): ByteArray =
        NalParse.toLengthPrefixed(data, length)

    /** H.264 NAL 类型。 */
    fun nalType(nal: ByteArray): Int = NalParse.nalType(nal, VideoCodec.AVC)

    fun nalType(nal: ByteArray, codec: VideoCodec): Int = NalParse.nalType(nal, codec)

    /** 从一段码流里找出 H.264 的 SPS / PPS（顺序返回）。 */
    fun findParamSets(data: ByteArray, length: Int = data.size): Pair<ByteArray?, ByteArray?> {
        val nals = NalParse.findParamSets(data, length, VideoCodec.AVC)
        val sps = nals.firstOrNull { NalParse.nalType(it, VideoCodec.AVC) == NalParse.AVC_NAL_SPS }
        val pps = nals.firstOrNull { NalParse.nalType(it, VideoCodec.AVC) == NalParse.AVC_NAL_PPS }
        return sps to pps
    }

    /**
     * 按编码器抠参数集：[VideoCodec.AVC] → [SPS, PPS]；[VideoCodec.HEVC] → [VPS, SPS, PPS]。
     * 缺哪个少哪个，调用方按 NAL 类型判断而不是按位置。
     */
    fun findParamSets(data: ByteArray, length: Int = data.size, codec: VideoCodec): List<ByteArray> =
        NalParse.findParamSets(data, length, codec)

    fun findParamSets(nals: List<ByteArray>, codec: VideoCodec): List<ByteArray> =
        NalParse.findParamSets(nals, codec)

    fun hasCompleteParamSets(nals: List<ByteArray>, codec: VideoCodec): Boolean =
        NalParse.hasCompleteParamSets(nals, codec)

    /** 是否是关键帧（H.264 含 IDR / H.265 含 IRAP）。 */
    fun containsKeyFrame(data: ByteArray, length: Int = data.size, codec: VideoCodec): Boolean =
        NalParse.containsKeyFrame(data, length, codec)

    fun containsIdr(data: ByteArray, length: Int = data.size): Boolean =
        NalParse.containsKeyFrame(data, length, VideoCodec.AVC)

    /** 参数集「指纹」，用于判断序列头是否需要重发。 */
    fun fingerprint(nals: List<ByteArray>): String = NalParse.fingerprint(nals)
}
