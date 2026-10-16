package com.rtmp.camsender.rtmp

import java.io.ByteArrayOutputStream

/**
 * H.264 / H.265 的 NAL 单元解析。
 *
 * 编码器输出的码流可能是 Annex-B（起始码 00 00 01）或长度前缀（4 字节大端），
 * 而 FLV 要求长度前缀；同时要从码流里抠出参数集来生成
 * AVCDecoderConfigurationRecord / HEVCDecoderConfigurationRecord。
 *
 * 本文件不引用 android.* 类型，可直接被纯 JVM 自测编译运行。
 */
object NalParse {

    // ---- H.264 NAL 类型（nal[0] & 0x1F） ----
    const val AVC_NAL_IDR = 5
    const val AVC_NAL_SPS = 7
    const val AVC_NAL_PPS = 8

    // ---- H.265 NAL 类型（(nal[0] >> 1) & 0x3F） ----
    const val HEVC_NAL_BLA_W_LP = 16
    const val HEVC_NAL_BLA_W_RADL = 17
    const val HEVC_NAL_BLA_N_LP = 18
    const val HEVC_NAL_IDR_W_RADL = 19
    const val HEVC_NAL_IDR_N_LP = 20
    const val HEVC_NAL_CRA = 21
    const val HEVC_NAL_VPS = 32
    const val HEVC_NAL_SPS = 33
    const val HEVC_NAL_PPS = 34

    /** 判断是否为 Annex-B（以 00 00 00 01 / 00 00 01 开头）。 */
    fun isAnnexB(data: ByteArray, length: Int = data.size): Boolean {
        if (length >= 4 && data[0] == ZERO && data[1] == ZERO &&
            data[2] == ZERO && data[3] == ONE
        ) return true
        if (length >= 3 && data[0] == ZERO && data[1] == ZERO && data[2] == ONE) return true
        return false
    }

    /** 拆出裸 NAL（不含起始码 / 长度前缀），两种封装都能处理。 */
    fun extractNals(data: ByteArray, length: Int = data.size): List<ByteArray> =
        if (isAnnexB(data, length)) extractAnnexB(data, length) else extractLengthPrefixed(data, length)

    private fun extractAnnexB(data: ByteArray, length: Int): List<ByteArray> {
        val out = ArrayList<ByteArray>(4)
        var i = 0
        var start = -1
        while (i + 2 < length) {
            val isStart = data[i] == ZERO && data[i + 1] == ZERO &&
                (data[i + 2] == ONE ||
                    (i + 3 < length && data[i + 2] == ZERO && data[i + 3] == ONE))
            if (isStart) {
                if (start >= 0 && i > start) out.add(data.copyOfRange(start, i))
                i += if (data[i + 2] == ONE) 3 else 4
                start = i
            } else {
                i++
            }
        }
        if (start in 0 until length) out.add(data.copyOfRange(start, length))
        return out
    }

    private fun extractLengthPrefixed(data: ByteArray, length: Int): List<ByteArray> {
        val out = ArrayList<ByteArray>(4)
        var pos = 0
        while (pos + 4 <= length) {
            val n = ((data[pos].toInt() and 0xFF) shl 24) or
                ((data[pos + 1].toInt() and 0xFF) shl 16) or
                ((data[pos + 2].toInt() and 0xFF) shl 8) or
                (data[pos + 3].toInt() and 0xFF)
            pos += 4
            if (n <= 0 || pos + n > length) break
            out.add(data.copyOfRange(pos, pos + n))
            pos += n
        }
        return out
    }

    /** 统一转成「4 字节大端长度 + NAL」格式（AVCC / hvcC 都适用）。 */
    fun toLengthPrefixed(data: ByteArray, length: Int = data.size): ByteArray {
        if (!isAnnexB(data, length)) return if (length == data.size) data else data.copyOf(length)
        return toLengthPrefixed(extractAnnexB(data, length))
    }

    fun toLengthPrefixed(nals: List<ByteArray>): ByteArray {
        var total = 0
        for (nal in nals) total += 4 + nal.size
        val out = ByteArrayOutputStream(total)
        for (nal in nals) {
            if (nal.isEmpty()) continue
            out.write((nal.size ushr 24) and 0xFF)
            out.write((nal.size ushr 16) and 0xFF)
            out.write((nal.size ushr 8) and 0xFF)
            out.write(nal.size and 0xFF)
            out.write(nal, 0, nal.size)
        }
        return out.toByteArray()
    }

