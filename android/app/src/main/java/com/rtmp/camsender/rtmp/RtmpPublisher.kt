package com.rtmp.camsender.rtmp

import java.io.BufferedInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

/**
 * 一个足够用的 RTMP 推流客户端（FMLE 风格握手流程）：
 *
 *   握手(C0/C1 → S0/S1/S2 → C2) → SetChunkSize → connect → createStream → publish
 *   → @setDataFrame/onMetaData → 音视频消息(8/9)
 *
 * 已针对 node-media-server v4 校验：
 *  - 服务端接受 simple handshake（messageFormat 0）
 *  - 服务端 inChunkSize 初值是 128（rtmp.js: this.inChunkSize = RTMP_CHUNK_SIZE），
 *    connect 载荷超过 128 字节，因此**必须**先发 SetChunkSize 再发 connect，
 *    否则服务端会在 128 字节处当作新块头解析，connect 直接失效。
 *  - connect 必须带合法 tcUrl，app 取自 tcUrl 之外的单字段
 *  - publish 载荷顺序 [transId, cmdObj(null), streamName, type]
 *  - 服务端 SetChunkSize(65535)，我方发 SetChunkSize(4096) 后按 4096 分块
 */
class RtmpPublisher(private val listener: Listener) {

    interface Listener {
        fun onLog(message: String)
        fun onError(message: String, cause: Throwable?)
        fun onClosed()
    }

    companion object {
        const val CSID_CONTROL = 2
        const val CSID_COMMAND = 3
        const val CSID_AUDIO = 4
        const val CSID_DATA = 5
        const val CSID_VIDEO = 6

        private const val TYPE_SET_CHUNK_SIZE = 1
        private const val TYPE_ABORT = 2
        private const val TYPE_ACK = 3
        private const val TYPE_USER_CONTROL = 4
        private const val TYPE_WINDOW_ACK_SIZE = 5
        private const val TYPE_SET_PEER_BW = 6
        private const val TYPE_AUDIO = 8
        private const val TYPE_VIDEO = 9
        private const val TYPE_DATA_AMF0 = 18
        private const val TYPE_INVOKE_AMF0 = 20

        private const val HANDSHAKE_SIZE = 1536
        private const val OUT_CHUNK_SIZE = 4096
        private const val MAX_QUEUE = 240
        private const val STALL_TIMEOUT_MS = 12_000L
    }

    private class Pending(
        val csid: Int,
        val type: Int,
        val timestamp: Long,
        val payload: ByteArray
    )

    private class ChunkState {
        var timestamp = 0L
        var lastFieldTs = 0L
        var msgLength = 0
        var msgType = 0
        var msgStreamId = 0
    }

    private class Message(val csid: Int, val type: Int, val timestamp: Long, val payload: ByteArray)

    // ------------------------------------------------------------------ state

    private var socket: Socket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null

    private val running = AtomicBoolean(false)
    private val published = AtomicBoolean(false)

    private var readerThread: Thread? = null
    private var writerThread: Thread? = null
    private var watchdogThread: Thread? = null

    private val queue = LinkedBlockingQueue<Pending>(MAX_QUEUE)
    private val writeLock = Any()

    private val connectLatch = CountDownLatch(1)
    private val createStreamLatch = CountDownLatch(1)
    private val publishLatch = CountDownLatch(1)

    @Volatile private var outChunkSize = OUT_CHUNK_SIZE
    @Volatile private var inChunkSize = 128
    @Volatile private var messageStreamId = 1

    @Volatile private var connectResult: List<Any?>? = null
    @Volatile private var createStreamResult: List<Any?>? = null

    private val ackWindow = AtomicInteger(5_000_000)
    private val bytesRead = AtomicLong(0)

    val bytesSent = AtomicLong(0)
    val droppedPackets = AtomicLong(0)
    val isConnected: Boolean get() = running.get()

    /** 出队积压长度，用于判断上行是否拥塞。 */
    val queueSize: Int get() = queue.size

    private val lastWriteDone = AtomicLong(System.currentTimeMillis())

    // ------------------------------------------------------------------ public

