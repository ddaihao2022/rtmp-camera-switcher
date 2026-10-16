package com.rtmp.camsender.rtmp

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * FLV 音视频 Tag 载荷构造器。
 *
 * 注意：通过 RTMP 发送时，消息载荷 = FLV Tag Body（不含 11 字节的 Tag Header），
 * 因此这里产出的字节直接交给 [RtmpPublisher.sendVideo] / [RtmpPublisher.sendAudio]。
 */
object FlvTag {

    const val TAG_AUDIO = 8
    const val TAG_VIDEO = 9
    const val TAG_DATA = 18

    private const val FLV_CODEC_ID_H264 = 7
    private const val FLV_CODEC_ID_AAC = 10

    private const val AVC_SEQUENCE_HEADER = 0
    private const val AVC_NALU = 1

    private const val AAC_SEQUENCE_HEADER = 0
    private const val AAC_RAW = 1

    // ---- enhanced-RTMP（FLV 扩展头，用于 H.265）----
    // 首字节布局：IsExHeader(1) | frameType(3) | videoPacketType(4)
    private const val EX_HEADER_FLAG = 0x80
    private const val FLV_FRAME_KEY = 1
    private const val FLV_FRAME_INTER = 2
    private const val VIDEO_PACKET_SEQUENCE_START = 0
    private const val VIDEO_PACKET_CODED_FRAMES = 1

    /**
     * AVCDecoderConfigurationRecord（FLV AVC sequence header）。
     * SPS/PPS 必须是 Annex-B 之外的裸 NAL（不含起始码 / 长度前缀）。
     */
    fun videoSequenceHeader(sps: ByteArray, pps: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(64)
        out.write(0x17) // frameType=1(key) | codecId=7(AVC)
        out.write(AVC_SEQUENCE_HEADER)
        out.write(0)
        out.write(0)
        out.write(0) // composition time = 0
        out.write(1) // configurationVersion
        out.write(sps[1].toInt() and 0xFF) // AVCProfileIndication
        out.write(sps[2].toInt() and 0xFF) // profile_compatibility
        out.write(sps[3].toInt() and 0xFF) // AVCLevelIndication
        out.write(0xFF) // lengthSizeMinusOne = 3 -> 4 字节长度前缀
        out.write(0xE1) // numOfSequenceParameterSets = 1
        out.write((sps.size ushr 8) and 0xFF)
        out.write(sps.size and 0xFF)
        out.write(sps, 0, sps.size)
        out.write(1) // numOfPictureParameterSets
        out.write((pps.size ushr 8) and 0xFF)
        out.write(pps.size and 0xFF)
        out.write(pps, 0, pps.size)
        return out.toByteArray()
    }

    /**
     * @param avcc 已经是「4 字节大端长度 + NAL」格式的数据
     * @param compositionTimeMs B 帧偏移，MediaCodec 实时采集恒为 0
     */
    fun videoFrame(avcc: ByteArray, keyFrame: Boolean, compositionTimeMs: Int): ByteArray {
        val out = ByteArray(5 + avcc.size)
        out[0] = if (keyFrame) 0x17 else 0x27
        out[1] = AVC_NALU.toByte()
        out[2] = ((compositionTimeMs shr 16) and 0xFF).toByte()
        out[3] = ((compositionTimeMs shr 8) and 0xFF).toByte()
        out[4] = (compositionTimeMs and 0xFF).toByte()
        System.arraycopy(avcc, 0, out, 5, avcc.size)
        return out
    }

    // ------------------------------------------------------------------ H.265
    // H.265 不在传统 FLV tag 头里有自己的 codecId（12 是私有扩展，播放器普遍不认），
    // 走 enhanced-RTMP 的扩展头：IsExHeader=1 + FourCC("hvc1")。
    // node-media-server v4 正是按这个格式判断 H.265 的（flv.js parserTag 里读 fourCC）。

    /** 扩展头首字节。 */
    private fun exVideoByte(keyFrame: Boolean, packetType: Int): Byte =
        (EX_HEADER_FLAG or ((if (keyFrame) FLV_FRAME_KEY else FLV_FRAME_INTER) shl 4) or packetType).toByte()

    /** 写入 4 字节 FourCC。 */
    private fun writeFourCc(out: ByteArray, offset: Int, fourCc: String) {
        for (i in 0 until 4) out[offset + i] = fourCc[i].code.toByte()
    }