    /** 把裸 NAL 列表拼回 Annex-B（用于把关键帧里夹带的参数集交给上层）。 */
    fun toAnnexB(nals: List<ByteArray>): ByteArray {
        val out = ByteArrayOutputStream(nals.sumOf { it.size + 4 })
        for (nal in nals) {
            out.write(0)
            out.write(0)
            out.write(0)
            out.write(1)
            out.write(nal, 0, nal.size)
        }
        return out.toByteArray()
    }

    fun nalType(nal: ByteArray, codec: VideoCodec): Int {
        if (nal.isEmpty()) return -1
        return when (codec) {
            VideoCodec.AVC -> nal[0].toInt() and 0x1F
            VideoCodec.HEVC -> (nal[0].toInt() and 0xFF) shr 1 and 0x3F
        }
    }

    /** 该 NAL 类型是否代表「随机访问点」（可解码起点）。 */
    fun isKeyFrameNal(type: Int, codec: VideoCodec): Boolean = when (codec) {
        VideoCodec.AVC -> type == AVC_NAL_IDR
        VideoCodec.HEVC ->
            type in HEVC_NAL_BLA_W_LP..HEVC_NAL_CRA ||
                type == HEVC_NAL_IDR_W_RADL || type == HEVC_NAL_IDR_N_LP
    }

    /** 该 NAL 类型是否是参数集（序列头内容）。 */
    fun isParamSetNal(type: Int, codec: VideoCodec): Boolean = when (codec) {
        VideoCodec.AVC -> type == AVC_NAL_SPS || type == AVC_NAL_PPS
        VideoCodec.HEVC -> type == HEVC_NAL_VPS || type == HEVC_NAL_SPS || type == HEVC_NAL_PPS
    }

    /**
     * 抠出参数集，按编解码器约定的顺序返回：
     *  - H.264 → [SPS, PPS]
     *  - H.265 → [VPS, SPS, PPS]
     * 缺哪个就少哪个（调用方按类型判断，不要按位置）。
     */
    fun findParamSets(data: ByteArray, length: Int = data.size, codec: VideoCodec): List<ByteArray> =
        findParamSets(extractNals(data, length), codec)

    fun findParamSets(nals: List<ByteArray>, codec: VideoCodec): List<ByteArray> {
        val order = when (codec) {
            VideoCodec.AVC -> intArrayOf(AVC_NAL_SPS, AVC_NAL_PPS)
            VideoCodec.HEVC -> intArrayOf(HEVC_NAL_VPS, HEVC_NAL_SPS, HEVC_NAL_PPS)
        }
        val picked = HashMap<Int, ByteArray>(order.size)
        for (nal in nals) {
            val t = nalType(nal, codec)
            if (t in order && !picked.containsKey(t)) picked[t] = nal
        }
        val out = ArrayList<ByteArray>(order.size)
        for (t in order) picked[t]?.let { out.add(it) }
        return out
    }

    /** 参数集是否齐全（够拼出序列头）。 */
    fun hasCompleteParamSets(nals: List<ByteArray>, codec: VideoCodec): Boolean {
        val types = nals.map { nalType(it, codec) }.toSet()
        return when (codec) {
            VideoCodec.AVC -> types.containsAll(listOf(AVC_NAL_SPS, AVC_NAL_PPS))
            VideoCodec.HEVC -> types.containsAll(
                listOf(HEVC_NAL_VPS, HEVC_NAL_SPS, HEVC_NAL_PPS)
            )
        }
    }

    /** 码流里是否含随机访问点（关键帧）。 */
    fun containsKeyFrame(data: ByteArray, length: Int = data.size, codec: VideoCodec): Boolean =
        extractNals(data, length).any { isKeyFrameNal(nalType(it, codec), codec) }

    /**
     * 参数集「指纹」：内容拼接后的字符串，用于判断序列头是否需要重发
     * （分辨率/档位变化时参数集内容会变，指纹随之改变）。
     */
    fun fingerprint(nals: List<ByteArray>): String {
        if (nals.isEmpty()) return ""
        val sb = StringBuilder(nals.size * 16)
        for (nal in nals) {
            sb.append(nal.size).append(':')
            for (b in nal) sb.append((b.toInt() and 0xFF).toString(16).padStart(2, '0'))
            sb.append(';')
        }
        return sb.toString()
    }

    private val ZERO = 0.toByte()
    private val ONE = 1.toByte()
}