    /**
     * 建立连接并开始推流。成功返回 true；失败抛出异常或返回 false 并回调 onError。
     */
    @Throws(Exception::class)
    fun connectAndPublish(host: String, port: Int, app: String, streamKey: String) {
        closeInternal(notify = false)

        val s = Socket()
        s.tcpNoDelay = true
        runCatching { s.sendBufferSize = 512 * 1024 }
        runCatching { s.receiveBufferSize = 256 * 1024 }
        s.connect(InetSocketAddress(host, port), 6000)
        socket = s
        input = BufferedInputStream(s.getInputStream(), 64 * 1024)
        output = s.getOutputStream()

        running.set(true)
        lastWriteDone.set(System.currentTimeMillis())

        handshake()
        startReader()

        // 必须在 connect 之前：服务端 inChunkSize 初值仅 128 字节
        writeSetChunkSize(OUT_CHUNK_SIZE)

        // connect
        val tcUrl = "rtmp://$host:$port/$app"
        val cmdObj = linkedMapOf<String, Any?>(
            "app" to app,
            "type" to "nonprivate",
            "flashVer" to "FMLE/3.0 (compatible; FMSc/1.0)",
            "tcUrl" to tcUrl,
            "fpad" to false,
            "capabilities" to 15.0,
            "audioCodecs" to 4071.0,
            "videoCodecs" to 252.0,
            "videoFunction" to 1.0,
            "objectEncoding" to 0.0
        )
        writeMessage(CSID_COMMAND, TYPE_INVOKE_AMF0, 0L, Amf0.encodeCommand("connect", 1.0, listOf(cmdObj)), 0)
        if (!connectLatch.await(6, TimeUnit.SECONDS)) {
            fail("等待 connect 应答超时（服务器未响应 _result）")
            throw IllegalStateException("connect timeout")
        }
        val cr = connectResult
        val code = (cr?.getOrNull(2) as? Map<*, *>)?.get("code") as? String
        if (code != null && !code.startsWith("NetConnection.Connect.Success")) {
            fail("服务器拒绝连接：$code")
            throw IllegalStateException("connect rejected: $code")
        }
        listener.onLog("connect 成功：$tcUrl")

        // createStream
        writeMessage(
            CSID_COMMAND, TYPE_INVOKE_AMF0, 0L,
            Amf0.encodeCommand("createStream", 2.0, listOf(null)), 0
        )
        if (!createStreamLatch.await(6, TimeUnit.SECONDS)) {
            fail("等待 createStream 应答超时")
            throw IllegalStateException("createStream timeout")
        }
        (createStreamResult?.getOrNull(3) as? Double)?.let { messageStreamId = it.toInt() }
        listener.onLog("已创建消息流 id=$messageStreamId")

        // publish
        writeMessage(
            CSID_COMMAND, TYPE_INVOKE_AMF0, 0L,
            Amf0.encodeCommand("publish", 3.0, listOf(null, streamKey, "live")),
            messageStreamId
        )
        if (!publishLatch.await(6, TimeUnit.SECONDS)) {
            fail("等待 publish 应答超时（推流密钥可能被占用）")
            throw IllegalStateException("publish timeout")
        }
        published.set(true)
        listener.onLog("推流已开始：$app/$streamKey")

        startWriter()
        startWatchdog()
    }

    /** 数据消息（@setDataFrame / onMetaData）。 */
    fun sendData(payload: ByteArray, timestampMs: Long) {
        enqueue(CSID_DATA, TYPE_DATA_AMF0, timestampMs, payload)
    }

    /** 视频消息载荷 = FLV Video Tag Body。 */
    fun sendVideo(payload: ByteArray, timestampMs: Long) {
        enqueue(CSID_VIDEO, TYPE_VIDEO, timestampMs, payload)
    }

    /** 音频消息载荷 = FLV Audio Tag Body。 */
    fun sendAudio(payload: ByteArray, timestampMs: Long) {
        enqueue(CSID_AUDIO, TYPE_AUDIO, timestampMs, payload)
    }

    fun close() {
        closeInternal(notify = true)
    }

    // ------------------------------------------------------------------ internals

    private fun enqueue(csid: Int, type: Int, ts: Long, payload: ByteArray) {
        if (!running.get() || !published.get()) return
        val p = Pending(csid, type, if (ts < 0) 0 else ts, payload)
        if (!queue.offer(p)) droppedPackets.incrementAndGet()
    }

    private fun closeInternal(notify: Boolean) {
        val wasRunning = running.getAndSet(false)
        published.set(false)
        queue.clear()
        runCatching { socket?.close() }
        socket = null
        runCatching { readerThread?.join(500) }
        runCatching { writerThread?.join(500) }
        runCatching { watchdogThread?.join(500) }
        readerThread = null
        writerThread = null
        watchdogThread = null
        if (notify && wasRunning) listener.onClosed()
    }

