package com.rtmp.camsender.rtmp

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * 在 JVM 上跑的真实协议自测：把 android/app 里的 rtmp 包原样编译，
 * 对真实 node-media-server 推一路合成码流，再从 HTTP-FLV 拉回来校验。
 *
 * 该目录不参与 Android 构建（在 app/src 之外），只在开发机上手工运行：
 *   java -cp kotlin-compiler-embeddable.jar org.jetbrains.kotlin.cli.jvm.K2JVMCompiler ...
 */
object TestMain {

    @JvmStatic
    fun main(args: Array<String>) {
        val host = if (args.isNotEmpty()) args[0] else "127.0.0.1"
        val key = if (args.size > 1) args[1] else "selftest"
        var failures = 0

        fun check(name: String, ok: Boolean, extra: String = "") {
            if (ok) {
                println("PASS  $name $extra")
            } else {
                failures++
                println("FAIL  $name $extra")
            }
        }

        // 1) AMF0 编解码往返
        val cmd = Amf0.encodeCommand("connect", 1.0, listOf(mapOf("app" to "live", "tcUrl" to "rtmp://h/live")))
        val decoded = Amf0.decode(cmd, 0, cmd.size)
        check("amf0 command roundtrip", decoded.getOrNull(0) == "connect" && (decoded.getOrNull(1) as? Double) == 1.0)
        val obj = decoded.getOrNull(2) as? Map<*, *>
        check("amf0 object roundtrip", obj?.get("app") == "live")

        val meta = Amf0.encodeSetDataFrame(linkedMapOf("width" to 1280, "height" to 720, "stereo" to false))
        val metaDecoded = Amf0.decode(meta, 0, meta.size)
        check("amf0 setDataFrame layout", metaDecoded.getOrNull(0) == "@setDataFrame" && metaDecoded.getOrNull(1) == "onMetaData")
        val dataObj = metaDecoded.getOrNull(2) as? Map<*, *>
        check("amf0 ecma array", (dataObj?.get("width") as? Double) == 1280.0 && dataObj?.get("stereo") == false)

        // 2) FLV 封装结构
        //    tag body: [0]=flags [1]=AVCPacketType [2..4]=CTS [5]=configVersion
        //              [6]=profile [7]=compat [8]=level [9]=lengthSizeMinusOne
        //              [10]=numSPS [11..12]=spsLen [13..]=sps
        val sps = byteArrayOf(0x67, 0x42, 0x00, 0x1E, 0x11.toByte(), 0x22, 0x33, 0x44, 0x55)
        val pps = byteArrayOf(0x68, 0x11, 0x22, 0x33)
        val seq = FlvTag.videoSequenceHeader(sps, pps)
        check("flv avc seq header keyflag/codecid", (seq[0].toInt() and 0xFF) == 0x17)
        check("flv avc seq header type", seq[1].toInt() == 0)
        check("flv avc config record version", seq[5].toInt() == 1)
        check("flv avc config record profile", seq[6].toInt() == 0x42, "got=${seq[6]}")
        check("flv avc config record level", seq[8].toInt() == 0x1E, "got=${seq[8]}")
        check("flv avc config record lengthSize", (seq[9].toInt() and 0xFF) == 0xFF, "got=${seq[9]}")
        check("flv avc config record numSPS", (seq[10].toInt() and 0x1F) == 1)
        val spsLen = ((seq[11].toInt() and 0xFF) shl 8) or (seq[12].toInt() and 0xFF)
        check("flv avc config sps length", spsLen == sps.size && seq[13] == 0x67.toByte(), "len=$spsLen")
        val ppsLen = ((seq[14 + sps.size].toInt() and 0xFF) shl 8) or (seq[15 + sps.size].toInt() and 0xFF)
        check("flv avc config pps", ppsLen == pps.size, "len=$ppsLen total=${seq.size}")

        val frame = FlvTag.videoFrame(byteArrayOf(0, 0, 0, 2, 0x65, 0x01), true, 5)
        check("flv video frame header", (frame[0].toInt() and 0xFF) == 0x17 && frame[1].toInt() == 1)
        check("flv video frame cts", frame[2].toInt() == 0 && frame[4].toInt() == 5)

        val a = FlvTag.audioFrame(byteArrayOf(1, 2, 3, 4), 0, 4)
        check("flv audio frame header", (a[0].toInt() and 0xFF) == 0xAF && a[1].toInt() == 1)

        // 2b) H.265（8K 只能靠它）的字节布局：增强型 RTMP 扩展头 + hvcC 配置记录
        //     tag body = [flags][FourCC hvc1][配置记录 / CTS + 负载]
        val vps = byteArrayOf(0x40, 0x01, 0x0C) + ByteArray(20) { (it + 1).toByte() }
        val hevcSps = byteArrayOf(0x42, 0x01, 0x01, 0x60) + ByteArray(18) { 0xAA.toByte() }
        val hevcPps = byteArrayOf(0x44, 0x01) + ByteArray(6) { 0xBB.toByte() }

        val hevcSeq = FlvTag.sequenceHeader(VideoCodec.HEVC, listOf(vps, hevcSps, hevcPps))
        if (hevcSeq == null) {
            check("flv hevc sequence header", false, "序列头为空")
        } else {
            check(
                "flv hevc seq: 扩展头|关键帧|SequenceStart = 0x90",
                (hevcSeq[0].toInt() and 0xFF) == 0x90,
                "byte0=0x%02X".format(hevcSeq[0].toInt() and 0xFF)
            )
            check("flv hevc seq: FourCC = hvc1", String(hevcSeq, 1, 4, Charsets.ISO_8859_1) == "hvc1")
            check("flv hevc config: version = 1", hevcSeq[5].toInt() == 1)
            check(
                "flv hevc config: 12 字节 PTL 取自 SPS[3..14]",
                hevcSeq.copyOfRange(6, 18).contentEquals(hevcSps.copyOfRange(3, 15))
            )
            check(
                "flv hevc config: 保留位/chromaFormat/位深/avgFrameRate",
                (hevcSeq[18].toInt() and 0xFF) == 0xF0 && (hevcSeq[19].toInt() and 0xFF) == 0x00 &&
                    (hevcSeq[20].toInt() and 0xFF) == 0xFC && (hevcSeq[21].toInt() and 0xFF) == 0xFD &&
                    (hevcSeq[22].toInt() and 0xFF) == 0xF8 && (hevcSeq[23].toInt() and 0xFF) == 0xF8 &&
                    (hevcSeq[24].toInt() and 0xFF) == 0x00 && (hevcSeq[25].toInt() and 0xFF) == 0x00,
                "13..18=" + (18..25).joinToString(" ") { "%02X".format(hevcSeq[it].toInt() and 0xFF) }
            )
            check(
                "flv hevc config: lengthSizeMinusOne=3 且 numOfArrays=3",
                (hevcSeq[26].toInt() and 0xFF) == 0x03 && (hevcSeq[27].toInt() and 0xFF) == 3
            )
            var p = 28
            val arrays = ArrayList<Pair<Int, ByteArray>>(3)
            for (n in 0 until 3) {
                val rawHead = hevcSeq[p].toInt() and 0xFF
                val numNalus = ((hevcSeq[p + 1].toInt() and 0xFF) shl 8) or (hevcSeq[p + 2].toInt() and 0xFF)
                val nalLen = ((hevcSeq[p + 3].toInt() and 0xFF) shl 8) or (hevcSeq[p + 4].toInt() and 0xFF)
                arrays.add(rawHead to hevcSeq.copyOfRange(p + 5, p + 5 + nalLen))
                check("flv hevc array[$n] numNalus = 1", numNalus == 1, "got=$numNalus")
                p += 5 + nalLen
            }
            check(
                "flv hevc arrays 顺序 = VPS(0x20)/SPS(0x21)/PPS(0x22)",
                arrays.map { it.first } == listOf(0x20, 0x21, 0x22),
                arrays.joinToString(" ") { "%02X".format(it.first) }
            )
            check(
                "flv hevc arrays 内容与输入一致",
                arrays[0].second.contentEquals(vps) && arrays[1].second.contentEquals(hevcSps) &&
                    arrays[2].second.contentEquals(hevcPps)
            )
            check("flv hevc config 总长度自洽", p == hevcSeq.size, "p=$p size=${hevcSeq.size}")
        }

        val hevcFrameKey = FlvTag.frame(
            VideoCodec.HEVC, byteArrayOf(0, 0, 0, 4, 0x26, 0x01, 0x02, 0x03), true, 0
        )
        check(
            "flv hevc keyframe: 扩展头|关键帧|CodedFrames = 0x91",
            (hevcFrameKey[0].toInt() and 0xFF) == 0x91,
            "byte0=0x%02X".format(hevcFrameKey[0].toInt() and 0xFF)
        )
        check("flv hevc keyframe: FourCC = hvc1", String(hevcFrameKey, 1, 4, Charsets.ISO_8859_1) == "hvc1")
        check(
            "flv hevc keyframe: 3 字节 CTS 在 [5..7]，负载从第 8 字节起",
            hevcFrameKey.size == 8 + 8 && hevcFrameKey[5].toInt() == 0 && hevcFrameKey[7].toInt() == 0 &&
                (hevcFrameKey[11].toInt() and 0xFF) == 4,
            "size=${hevcFrameKey.size}"
        )
        val hevcFrameInter = FlvTag.frame(VideoCodec.HEVC, byteArrayOf(0, 0, 0, 2, 0x02, 0x01), false, 0)
        check(
            "flv hevc 非关键帧: 扩展头|中间帧|CodedFrames = 0xA1",
            (hevcFrameInter[0].toInt() and 0xFF) == 0xA1,
            "byte0=0x%02X".format(hevcFrameInter[0].toInt() and 0xFF)
        )

        val hevcMeta = FlvTag.metadata(
            7680, 4320, 30, 80000, 128, 48000, true, "jvm-selftest-8k", VideoCodec.HEVC
        )
        val hevcMetaObj = Amf0.decode(hevcMeta, 0, hevcMeta.size).getOrNull(2) as? Map<*, *>
        check(
            "onMetaData 8K 尺寸",
            (hevcMetaObj?.get("width") as? Double) == 7680.0 && (hevcMetaObj?.get("height") as? Double) == 4320.0,
            "w=${hevcMetaObj?.get("width")} h=${hevcMetaObj?.get("height")}"
        )
        check(
            "onMetaData videocodecid = hvc1",
            hevcMetaObj?.get("videocodecid") == "hvc1",
            "got=${hevcMetaObj?.get("videocodecid")}"
        )
        val avcMeta = FlvTag.metadata(1280, 720, 30, 2000, 96, 44100, false, "jvm-selftest")
        val avcMetaObj = Amf0.decode(avcMeta, 0, avcMeta.size).getOrNull(2) as? Map<*, *>
        check(
            "onMetaData videocodecid = 7（H.264 默认值未受影响）",
            (avcMetaObj?.get("videocodecid") as? Double) == 7.0,
            "got=${avcMetaObj?.get("videocodecid")}"
        )

        // 2c) NAL 解析（H.265 与 H.264 的 NAL 头布局不同）
        val hevcAnnexB = ByteArrayOutputStream().apply {
            write(byteArrayOf(0, 0, 0, 1)); write(vps)
            write(byteArrayOf(0, 0, 0, 1)); write(hevcSps)
            write(byteArrayOf(0, 0, 0, 1)); write(hevcPps)
            write(byteArrayOf(0, 0, 0, 1)); write(byteArrayOf(0x26, 0x01, 0xAF.toByte(), 0x00))
        }.toByteArray()
        val hevcNals = NalParse.extractNals(hevcAnnexB, hevcAnnexB.size)
        check("nalparse hevc: 拆出 4 个 NAL", hevcNals.size == 4, "n=${hevcNals.size}")
        val hevcTypes = hevcNals.map { NalParse.nalType(it, VideoCodec.HEVC) }
        check("nalparse hevc: 类型 = VPS(32)/SPS(33)/PPS(34)/IDR(19)", hevcTypes == listOf(32, 33, 34, 19), "$hevcTypes")
        val hevcPs = NalParse.findParamSets(hevcAnnexB, hevcAnnexB.size, VideoCodec.HEVC)
        check(
            "nalparse hevc: 参数集顺序 VPS→SPS→PPS",
            hevcPs.size == 3 && hevcPs[0].contentEquals(vps) &&
                hevcPs[1].contentEquals(hevcSps) && hevcPs[2].contentEquals(hevcPps),
            "n=${hevcPs.size}"
        )
        check("nalparse hevc: 参数集完整", NalParse.hasCompleteParamSets(hevcPs, VideoCodec.HEVC))
        check("nalparse hevc: 关键帧判定", NalParse.containsKeyFrame(hevcAnnexB, hevcAnnexB.size, VideoCodec.HEVC))
        check(
            "nalparse hevc: 非关键帧判定（TRAIL_R=1）",
            !NalParse.containsKeyFrame(byteArrayOf(0, 0, 0, 1, 0x02, 0x01, 0x00, 0x00), 8, VideoCodec.HEVC)
        )
        check(
            "nalparse avc 回归: 关键帧/参数集",
            NalParse.containsKeyFrame(
                byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0x11, 0, 0, 0, 1, 0x65, 0x01), 18,
                VideoCodec.AVC
            ) && NalParse.findParamSets(
                byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0x11, 0, 0, 0, 1, 0x65, 0x01), 18,
                VideoCodec.AVC
            ).size == 2
        )
        check(
            "nalutil fingerprint: SPS 变化能识别（参数集变更时重发序列头）",
            NalParse.fingerprint(listOf(sps, pps)) !=
                NalParse.fingerprint(listOf(sps.copyOf().also { it[3] = 0x2B }, pps))
        )
        check("VideoCodec.requiresHevc: 8K 必需 H.265", VideoCodec.HEVC.enhanced && !VideoCodec.AVC.enhanced)

        // 3) 真实推流
        val pub = RtmpPublisher(object : RtmpPublisher.Listener {
            override fun onLog(message: String) = println("      [pub] $message")
            override fun onError(message: String, cause: Throwable?) {
                println("      [pub][error] $message")
                cause?.printStackTrace()
            }

            override fun onClosed() = println("      [pub] closed")
        })

        try {
            pub.connectAndPublish(host, 1935, "live", key)
            check("rtmp connect + publish", true)
        } catch (e: Throwable) {
            check("rtmp connect + publish", false, e.toString())
            return
        }

        pub.sendData(FlvTag.metadata(1280, 720, 30, 2000, 96, 44100, false, "jvm-selftest"), 0)
        pub.sendVideo(seq, 0)

        // 合成 AAC + H.264 帧，按 30fps 推 2 秒
        val asc = byteArrayOf(0x12, 0x08)
        pub.sendAudio(FlvTag.audioSequenceHeader(asc), 0)
        val start = System.currentTimeMillis()
        var i = 0
        while (System.currentTimeMillis() - start < 2000) {
            val ts = System.currentTimeMillis() - start
            val key = i % 30 == 0
            val payload = ByteArray(300) { (it + i).toByte() }
            val avcc = ByteArrayOutputStream().apply {
                write(byteArrayOf(0, 0, 1, 100))
                write(payload, 0, 100)
                write(byteArrayOf(0, 0, 0, 40))
                write(payload, 0, 40)
            }.toByteArray()
            pub.sendVideo(FlvTag.videoFrame(avcc, key, 0), ts)
            pub.sendAudio(FlvTag.audioFrame(ByteArray(120) { (it + i).toByte() }, 0, 120), ts)
            i++
            Thread.sleep(33)
        }
        check("pushed frames", i > 30, "frames=$i dropped=${pub.droppedPackets.get()} bytes=${pub.bytesSent.get()}")

        // 4) 服务器是否登记了这路流
        val streams = httpGet("http://$host:3001/api/streams")
        check("server /api/streams contains key", streams.contains(key), streams.take(400))

        // 5) HTTP-FLV 回放：拿到 FLV 头与足够数据
        val flv = httpGetBytes("http://$host:8000/live/$key.flv", 3.0)
        val headerOk = flv.size > 13 && flv[0] == 'F'.code.toByte() && flv[1] == 'L'.code.toByte() &&
            flv[2] == 'V'.code.toByte() && flv[3] == 1.toByte()
        check("http-flv header", headerOk, "bytes=${flv.size}")
        val text = String(flv, Charsets.ISO_8859_1)
        check("http-flv contains onMetaData", text.contains("onMetaData"))
        check("http-flv contains encoder tag", text.contains("jvm-selftest"))

        // 6) 重新拉流时能收到缓存的 sequence header（后进观众可解码）
        check("http-flv has avc seq header", text.contains("\u0017\u0000\u0000\u0000\u0000"), "")

        pub.close()
        Thread.sleep(300)

        // 7) 断开后服务器应清理该路流
        val after = httpGet("http://$host:3001/api/streams")
        check("server cleaned up after close", !after.contains(key), after.take(300))

        // 8) 非 ASCII 机位名：已知的 node-media-server 缺陷，此处做定点诊断
        //
        //    node_modules/node-media-server/src/protocol/amf.js:287
        //      function amf0encString(str) { buf.writeUInt16BE(str.length, 1); ... }
        //    这里写的是 JS 字符串长度（UTF-16 码元数），而随后 concat 的是 UTF-8 字节，
        //    对非 ASCII 两者不一致，服务端发出的 onStatus 描述字段长度就错位了。
        //    导播台把 streamKey 当设备名，因此机位名必须限制为 ASCII。
        //
        //    本段验证两点：① 服务端 HTTP API 侧照样登记该流；
        //                 ② 我方解码器明确报错，而不是静默卡死（界面能给出提示）。
        println("      --- 非 ASCII 机位名诊断 ---")
        val cnKey = "一号机位"
        var amfDecodeError = false
        var amfHex: String? = null
        val pub2 = RtmpPublisher(object : RtmpPublisher.Listener {
            override fun onLog(message: String) {
                println("      [cn] $message")
                if (message.contains("hex=")) amfHex = message.substringAfter("hex=")
            }

            override fun onError(message: String, cause: Throwable?) {
                println("      [cn][error] $message")
                if (message.contains("解析服务器消息失败")) amfDecodeError = true
            }

            override fun onClosed() = Unit
        })
        try {
            pub2.connectAndPublish(host, 1935, "live", cnKey)
            pub2.sendData(FlvTag.metadata(640, 360, 25, 1000, 64, 44100, false, "cn-selftest"), 0)
            pub2.sendVideo(seq, 0)
            pub2.sendAudio(FlvTag.audioSequenceHeader(asc), 0)
            val t0 = System.currentTimeMillis()
            while (System.currentTimeMillis() - t0 < 600) {
                pub2.sendVideo(FlvTag.videoFrame(byteArrayOf(0, 0, 0, 2, 0x65, 0x01), false, 0), 0)
                Thread.sleep(40)
            }
        } catch (e: Throwable) {
            println("      [cn] publish 未完成（符合预期）：${e.message}")
        } finally {
            pub2.close()
        }

        check("非 ASCII 机位名被明确报错而非静默卡死", amfDecodeError)

        // 从服务端原始应答里量出长度字段错位：声明（UTF-16 码元数）< 实际（UTF-8 字节数）
        val hex = amfHex
        if (hex == null) {
            check("捕获服务端 onStatus 原始报文", false, "未拿到 hex")
        } else {
            val keyHex = "000b6465736372697074696f6e" // 属性名 "description"
            val k = hex.indexOf(keyHex)
            if (k < 0) {
                check("定位 onStatus.description", false, hex.take(60))
            } else {
                val declared = hex.substring(k + keyHex.length + 2, k + keyHex.length + 6).toInt(16)
                val body = hex.substring(k + keyHex.length + 6)
                val end = body.indexOf("000009") // 对象结束标记
                val actual = (if (end > 0) end else body.length) / 2
                println("      description：声明长度=$declared 字节，实际长度=$actual 字节（含中文的路径）")
                check(
                    "服务端 AMF0 非 ASCII 长度字段错位（amf.js:287）",
                    declared < actual && declared == "/live/$cnKey is now published.".length,
                    "声明=$declared 实际=$actual"
                )
            }
        }

        // 9) H.265 / 8K 端到端：推一路 7680x4320 的 H.265，验证服务端识别与 HTTP-FLV 封装。
        //    服务端不解码视频，只按 FLV tag 的 FourCC 判别编码格式，因此这里用合成的
        //    VPS/SPS/PPS + IDR 就足以验证整条链路（真机上是 MediaCodec 出的真实码流）。
        println("      --- H.265 / 8K 端到端 ---")
        val hevcKey = "selftest8k"
        val pub3 = RtmpPublisher(object : RtmpPublisher.Listener {
            override fun onLog(message: String) = println("      [8k] $message")
            override fun onError(message: String, cause: Throwable?) {
                println("      [8k][error] $message")
                cause?.printStackTrace()
            }

            override fun onClosed() = Unit
        })
        var hevcConnected = true
        try {
            pub3.connectAndPublish(host, 1935, "live", hevcKey)
        } catch (e: Throwable) {
            hevcConnected = false
            check("8K/H.265 rtmp connect + publish", false, e.toString())
        }

        if (hevcConnected) {
            check("8K/H.265 rtmp connect + publish", true)
            pub3.sendData(
                FlvTag.metadata(7680, 4320, 30, 80000, 128, 48000, true, "jvm-selftest-8k", VideoCodec.HEVC),
                0
            )
            pub3.sendAudio(FlvTag.audioSequenceHeader(asc), 0)
            pub3.sendVideo(hevcSeq ?: ByteArray(0), 0)

            val t8 = System.currentTimeMillis()
            var k = 0
            while (System.currentTimeMillis() - t8 < 1200) {
                val ts = System.currentTimeMillis() - t8
                val isKey = k % 30 == 0
                val nal = ByteArray(64) { (it + k).toByte() }
                val lp = ByteArrayOutputStream().apply {
                    write(byteArrayOf(0, 0, 0, (4 + nal.size).toByte()))
                    write(byteArrayOf(if (isKey) 0x26 else 0x02, 0x01))
                    write(nal)
                }.toByteArray()
                pub3.sendVideo(FlvTag.frame(VideoCodec.HEVC, lp, isKey, 0), ts)
                k++
                Thread.sleep(33)
            }
            check(
                "8K/H.265 推帧",
                k > 20,
                "frames=$k dropped=${pub3.droppedPackets.get()} bytes=${pub3.bytesSent.get()}"
            )

            val s8 = httpGet("http://$host:3001/api/streams")
            check(
                "服务端把该路识别为 H.265/HEVC",
                s8.contains("H.265") || s8.contains("HEVC") || s8.contains("hvc1"),
                s8.take(700)
            )
            check("服务端报告 8K 画幅 7680", s8.contains("7680"), s8.take(700))
            check(
                "服务端标记 browserPlayable=false（导播台内置 flv.js 不能解 H.265）",
                Regex("\"browserPlayable\"\\s*:\\s*false").containsMatchIn(s8),
                s8.take(700)
            )

            val flv8 = httpGetBytes("http://$host:8000/live/$hevcKey.flv", 3.0)
            val text8 = String(flv8, Charsets.ISO_8859_1)
            check("HTTP-FLV(H.265) 帧头合法", flv8.size > 13 && flv8[0] == 'F'.code.toByte(), "bytes=${flv8.size}")
            check("HTTP-FLV(H.265) 含 hvc1 FourCC", text8.contains("hvc1"), "bytes=${flv8.size}")
            check("HTTP-FLV(H.265) 含编码器标记", text8.contains("jvm-selftest-8k"))
            // 宽高在 AMF0 里是 IEEE754 大端双精度，不是 ASCII 数字：
            // 7680.0 = 40 BE 00 00 00 00 00 00，4320.0 = 40 B0 E0 00 00 00 00 00
            val want7680 = byteArrayOf(0x40, 0xBE.toByte(), 0, 0, 0, 0, 0, 0)
            val want4320 = byteArrayOf(0x40, 0xB0.toByte(), 0xE0.toByte(), 0, 0, 0, 0, 0)
            check(
                "HTTP-FLV(H.265) 元数据含 7680×4320",
                indexOf(flv8, want7680) >= 0 && indexOf(flv8, want4320) >= 0,
                "7680@${indexOf(flv8, want7680)} 4320@${indexOf(flv8, want4320)}"
            )
            check(
                "HTTP-FLV(H.265) 含扩展头序列头（0x90 + hvc1）",
                text8.contains("\u0090hvc1"),
                "hvc1@${text8.indexOf("hvc1")}"
            )

            pub3.close()
            Thread.sleep(400)
            val after8 = httpGet("http://$host:3001/api/streams")
            check("8K 路断开后被清理", !after8.contains(hevcKey), after8.take(300))
        }

        println(if (failures == 0) "\nALL TESTS PASSED" else "\n$failures TEST(S) FAILED")
        if (failures > 0) System.exit(1)
    }

    private fun httpGet(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 5000
        return try {
            conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Throwable) {
            "ERROR ${e.message}"
        } finally {
            conn.disconnect()
        }
    }

    private fun httpGetBytes(url: String, seconds: Double): ByteArray {
        val u = URL(url)
        val socket = Socket()
        socket.connect(InetSocketAddress(u.host, if (u.port > 0) u.port else 80), 3000)
        socket.soTimeout = 1500
        val path = if (u.file.isNullOrBlank()) "/" else u.file
        socket.getOutputStream().write(
            "GET $path HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n".toByteArray()
        )
        socket.getOutputStream().flush()

        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        val deadline = System.currentTimeMillis() + (seconds * 1000).toLong()
        try {
            while (System.currentTimeMillis() < deadline) {
                val n = socket.getInputStream().read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > 512 * 1024) break
            }
        } catch (e: Throwable) {
            // 超时属于正常（直播流不会结束）
        } finally {
            runCatching { socket.close() }
        }
        val raw = out.toByteArray()
        // 跳过 HTTP 头
        val marker = "\r\n\r\n".toByteArray()
        val idx = indexOf(raw, marker)
        val body = if (idx >= 0) raw.copyOfRange(idx + marker.size, raw.size) else raw
        // 服务器对 HTTP-FLV 用 chunked 传输
        val header = String(raw, 0, if (idx >= 0) idx else 0, Charsets.ISO_8859_1)
        return if (header.contains("chunked", ignoreCase = true)) dechunk(body) else body
    }

    /** 最小 chunked 解码：hex长度 CRLF data CRLF ... 0 CRLF CRLF */
    private fun dechunk(body: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < body.size) {
            var j = i
            while (j < body.size - 1 && !(body[j] == '\r'.code.toByte() && body[j + 1] == '\n'.code.toByte())) j++
            if (j >= body.size - 1) break
            val sizeLine = String(body, i, j - i, Charsets.ISO_8859_1).trim()
                .substringBefore(';').trim()
            val size = sizeLine.toIntOrNull(16) ?: break
            val start = j + 2
            if (size == 0) break
            if (start + size > body.size) {
                out.write(body, start, body.size - start)
                break
            }
            out.write(body, start, size)
            i = start + size + 2
        }
        return out.toByteArray()
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }
}
