package com.rtmp.camsender.rtmp

import java.io.ByteArrayOutputStream

/**
 * AMF0 的最小实现，只覆盖 RTMP 握手之后的命令通道（connect / createStream / publish / onMetaData）。
 *
 * 支持的类型：
 *  Number(0x00) String(0x02) Boolean(0x01) Object(0x03) Null(0x05)
 *  ECMA Array(0x08) ObjectEnd(0x09) StrictArray(0x0A)
 */
object Amf0 {

    private const val TYPE_NUMBER = 0x00
    private const val TYPE_BOOLEAN = 0x01
    private const val TYPE_STRING = 0x02
    private const val TYPE_OBJECT = 0x03
    private const val TYPE_NULL = 0x05
    private const val TYPE_UNDEFINED = 0x06
    private const val TYPE_ECMA_ARRAY = 0x08
    private const val TYPE_OBJECT_END = 0x09
    private const val TYPE_STRICT_ARRAY = 0x0A

    // ---------------------------------------------------------------- encode

    fun encodeCommand(name: String, transactionId: Double, args: List<Any?>): ByteArray {
        val out = ByteArrayOutputStream(256)
        writeString(out, name)
        writeNumber(out, transactionId)
        args.forEach { writeValue(out, it) }
        return out.toByteArray()
    }

    /** 用于 @setDataFrame / onMetaData 这类 Data Message。 */
    fun encodeData(args: List<Any?>): ByteArray {
        val out = ByteArrayOutputStream(512)
        args.forEach { writeValue(out, it) }
        return out.toByteArray()
    }

    /**
     * @setDataFrame("onMetaData", { ... })
     * node-media-server 会解析该消息，并把 width/height/framerate 等挂到 publisher 上供导播台显示。
     */
    fun encodeSetDataFrame(meta: Map<String, Any?>): ByteArray {
        val out = ByteArrayOutputStream(512)
        writeString(out, "@setDataFrame")
        writeString(out, "onMetaData")
        writeEcmaArray(out, meta)
        return out.toByteArray()
    }

    private fun writeValue(out: ByteArrayOutputStream, value: Any?) {
        when (value) {
            null -> out.write(TYPE_NULL)
            is String -> writeString(out, value)
            is Boolean -> {
                out.write(TYPE_BOOLEAN)
                out.write(if (value) 1 else 0)
            }
            is Int -> writeNumber(out, value.toDouble())
            is Long -> writeNumber(out, value.toDouble())
            is Float -> writeNumber(out, value.toDouble())
            is Double -> writeNumber(out, value)
            is Map<*, *> -> writeObject(out, value)
            is List<*> -> writeStrictArray(out, value)
            else -> writeString(out, value.toString())
        }
    }

    private fun writeNumber(out: ByteArrayOutputStream, v: Double) {
        out.write(TYPE_NUMBER)
        val bits = java.lang.Double.doubleToLongBits(v)
        for (i in 7 downTo 0) out.write(((bits ushr (i * 8)) and 0xFF).toInt())
    }

    private fun writeString(out: ByteArrayOutputStream, s: String) {
        val bytes = s.toByteArray(Charsets.UTF_8)
        out.write(TYPE_STRING)
        out.write((bytes.size ushr 8) and 0xFF)
        out.write(bytes.size and 0xFF)
        out.write(bytes, 0, bytes.size)
    }

    private fun writeObject(out: ByteArrayOutputStream, map: Map<*, *>) {
        out.write(TYPE_OBJECT)
        for ((k, v) in map) {
            val key = k.toString().toByteArray(Charsets.UTF_8)
            out.write((key.size ushr 8) and 0xFF)
            out.write(key.size and 0xFF)
            out.write(key, 0, key.size)
            writeValue(out, v)
        }
        out.write(0)
        out.write(0)
        out.write(TYPE_OBJECT_END)
    }

    /** ECMA Array：先写 4 字节近似长度，再写键值对。 */
    fun writeEcmaArray(out: ByteArrayOutputStream, map: Map<*, *>) {
        out.write(TYPE_ECMA_ARRAY)
        val n = map.size
        out.write((n ushr 24) and 0xFF)
        out.write((n ushr 16) and 0xFF)
        out.write((n ushr 8) and 0xFF)
        out.write(n and 0xFF)
        for ((k, v) in map) {
            val key = k.toString().toByteArray(Charsets.UTF_8)
            out.write((key.size ushr 8) and 0xFF)
            out.write(key.size and 0xFF)
            out.write(key, 0, key.size)
            writeValue(out, v)
        }
        out.write(0)
        out.write(0)
        out.write(TYPE_OBJECT_END)
    }

    private fun writeStrictArray(out: ByteArrayOutputStream, list: List<*>) {
        out.write(TYPE_STRICT_ARRAY)
        val n = list.size
        out.write((n ushr 24) and 0xFF)
        out.write((n ushr 16) and 0xFF)
        out.write((n ushr 8) and 0xFF)
        out.write(n and 0xFF)
        list.forEach { writeValue(out, it) }
    }

    // ---------------------------------------------------------------- decode

    /** 把一段 AMF0 数据全部解码成列表。 */
    fun decode(data: ByteArray, offset: Int, length: Int): List<Any?> {
        val r = Reader(data, offset, offset + length)
        val out = ArrayList<Any?>(4)
        while (r.hasRemaining() && !r.failed) {
            val before = r.position
            out.add(r.readValue())
            if (r.position <= before) break // 防呆：确保游标前进
        }
        return out
    }

    class Reader(private val buf: ByteArray, private var pos: Int, private val end: Int) {

        var failed: Boolean = false
            private set

        val position: Int get() = pos

        fun hasRemaining(): Boolean = pos < end

        fun readValue(): Any? {
            if (pos >= end) return null
            return when (buf[pos++].toInt() and 0xFF) {
                TYPE_NUMBER -> readNumber()
                TYPE_BOOLEAN -> (buf[pos++].toInt() and 0xFF) != 0
                TYPE_STRING -> readString()
                TYPE_OBJECT -> readObject()
                TYPE_NULL, TYPE_UNDEFINED -> null
                TYPE_ECMA_ARRAY -> {
                    pos += 4
                    readObject()
                }
                TYPE_STRICT_ARRAY -> readStrictArray()
                else -> {
                    failed = true
                    pos = end
                    null
                }
            }
        }

        private fun readNumber(): Double {
            var bits = 0L
            for (i in 0 until 8) bits = (bits shl 8) or (buf[pos++].toLong() and 0xFF)
            return java.lang.Double.longBitsToDouble(bits)
        }

        private fun readString(): String {
            val len = ((buf[pos].toInt() and 0xFF) shl 8) or (buf[pos + 1].toInt() and 0xFF)
            pos += 2
            val s = String(buf, pos, len, Charsets.UTF_8)
            pos += len
            return s
        }

        private fun readObject(): LinkedHashMap<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            while (pos + 2 <= end) {
                val keyLen = ((buf[pos].toInt() and 0xFF) shl 8) or (buf[pos + 1].toInt() and 0xFF)
                pos += 2
                if (keyLen == 0) {
                    // ObjectEnd
                    pos += 1
                    break
                }
                val key = String(buf, pos, keyLen, Charsets.UTF_8)
                pos += keyLen
                map[key] = readValue()
            }
            return map
        }

        private fun readStrictArray(): ArrayList<Any?> {
            var n = 0
            for (i in 0 until 4) n = (n shl 8) or (buf[pos++].toInt() and 0xFF)
            val list = ArrayList<Any?>(n)
            for (i in 0 until n) list.add(readValue())
            return list
        }
    }
}