    private fun fail(message: String, cause: Throwable? = null) {
        listener.onError(message, cause)
        closeInternal(notify = false)
    }

    // -- handshake ------------------------------------------------------------

    private fun handshake() {
        val c1 = ByteArray(HANDSHAKE_SIZE)
        // time(4) + zero(4) 保持 0，其余随机
        java.util.Random().nextBytes(c1)
        for (i in 0 until 8) c1[i] = 0

        val out = output!!
        out.write(0x03)              // C0: version 3
        out.write(c1)                // C1
        out.flush()

        val inp = input!!
        val s0 = inp.read()
        if (s0 != 3) throw IllegalStateException("RTMP 握手失败：S0=$s0")
        val s1 = readFully(inp, ByteArray(HANDSHAKE_SIZE))
        readFully(inp, ByteArray(HANDSHAKE_SIZE)) // S2 = C1 回显，直接丢弃

        out.write(s1)                // C2 = S1 回显
        out.flush()
        listener.onLog("RTMP 握手完成")
    }

    private fun readFully(inp: InputStream, buf: ByteArray, off: Int = 0, len: Int = buf.size): ByteArray {
        var o = off
        var remaining = len
        while (remaining > 0) {
            val n = inp.read(buf, o, remaining)
            if (n < 0) throw EOFException("RTMP 连接在读取时关闭")
            o += n
            remaining -= n
        }
        return buf
    }

    // -- write path -----------------------------------------------------------

    private fun writeSetChunkSize(size: Int) {
        val payload = ByteArray(4)
        payload[0] = ((size ushr 24) and 0xFF).toByte()
        payload[1] = ((size ushr 16) and 0xFF).toByte()
        payload[2] = ((size ushr 8) and 0xFF).toByte()
        payload[3] = (size and 0xFF).toByte()
        writeMessage(CSID_CONTROL, TYPE_SET_CHUNK_SIZE, 0L, payload, 0)
    }

    /**
     * 写一条完整的 RTMP 消息。首块固定用 fmt=0（11 字节头），续块用 fmt=3。
     * 简单、无状态、与所有服务端兼容，代价是每条约 11 字节头部开销。
     */
    private fun writeMessage(csid: Int, type: Int, timestamp: Long, payload: ByteArray, msid: Int) {
        val out = output ?: return
        val ts = if (timestamp < 0) 0 else timestamp
        val useExt = ts >= 0xFFFFFF
        val payloadLen = payload.size

        synchronized(writeLock) {
            val header = ByteArray(if (useExt) 16 else 12)
            header[0] = csid.toByte() // fmt=0
            writeUInt24BE(header, 1, if (useExt) 0xFFFFFF else ts.toInt())
            writeUInt24BE(header, 4, payloadLen)
            header[7] = type.toByte()
            writeUInt32LE(header, 8, msid)
            if (useExt) {
                header[12] = ((ts ushr 24) and 0xFF).toByte()
                header[13] = ((ts ushr 16) and 0xFF).toByte()
                header[14] = ((ts ushr 8) and 0xFF).toByte()
                header[15] = (ts and 0xFF).toByte()
            }
            out.write(header)

            var off = 0
            var remaining = payloadLen
            val chunk = outChunkSize
            while (remaining > 0) {
                val n = min(chunk, remaining)
                out.write(payload, off, n)
                off += n
                remaining -= n
                if (remaining > 0) {
                    out.write(0xC0 or csid) // fmt=3 续块
                    if (useExt) {
                        out.write(((ts ushr 24) and 0xFF).toInt())
                        out.write(((ts ushr 16) and 0xFF).toInt())
                        out.write(((ts ushr 8) and 0xFF).toInt())
                        out.write((ts and 0xFF).toInt())
                    }
                }
            }
            out.flush()
            bytesSent.addAndGet(12L + payloadLen)
            lastWriteDone.set(System.currentTimeMillis())
        }
    }

    private fun startWriter() {
        val t = Thread({
            try {
                while (running.get()) {
                    val p = queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                    writeMessage(p.csid, p.type, p.timestamp, p.payload, messageStreamId)
                }
            } catch (e: InterruptedException) {
                // 正常退出
            } catch (e: Throwable) {
                if (running.get()) fail("发送数据失败：${e.message}", e)
            }
        }, "rtmp-writer")
        t.isDaemon = true
        writerThread = t
        t.start()
    }

