package com.rtmp.camsender.rtmp

/**
 * 推流视频编码格式。
 *
 * 放在 rtmp 包里、且不引用任何 android.* 类型，是为了让协议自测
 * （tools/rtmp-selftest，纯 JVM）能把它和 [FlvTag] 一起编译验证。
 * [mime] 的取值与 android.media.MediaFormat 的同名常量完全一致。
 *
 * 8K 只可能走 HEVC：手机上的 AVC 硬编码器基本都止步于 4096 宽
 * （高通/联发科的 AVC 编码器上限多为 4096×2304 或 3840×2160），
 * 而 HEVC 编码器从骁龙 8 Gen 1 一代开始支持 7680×4320。
 */
enum class VideoCodec(
    /** MediaCodec 用的 MIME，等同于 MediaFormat.MIMETYPE_VIDEO_AVC / _HEVC。 */
    val mime: String,
    /** 短名，用于界面与日志。 */
    val shortLabel: String,
    /** 完整名。 */
    val displayName: String,
    /**
     * enhanced-RTMP（FLV 扩展头）里用的 FourCC；H.264 走传统 tag 头，为 null。
     * 非 null 表示必须用 [FlvTag] 的扩展头封装。
     */
    val flvFourCc: String?
) {
    AVC("video/avc", "H.264", "H.264/AVC", null),
    HEVC("video/hevc", "H.265", "H.265/HEVC", "hvc1");

    /** 是否必须走 enhanced-RTMP 扩展头封装。 */
    val enhanced: Boolean get() = flvFourCc != null

    companion object {
        fun ofMime(mime: String?): VideoCodec =
            entries.firstOrNull { it.mime == mime } ?: AVC

        /** 按分辨率粗判：超过 4096 宽只能 HEVC。 */
        fun requiresHevc(width: Int, height: Int): Boolean =
            width > 4096 || height > 4096
    }
}