    /**
     * HEVCDecoderConfigurationRecord（enhanced-RTMP 的 H.265 sequence header 载荷）。
     *
     * 前 12 个字节的 profile/tier/level/兼容位**直接从 SPS 里的
     * profile_tier_level() 复制**：SPS 的前 2 字节是 NAL 头，第 3 字节是
     * (vps_id 4 + max_sub_layers_minus1 3 + nesting 1)，PTL 从 SPS[3] 开始，
     * 而 PTL 的前 12 字节恰好就是 configuration record 的 1..12 字节。
     */
    fun hevcConfigRecord(vps: ByteArray, sps: ByteArray, pps: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(sps.size + vps.size + pps.size + 32)
        out.write(1) // configurationVersion
        if (sps.size >= 15) {
            out.write(sps, 3, 12) // general_profile_space/tier/profile_idc + 兼容位 + constraint + level_idc
        } else {
            // SPS 太短（异常码流）：退化为 Main profile / level 3.1 的可解析默认值
            out.write(byteArrayOf(0x01, 0x60, 0x00, 0x00, 0x00, 0x90.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00, 0x5D),
                0, 12)
        }
        out.write(0xF0) // min_spatial_segmentation_idc(12) = 0 + reserved
        out.write(0x00)
        out.write(0xFC) // parallelismType = 0 + reserved
        out.write(0xFD) // chromaFormat = 1 (4:2:0) + reserved
        out.write(0xF8) // bitDepthLumaMinus8 = 0 + reserved
        out.write(0xF8) // bitDepthChromaMinus8 = 0 + reserved
        out.write(0) // avgFrameRate 高字节
        out.write(0) // avgFrameRate 低字节
        out.write(0x03) // constantFrameRate|numTemporalLayers|temporalIdNested|lengthSizeMinusOne=3(4 字节)
        val sets = listOf(
            NalParse.HEVC_NAL_VPS to vps,
            NalParse.HEVC_NAL_SPS to sps,
            NalParse.HEVC_NAL_PPS to pps
        )
        out.write(sets.size) // numOfArrays
        for ((type, nal) in sets) {
            out.write(0x20 or type) // array_completeness=0 | reserved=0 | NAL_unit_type
            out.write((1 ushr 8) and 0xFF) // numNalus 高字节
            out.write(1 and 0xFF) // numNalus 低字节
            out.write((nal.size ushr 8) and 0xFF)
            out.write(nal.size and 0xFF)
            out.write(nal, 0, nal.size)
        }
        return out.toByteArray()
    }

    /** H.265 序列头：扩展头 + "hvc1" + hvcC。 */
    fun hevcSequenceHeader(vps: ByteArray, sps: ByteArray, pps: ByteArray): ByteArray {
        val record = hevcConfigRecord(vps, sps, pps)
        val out = ByteArray(5 + record.size)
        out[0] = exVideoByte(keyFrame = true, packetType = VIDEO_PACKET_SEQUENCE_START)
        writeFourCc(out, 1, VideoCodec.HEVC.flvFourCc!!)
        System.arraycopy(record, 0, out, 5, record.size)
        return out
    }

    /**
     * H.265 视频帧：扩展头 + "hvc1" + compositionTime(3 字节) + 长度前缀 NALU。
     *
     * @param avcc 已经是「4 字节大端长度 + NAL」格式
     * @param compositionTimeMs B 帧偏移，实时采集恒为 0
     */
    fun hevcFrame(avcc: ByteArray, keyFrame: Boolean, compositionTimeMs: Int): ByteArray {
        val out = ByteArray(8 + avcc.size)
        out[0] = exVideoByte(keyFrame = keyFrame, packetType = VIDEO_PACKET_CODED_FRAMES)
        writeFourCc(out, 1, VideoCodec.HEVC.flvFourCc!!)
        out[5] = ((compositionTimeMs shr 16) and 0xFF).toByte()
        out[6] = ((compositionTimeMs shr 8) and 0xFF).toByte()
        out[7] = (compositionTimeMs and 0xFF).toByte()
        System.arraycopy(avcc, 0, out, 8, avcc.size)
        return out
    }