    private fun startWatchdog() {
        val t = Thread({
            while (running.get()) {
                try {
                    Thread.sleep(3000)
                } catch (e: InterruptedException) {
                    return@Thread
                }
                val idle = System.currentTimeMillis() - lastWriteDone.get()
                if (queueSize > 0 && idle > STALL_TIMEOUT_MS) {
                    fail("上行阻塞 ${idle / 1000}s，连接可能已断开")
                    return@Thread
                }
            }
        }, "rtmp-watchdog")
        t.isDaemon = true
        watchdogThread = t
        t.start()
    }

    // -- read path ------------------------------------------------------------

    private fun startReader() {
        val t = Thread({
            val states = HashMap<Int, ChunkState>()
            try {
                while (running.get()) {
                    val msg = readMessage(states) ?: break
                    handleMessage(msg)
                }
            } catch (e: SocketException) {
                if (running.get()) fail("RTMP 连接中断：${e.message}", e)
            } catch (e: EOFException) {
                if (running.get()) fail("RTMP 连接被服务器关闭", e)
            } catch (e: Throwable) {
                if (running.get()) fail("解析服务器消息失败：${e.message}", e)
            }
        }, "rtmp-reader")
        t.isDaemon = true
        readerThread = t
        t.start()
    }

    private fun readMessage(states: HashMap<Int, ChunkState>): Message? {
        val inp = input ?: return null

        val b0 = inp.read()
        if (b0 < 0) return null
        bytesRead.incrementAndGet()
        val fmt = (b0 ushr 6) and 0x03
        var csid = b0 and 0x3F
        if (csid == 0) {
            csid = 64 + inp.read()
        } else if (csid == 1) {
            val b1 = inp.read()
            val b2 = inp.read()
            csid = 64 + b1 + (b2 shl 8)
        }

        val st = states.getOrPut(csid) { ChunkState() }

        when (fmt) {
            0 -> {
                val tsField = readUInt24BE(inp)
                st.lastFieldTs = tsField.toLong()
                st.msgLength = readUInt24BE(inp)
                st.msgType = inp.read()
                st.msgStreamId = readUInt32LE(inp)
                st.timestamp = if (tsField == 0xFFFFFF) readUInt32BE(inp).toLong() else tsField.toLong()
            }
            1 -> {
                val delta = readUInt24BE(inp)
                st.lastFieldTs = delta.toLong()
                st.msgLength = readUInt24BE(inp)
                st.msgType = inp.read()
                st.timestamp += if (delta == 0xFFFFFF) readUInt32BE(inp).toLong() else delta.toLong()
            }
            2 -> {
                val delta = readUInt24BE(inp)
                st.lastFieldTs = delta.toLong()
                st.timestamp += if (delta == 0xFFFFFF) readUInt32BE(inp).toLong() else delta.toLong()
            }
            else -> {
                if (st.lastFieldTs == 0xFFFFFFL) st.timestamp += readUInt32BE(inp).toLong()
            }
        }

        val length = st.msgLength
        val payload = ByteArray(length)
        var off = 0
        while (off < length) {
            val n = min(inChunkSize, length - off)
            readFully(inp, payload, off, n)
            bytesRead.addAndGet(n.toLong())
            off += n
            if (off < length) {
                val nb = inp.read()
                if (nb < 0) throw EOFException("RTMP 连接在分块读取时关闭")
                val nfmt = (nb ushr 6) and 0x03
                var ncsid = nb and 0x3F
                if (ncsid == 0) {
                    ncsid = 64 + inp.read()
                } else if (ncsid == 1) {
                    val a = inp.read()
                    val b = inp.read()
                    ncsid = 64 + a + (b shl 8)
                }
                if (nfmt == 3 && st.lastFieldTs == 0xFFFFFFL) readUInt32BE(inp)
            }
        }
        return Message(csid, st.msgType, st.timestamp, payload)
    }

    private fun handleMessage(msg: Message) {
        when (msg.type) {
            TYPE_SET_CHUNK_SIZE -> {
                inChunkSize = readUInt32BE(msg.payload, 0)
                listener.onLog("服务器分块大小 inChunkSize=$inChunkSize")
            }
            TYPE_WINDOW_ACK_SIZE -> ackWindow.set(readUInt32BE(msg.payload, 0))
            TYPE_ACK, TYPE_ABORT, TYPE_SET_PEER_BW -> Unit
            TYPE_USER_CONTROL -> {
                if (msg.payload.size >= 2) {
                    val event = ((msg.payload[0].toInt() and 0xFF) shl 8) or (msg.payload[1].toInt() and 0xFF)
                    if (event == 6) sendPong(msg.payload) // PingRequest → PingResponse
                }
            }
            TYPE_INVOKE_AMF0 -> handleInvoke(msg)
            else -> Unit
        }
    }

