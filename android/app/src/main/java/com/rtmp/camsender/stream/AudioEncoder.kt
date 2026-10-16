package com.rtmp.camsender.stream

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.SystemClock
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 麦克风采集 + AAC 硬编码。
 *
 * PCM 时间戳统一用 SystemClock.elapsedRealtimeNanos()（BOOTTIME），
 * 与相机传感器时间同源，方便在 [StreamEngine] 里做音视频对齐。
 */
class AudioEncoder(
    private val sampleRate: Int,
    private val bitrate: Int,
    private val stereo: Boolean,
    private val listener: Listener
) {

    interface Listener {
        fun onLog(message: String)
        fun onAsc(audioSpecificConfig: ByteArray)
        fun onFrame(aac: ByteArray, ptsUs: Long)
        fun onError(message: String, cause: Throwable?)
    }

    companion object {
        private const val MIME = MediaFormat.MIMETYPE_AUDIO_AAC
        private const val DEQUEUE_TIMEOUT_US = 10_000L
        private const val PCM_QUEUE_DEPTH = 48
    }

    private class Pcm(val data: ByteArray, val ptsUs: Long)

    private var codec: MediaCodec? = null
    private var record: AudioRecord? = null
    private var captureThread: Thread? = null
    private var drainThread: Thread? = null
    private val running = AtomicBoolean(false)
    private val pcmQueue = ArrayBlockingQueue<Pcm>(PCM_QUEUE_DEPTH)
    private val bufferInfo = MediaCodec.BufferInfo()

    @Volatile private var actualSampleRate = sampleRate
    val droppedPcm: Long get() = _droppedPcm
    @Volatile private var _droppedPcm = 0L

    fun start() {
        actualSampleRate = pickSampleRate(sampleRate)
        val channelMask = if (stereo) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO

        val minBuf = AudioRecord.getMinBufferSize(actualSampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val bufSize = maxOf(minBuf * 2, 8192)

        val rec = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.DEFAULT)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(actualSampleRate)
                    .setChannelMask(channelMask)
                    .build()
            )
            .setBufferSizeInBytes(bufSize)
            .build()

        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("麦克风初始化失败（$actualSampleRate Hz）")
        }
        record = rec

        val format = MediaFormat.createAudioFormat(MIME, actualSampleRate, if (stereo) 2 else 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        val c = MediaCodec.createEncoderByType(MIME)
        c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        c.start()
        codec = c

        running.set(true)
        rec.startRecording()
        listener.onLog("音频编码器已启动 ${actualSampleRate}Hz ${bitrate / 1000}kbps ${if (stereo) "立体声" else "单声道"}")

        val ct = Thread({ captureLoop(rec) }, "audio-capture")
        ct.isDaemon = true
        captureThread = ct
        ct.start()

        val dt = Thread({ drainLoop(c) }, "audio-drain")
        dt.isDaemon = true
        drainThread = dt
        dt.start()
    }

    private fun pickSampleRate(preferred: Int): Int {
        for (rate in intArrayOf(preferred, 48000, 44100, 22050, 16000)) {
            val mask = if (stereo) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
            if (AudioRecord.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT) > 0) return rate
        }
        return preferred
    }

    fun stop() {
        running.set(false)
        runCatching { captureThread?.join(600) }
        captureThread = null
        runCatching { record?.stop() }
        runCatching { record?.release() }
        record = null
        runCatching { drainThread?.join(600) }
        drainThread = null
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        pcmQueue.clear()
    }

    // ------------------------------------------------------------------ loops

    private fun captureLoop(rec: AudioRecord) {
        val channels = if (stereo) 2 else 1
        val bytesPerSample = 2 * channels
        val chunkBytes = 2048 * bytesPerSample
        val buffer = ByteArray(chunkBytes)
        try {
            while (running.get()) {
                val n = rec.read(buffer, 0, buffer.size)
                if (n <= 0) {
                    if (n == AudioRecord.ERROR_INVALID_OPERATION || n == AudioRecord.ERROR_BAD_VALUE) {
                        listener.onError("麦克风读取失败（错误码 $n）", null)
                        return
                    }
                    continue
                }
                val nowUs = SystemClock.elapsedRealtimeNanos() / 1000
                val frames = n / bytesPerSample
                val durationUs = frames * 1_000_000L / actualSampleRate
                // 时间戳保持 BOOTTIME 原始值（微秒），由 StreamEngine 统一减去推流起点
                val ptsUs = (nowUs - durationUs).coerceAtLeast(0)
                val data = buffer.copyOf(n)
                if (!pcmQueue.offer(Pcm(data, ptsUs))) {
                    // 编码器跟不上，丢弃最旧的一段，保证实时性
                    pcmQueue.poll()
                    pcmQueue.offer(Pcm(data, ptsUs))
                    _droppedPcm++
                }
            }
        } catch (e: Throwable) {
            if (running.get()) listener.onError("麦克风采集线程异常：${e.message}", e)
        }
    }

    private fun drainLoop(c: MediaCodec) {
        try {
            while (running.get()) {
                // 1) 送 PCM 进编码器
                if (running.get()) {
                    val pcm = pcmQueue.poll(2, TimeUnit.MILLISECONDS)
                    if (pcm != null) {
                        val inIndex = c.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
                        if (inIndex >= 0) {
                            val inBuf = c.getInputBuffer(inIndex)
                            if (inBuf != null) {
                                inBuf.clear()
                                inBuf.put(pcm.data)
                                c.queueInputBuffer(inIndex, 0, pcm.data.size, pcm.ptsUs, 0)
                            } else {
                                c.queueInputBuffer(inIndex, 0, 0, pcm.ptsUs, 0)
                            }
                        }
                    }
                }

                // 2) 取 AAC 出来
                var guard = 0
                while (running.get() && guard++ < 8) {
                    val outIndex = c.dequeueOutputBuffer(bufferInfo, 0)
                    when {
                        outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> break
                        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            val csd = c.outputFormat.getByteBuffer("csd-0")
                            if (csd != null) {
                                val asc = ByteArray(csd.remaining())
                                csd.get(asc)
                                listener.onAsc(asc)
                            }
                        }
                        outIndex >= 0 -> {
                            val info = bufferInfo
                            if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                                val outBuf = c.getOutputBuffer(outIndex)
                                if (outBuf != null) {
                                    val aac = ByteArray(info.size)
                                    outBuf.position(info.offset)
                                    outBuf.limit(info.offset + info.size)
                                    outBuf.get(aac)
                                    listener.onFrame(aac, info.presentationTimeUs)
                                }
                            }
                            c.releaseOutputBuffer(outIndex, false)
                        }
                    }
                }
            }
        } catch (e: InterruptedException) {
            // 退出
        } catch (e: Throwable) {
            if (running.get()) listener.onError("音频编码线程异常：${e.message}", e)
        }
    }
}