    /** 按编码器自动选择序列头 / 帧的封装方式。 */
    fun sequenceHeader(codec: VideoCodec, paramSets: List<ByteArray>): ByteArray? {
        return when (codec) {
            VideoCodec.AVC -> {
                val sps = paramSets.firstOrNull {
                    NalParse.nalType(it, codec) == NalParse.AVC_NAL_SPS
                } ?: return null
                val pps = paramSets.firstOrNull {
                    NalParse.nalType(it, codec) == NalParse.AVC_NAL_PPS
                } ?: return null
                videoSequenceHeader(sps, pps)
            }

            VideoCodec.HEVC -> {
                val vps = paramSets.firstOrNull {
                    NalParse.nalType(it, codec) == NalParse.HEVC_NAL_VPS
                } ?: return null
                val sps = paramSets.firstOrNull {
                    NalParse.nalType(it, codec) == NalParse.HEVC_NAL_SPS
                } ?: return null
                val pps = paramSets.firstOrNull {
                    NalParse.nalType(it, codec) == NalParse.HEVC_NAL_PPS
                } ?: return null
                hevcSequenceHeader(vps, sps, pps)
            }
        }
    }

    fun frame(codec: VideoCodec, payload: ByteArray, keyFrame: Boolean, compositionTimeMs: Int): ByteArray =
        when (codec) {
            VideoCodec.AVC -> videoFrame(payload, keyFrame, compositionTimeMs)
            VideoCodec.HEVC -> hevcFrame(payload, keyFrame, compositionTimeMs)
        }

    /** AudioSpecificConfig（AAC sequence header），由 MediaCodec 的 csd-0 直接给出。 */    fun audioSequenceHeader(asc: ByteArray): ByteArray {
        val out = ByteArray(2 + asc.size)
        out[0] = 0xAF.toByte() // soundFormat=10(AAC) | 44k | 16bit | stereo
        out[1] = AAC_SEQUENCE_HEADER.toByte()
        System.arraycopy(asc, 0, out, 2, asc.size)
        return out
    }

    /** @param aac 裸 AAC 帧（不含 ADTS 头），MediaCodec 输出即为裸帧。 */
    fun audioFrame(aac: ByteArray, offset: Int, length: Int): ByteArray {
        val out = ByteArray(2 + length)
        out[0] = 0xAF.toByte()
        out[1] = AAC_RAW.toByte()
        System.arraycopy(aac, offset, out, 2, length)
        return out
    }

    /** 直接从 MediaCodec 的 ByteBuffer 构造 AAC 帧，省去一次中间拷贝。 */
    fun audioFrame(buf: ByteBuffer, offset: Int, length: Int): ByteArray {
        val out = ByteArray(2 + length)
        out[0] = 0xAF.toByte()
        out[1] = AAC_RAW.toByte()
        val dup = buf.duplicate()
        dup.position(offset)
        dup.get(out, 2, length)
        return out
    }

    /**
     * onMetaData。node-media-server 会把 width/height/framerate/videodatarate 等
     * 解析出来挂在 publisher 上，导播台左侧列表与诊断面板即可显示分辨率与码率。
     *
     * [videoCodec] 决定 videocodecid：H.264 用传统数字 7；H.265 按 enhanced-RTMP 规范
     * 用字符串 FourCC "hvc1"（导播台据此把该路标成 H.265/HEVC 并提示内置播放器不支持）。
     */
    fun metadata(
        width: Int,
        height: Int,
        fps: Int,
        videoKbps: Int,
        audioKbps: Int,
        sampleRate: Int,
        stereo: Boolean,
        encoder: String = "Android MediaCodec",
        videoCodec: VideoCodec = VideoCodec.AVC
    ): ByteArray {
        val meta = linkedMapOf<String, Any?>(
            "duration" to 0.0,
            "width" to width,
            "height" to height,
            "videodatarate" to videoKbps.toDouble(),
            "framerate" to fps.toDouble(),
            "videocodecid" to when (videoCodec) {
                VideoCodec.AVC -> FLV_CODEC_ID_H264.toDouble()
                VideoCodec.HEVC -> videoCodec.flvFourCc
            },
            "audiodatarate" to audioKbps.toDouble(),
            "audiosamplerate" to sampleRate.toDouble(),
            "audiosamplesize" to 16.0,
            "audiochannels" to (if (stereo) 2 else 1),
            "stereo" to stereo,
            "audiocodecid" to FLV_CODEC_ID_AAC.toDouble(),
            "encoder" to encoder,
            "filesize" to 0.0
        )
        return Amf0.encodeSetDataFrame(meta)
    }
}