    private fun handleInvoke(msg: Message) {
        val values = try {
            Amf0.decode(msg.payload, 0, msg.payload.size)
        } catch (e: Throwable) {
            // 解码不了的命令不应拖垮整条链路，打印前 256 字节便于定位
            val head = msg.payload.take(256).joinToString("") { "%02x".format(it) }
            listener.onLog("AMF 解码失败 csid=${msg.csid} len=${msg.payload.size} hex=$head")
            throw e
        }
        val cmd = values.getOrNull(0) as? String ?: return
        val transId = (values.getOrNull(1) as? Double)?.toInt() ?: 0
        when (cmd) {
            "_result" -> {
                when (transId) {
                    1 -> {
                        connectResult = values
                        connectLatch.countDown()
                    }
                    2 -> {
                        createStreamResult = values
                        createStreamLatch.countDown()
                    }
                    else -> listener.onLog("收到 _result transId=$transId")
                }
            }
            "_error" -> {
                val info = values.getOrNull(3) as? Map<*, *>
                fail("服务器返回 _error（transId=$transId）：${info ?: values}")
            }
            "onStatus" -> {
                val info = (values.getOrNull(3) as? Map<*, *>) ?: emptyMap<Any, Any>()
                val code = info["code"] as? String ?: ""
                val level = info["level"] as? String ?: ""
                listener.onLog("onStatus $code")
                if (code == "NetStream.Publish.Start") publishLatch.countDown()
                if (level == "error") fail("推流被拒绝：${info["description"] ?: code}")
            }
            "onBWDone", "onFCPublish", "_onbWDone" -> Unit
            else -> listener.onLog("忽略服务器命令：$cmd")
        }
    }

    private fun sendPong(pingPayload: ByteArray) {
        val payload = ByteArray(6)
        payload[0] = 0
        payload[1] = 7 // PingResponse
        System.arraycopy(pingPayload, 2, payload, 2, min(4, pingPayload.size - 2))
        writeMessage(CSID_CONTROL, TYPE_USER_CONTROL, 0L, payload, 0)
    }

    // -- byte helpers ---------------------------------------------------------

    private fun readByteOrThrow(inp: InputStream): Int {
        val b = inp.read()
        if (b < 0) throw EOFException("RTMP 连接关闭")
        return b
    }

    private fun readUInt24BE(inp: InputStream): Int {
        val a = readByteOrThrow(inp)
        val b = readByteOrThrow(inp)
        val c = readByteOrThrow(inp)
        return (a shl 16) or (b shl 8) or c
    }

    private fun readUInt32BE(inp: InputStream): Int {
        val a = readByteOrThrow(inp)
        val b = readByteOrThrow(inp)
        val c = readByteOrThrow(inp)
        val d = readByteOrThrow(inp)
        return (a shl 24) or (b shl 16) or (c shl 8) or d
    }

    private fun readUInt32LE(inp: InputStream): Int {
        val a = readByteOrThrow(inp)
        val b = readByteOrThrow(inp)
        val c = readByteOrThrow(inp)
        val d = readByteOrThrow(inp)
        return (d shl 24) or (c shl 16) or (b shl 8) or a
    }

    private fun readUInt32BE(buf: ByteArray, off: Int = 0): Int =
        ((buf[off].toInt() and 0xFF) shl 24) or
            ((buf[off + 1].toInt() and 0xFF) shl 16) or
            ((buf[off + 2].toInt() and 0xFF) shl 8) or
            (buf[off + 3].toInt() and 0xFF)

    private fun writeUInt24BE(buf: ByteArray, off: Int, value: Int) {
        buf[off] = ((value ushr 16) and 0xFF).toByte()
        buf[off + 1] = ((value ushr 8) and 0xFF).toByte()
        buf[off + 2] = (value and 0xFF).toByte()
    }

    private fun writeUInt32LE(buf: ByteArray, off: Int, value: Int) {
        buf[off] = (value and 0xFF).toByte()
        buf[off + 1] = ((value ushr 8) and 0xFF).toByte()
        buf[off + 2] = ((value ushr 16) and 0xFF).toByte()
        buf[off + 3] = ((value ushr 24) and 0xFF).toByte()
    }
}
