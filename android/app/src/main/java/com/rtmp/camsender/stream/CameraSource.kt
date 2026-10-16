package com.rtmp.camsender.stream

import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.StreamConfigurationMap
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import android.view.Surface
import kotlin.math.abs

/**
 * Camera2 采集源。
 *
 * 默认把相机的输出直接连到编码器的输入面上（零拷贝）；可选再挂一路预览面。
 * 预览面随时可以增删（例如 Activity 进后台 TextureView 被销毁），
 * 此时会重建一次 capture session，推流不中断。
 */
class CameraSource(
    private val context: Context,
    private val listener: Listener
) {

    interface Listener {
        fun onLog(message: String)
        fun onStarted(cameraId: String, sensorOrientation: Int, size: Size)
        fun onError(message: String, cause: Throwable?)
    }

    companion object {
        /**
         * 相机（该摄像头）能输出的全部视频尺寸，统一成「横置」口径（宽 >= 高）、
         * 去重并按像素数从大到小排序。8K 机型这里就会给出 7680×4320。
         */
        fun videoSizes(context: Context, cameraId: String): List<Size> {
            val map = streamConfigMap(context, cameraId) ?: return emptyList()
            val sizes = map.getOutputSizes(SurfaceTexture::class.java) ?: return emptyList()
            return sizes
                .map { Size(maxOf(it.width, it.height), minOf(it.width, it.height)) }
                .filter { it.width > 0 && it.height > 0 }
                .distinctBy { it.width to it.height }
                .sortedWith(compareByDescending<Size> { it.width * it.height }.thenByDescending { it.width })
        }

        /** 该摄像头支持的最高视频尺寸（横置口径）。 */
        fun maxVideoSize(context: Context, cameraId: String): Size? =
            videoSizes(context, cameraId).firstOrNull()

        private fun streamConfigMap(context: Context, cameraId: String): StreamConfigurationMap? =
            runCatching {
                (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager)
                    .getCameraCharacteristics(cameraId)
                    .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            }.getOrNull()

        /** 按「优先精确匹配 → 同宽高比最近面积 → 全局最近面积」挑选相机输出尺寸。 */
        fun pickSize(context: Context, cameraId: String, wantWidth: Int, wantHeight: Int): Size? {
            val map = streamConfigMap(context, cameraId) ?: return null
            val sizes = map.getOutputSizes(SurfaceTexture::class.java) ?: return null
            if (sizes.isEmpty()) return null

            sizes.firstOrNull { it.width == wantWidth && it.height == wantHeight }?.let { return it }

            val wantArea = wantWidth * wantHeight
            val wantRatio = wantWidth.toDouble() / wantHeight
            val sameRatio = sizes.filter { abs(it.width.toDouble() / it.height - wantRatio) < 0.02 }
            val pool = sameRatio.ifEmpty { sizes.toList() }
            return pool.minByOrNull { abs(it.width * it.height - wantArea) }
        }

        fun sensorOrientation(context: Context, cameraId: String): Int {
            return runCatching {
                val chars = (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager)
                    .getCameraCharacteristics(cameraId)
                chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
            }.getOrDefault(90)
        }

        fun hasCamera(context: Context, facing: Int): Boolean = cameraIdFor(context, facing) != null

        fun cameraIdFor(context: Context, facing: Int): String? {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            return runCatching {
                manager.cameraIdList.firstOrNull { id ->
                    manager.getCameraCharacteristics(id)
                        .get(CameraCharacteristics.LENS_FACING) == facing
                }
            }.getOrNull()
        }

        fun otherFacing(facing: Int): Int =
            if (facing == CameraCharacteristics.LENS_FACING_FRONT) {
                CameraCharacteristics.LENS_FACING_BACK
            } else {
                CameraCharacteristics.LENS_FACING_FRONT
            }
    }

    private val thread = HandlerThread("cam-src").apply { start() }
    private val handler = Handler(thread.looper)

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var characteristics: CameraCharacteristics? = null
    private var chosenSize: Size = Size(1920, 1080)

    private var encoderSurface: Surface? = null
    private var previewSurface: Surface? = null
    private var targetFps = 30
    private var cameraId: String = ""
    private var closed = false

    fun start(
        cameraId: String,
        encoderSurface: Surface,
        previewSurface: Surface?,
        size: Size,
        fps: Int
    ) {
        closed = false
        this.cameraId = cameraId
        this.targetFps = fps
        handler.post {
            this.encoderSurface = encoderSurface
            this.previewSurface = previewSurface
            chosenSize = size
            openCamera(cameraId)
        }
    }

    /** 预览面变化（TextureView 重建 / Activity 前后台切换）时调用，null 表示撤掉预览。 */
    fun setPreviewSurface(surface: Surface?) {
        handler.post {
            if (previewSurface === surface) return@post
            previewSurface = surface
            if (device != null && encoderSurface != null) {
                listener.onLog(if (surface == null) "移除预览面（后台推流）" else "恢复预览面")
                createSession()
            }
        }
    }

    fun stop() {
        closed = true
        handler.post {
            runCatching { session?.stopRepeating() }
            runCatching { session?.close() }
            session = null
            runCatching { device?.close() }
            device = null
            encoderSurface = null
            previewSurface = null
        }
        handler.post { thread.quitSafely() }
    }

    val currentSize: Size get() = chosenSize

    // ------------------------------------------------------------- internals

    private fun openCamera(id: String) {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val chars = runCatching { manager.getCameraCharacteristics(id) }.getOrNull()
        if (chars == null) {
            listener.onError("无法读取相机 $id 的参数", null)
            return
        }
        characteristics = chars
        val supported = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(SurfaceTexture::class.java)
            ?.any { it == chosenSize } == true
        if (!supported) {
            val fixed = pickSize(context, id, chosenSize.width, chosenSize.height)
            if (fixed != null) chosenSize = fixed
        }

        try {
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    if (closed) {
                        camera.close()
                        return
                    }
                    device = camera
                    listener.onLog("相机已打开：$id ${chosenSize.width}x${chosenSize.height}")
                    createSession()
                }

                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    device = null
                    if (!closed) listener.onError("相机连接被断开（可能被其他应用占用）", null)
                }

                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    device = null
                    if (!closed) listener.onError("相机打开失败，错误码 $error", null)
                }
            }, handler)
        } catch (e: SecurityException) {
            listener.onError("缺少相机权限", e)
        } catch (e: Throwable) {
            listener.onError("相机启动异常：${e.message}", e)
        }
    }

    private fun createSession() {
        val dev = device ?: return
        val enc = encoderSurface ?: return
        val targets = ArrayList<Surface>(2)
        targets.add(enc)
        previewSurface?.let { targets.add(it) }

        runCatching { session?.close() }
        session = null

        try {
            @Suppress("DEPRECATION")
            dev.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (closed) {
                        s.close()
                        return
                    }
                    session = s
                    startRepeating(dev, s)
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    if (!closed) listener.onError("创建相机会话失败（分辨率组合不受支持）", null)
                }
            }, handler)
        } catch (e: Throwable) {
            listener.onError("创建相机会话异常：${e.message}", e)
        }
    }

    private fun startRepeating(dev: CameraDevice, s: CameraCaptureSession) {
        try {
            val req = dev.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
            encoderSurface?.let { req.addTarget(it) }
            previewSurface?.let { req.addTarget(it) }
            req.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)

            val chars = characteristics
            val afModes = chars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
            when {
                afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) ->
                    req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) ->
                    req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
            }

            val fpsRanges = chars?.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            val range = pickFpsRange(fpsRanges)
            if (range != null) req.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range)

            s.setRepeatingRequest(req.build(), null, handler)
            listener.onStarted(cameraId, chars?.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90, chosenSize)
        } catch (e: Throwable) {
            if (!closed) listener.onError("启动相机预览流失败：${e.message}", e)
        }
    }

    /** 选一个包含目标帧率的范围，优先固定帧率（上下限相同）。 */
    private fun pickFpsRange(ranges: Array<Range<Int>>?): Range<Int>? {
        if (ranges == null || ranges.isEmpty()) return null
        ranges.firstOrNull { it.lower == targetFps && it.upper == targetFps }?.let { return it }
        ranges.filter { it.contains(targetFps) }
            .minByOrNull { it.upper - it.lower }
            ?.let { return it }
        return ranges.minByOrNull { abs(it.upper - targetFps) }
    }
}
