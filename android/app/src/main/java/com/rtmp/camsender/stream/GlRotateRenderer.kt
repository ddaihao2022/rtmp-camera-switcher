package com.rtmp.camsender.stream

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * GL 旋转渲染管线：相机 → OES 外部纹理 → 按角度旋转像素 → 编码器输入面。
 *
 * 为什么不用 MediaFormat.KEY_ROTATION：不少机型的硬编码器会「静默忽略」该参数
 * （configure 成功，但输出仍是未旋转的 width×height），导致远端画面横竖颠倒。
 * 在 GL 里真实旋转像素，所有机型行为一致。
 *
 * 线程模型：
 *  - [start] 在调用线程阻塞完成 EGL 初始化（调用方应在子线程）；
 *  - 每帧回调注册在内部 GL 线程上，updateTexImage → 旋转绘制 → swapBuffers；
 *  - [release] 阻塞等待 GL 线程清理完成，可从任意线程调用。
 */
class GlRotateRenderer(
    private val encoderSurface: Surface,
    private val inWidth: Int,
    private val inHeight: Int,
    private val outWidth: Int,
    private val outHeight: Int,
    private val rotationDegrees: Int,   // 顺时针角度：90/180/270
    private val listener: Listener
) {
    interface Listener {
        fun onLog(message: String)
        fun onError(message: String, cause: Throwable?)
    }

    companion object {
        // EGL_RECORDABLE_ANDROID：保证编码器能把该 Surface 当输入源
        private const val EGL_RECORDABLE_ANDROID = 0x3142

        private const val VERTEX_SHADER = """
            uniform mat4 uMvp;
            uniform mat4 uSt;
            attribute vec4 aPos;
            attribute vec2 aTex;
            varying vec2 vTex;
            void main() {
                gl_Position = uMvp * aPos;
                vTex = (uSt * vec4(aTex, 0.0, 1.0)).xy;
            }
        """

        private const val FRAGMENT_SHADER = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTex;
            uniform samplerExternalOES uTex;
            void main() {
                gl_FragColor = texture2D(uTex, vTex);
            }
        """

        // 全屏四边形（TRIANGLE_STRIP）：位置 + 纹理坐标，与 Grafika 约定一致
        private val VERTEX_DATA = floatArrayOf(
            -1f, -1f, 0f, 0f,   // 左下
             1f, -1f, 1f, 0f,   // 右下
            -1f,  1f, 0f, 1f,   // 左上
             1f,  1f, 1f, 1f    // 右上
        )
    }

    private val thread = HandlerThread("gl-rotate").apply { start() }
    private val handler = Handler(thread.looper)
    private val released = AtomicBoolean(false)

    private var eglDisplay: EGLDisplay? = null
    private var eglContext: EGLContext? = null
    private var eglSurface: EGLSurface? = null
    private var surfaceTexture: SurfaceTexture? = null

    @Volatile private var cameraSurface: Surface? = null
    private var texId = 0
    private var program = 0
    private var vertexBuffer: FloatBuffer = floatBufferOf(VERTEX_DATA)

    private val stMatrix = FloatArray(16)
    private val mvpMatrix = FloatArray(16)

    val surface: Surface
        get() = cameraSurface ?: error("GlRotateRenderer 尚未启动")

    /** 阻塞初始化 EGL 与纹理；失败时抛异常，由调用方决定降级/重试。 */
    fun start() {
        val latch = CountDownLatch(1)
        var initError: Throwable? = null
        handler.post {
            try {
                setupEgl()
                setupTexture()
                listener.onLog(
                    "GL 旋转渲染器就绪 ${inWidth}x$inHeight → ${outWidth}x$outHeight 顺时针=$rotationDegrees°"
                )
            } catch (t: Throwable) {
                initError = t
            }
            latch.countDown()
        }
        latch.await()
        initError?.let { throw IllegalStateException("GL 初始化失败：${it.message}", it) }
    }

    /** 阻塞释放，可从任意线程调用。 */
    fun release() {
        if (!released.compareAndSet(false, true)) return
        val latch = CountDownLatch(1)
        handler.post {
            try { cleanup() } catch (_: Throwable) {}
            latch.countDown()
        }
        latch.await()
        runCatching { thread.quitSafely() }
    }

    // ------------------------------------------------------------------ setup

    private fun setupEgl() {
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display !== EGL14.EGL_NO_DISPLAY) { "eglGetDisplay 失败" }
        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize 失败" }

        val attribList = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_NONE
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val numConfigs = IntArray(1)
        check(
            EGL14.eglChooseConfig(display, attribList, 0, configs, 0, 1, numConfigs, 0) &&
                numConfigs[0] > 0
        ) { "eglChooseConfig 失败" }

        val attribCtx = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
        val context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, attribCtx, 0)
        check(context !== EGL14.EGL_NO_CONTEXT) { "eglCreateContext 失败" }

        val attribWin = intArrayOf(EGL14.EGL_NONE)
        val windowSurface = EGL14.eglCreateWindowSurface(display, configs[0], encoderSurface, attribWin, 0)
        check(windowSurface !== EGL14.EGL_NO_SURFACE && windowSurface != null) { "eglCreateWindowSurface 失败" }

        check(EGL14.eglMakeCurrent(display, windowSurface, windowSurface, context)) { "eglMakeCurrent 失败" }

        eglDisplay = display
        eglContext = context
        eglSurface = windowSurface
    }

    private fun setupTexture() {
        val display = eglDisplay!!
        program = buildProgram()

        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        texId = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)

        val st = SurfaceTexture(texId)
        st.setDefaultBufferSize(inWidth, inHeight)
        st.setOnFrameAvailableListener({ renderFrame() }, handler)
        surfaceTexture = st
        cameraSurface = Surface(st)

        Matrix.setIdentityM(mvpMatrix, 0)
        Matrix.rotateM(mvpMatrix, 0, -rotationDegrees.toFloat(), 0f, 0f, 1f) // NDC 里顺时针
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        EGL14.eglMakeCurrent(display, eglSurface, eglSurface, eglContext)
    }

    private fun buildProgram(): Int {
        val vs = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
        val fs = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
        val p = GLES20.glCreateProgram()
        GLES20.glAttachShader(p, vs)
        GLES20.glAttachShader(p, fs)
        GLES20.glLinkProgram(p)
        val status = IntArray(1)
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, status, 0)
        check(status[0] == GLES20.GL_TRUE) { "着色器链接失败：${GLES20.glGetProgramInfoLog(p)}" }
        return p
    }

    private fun compileShader(type: Int, src: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, src)
        GLES20.glCompileShader(shader)
        val status = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        check(status[0] == GLES20.GL_TRUE) { "着色器编译失败：${GLES20.glGetShaderInfoLog(shader)}" }
        return shader
    }

    // ------------------------------------------------------------------ draw

    private fun renderFrame() {
        if (released.get()) return
        val st = surfaceTexture ?: return
        val display = eglDisplay ?: return
        val surface = eglSurface ?: return
        try {
            st.updateTexImage()
            st.getTransformMatrix(stMatrix)

            GLES20.glViewport(0, 0, outWidth, outHeight)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            GLES20.glUseProgram(program)

            val aPos = GLES20.glGetAttribLocation(program, "aPos")
            val aTex = GLES20.glGetAttribLocation(program, "aTex")
            val uMvp = GLES20.glGetUniformLocation(program, "uMvp")
            val uSt = GLES20.glGetUniformLocation(program, "uSt")
            val uTex = GLES20.glGetUniformLocation(program, "uTex")

            vertexBuffer.position(0)
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)
            vertexBuffer.position(2)
            GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)
            GLES20.glEnableVertexAttribArray(aPos)
            GLES20.glEnableVertexAttribArray(aTex)

            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId)
            GLES20.glUniform1i(uTex, 0)
            GLES20.glUniformMatrix4fv(uMvp, 1, false, mvpMatrix, 0)
            GLES20.glUniformMatrix4fv(uSt, 1, false, stMatrix, 0)

            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GLES20.glDisableVertexAttribArray(aPos)
            GLES20.glDisableVertexAttribArray(aTex)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)

            // 帧时间戳透传给编码器（纳秒），保证远端节奏与采集一致
            EGLExt.eglPresentationTimeANDROID(display, surface, st.timestamp)
            EGL14.eglSwapBuffers(display, surface)
        } catch (e: Throwable) {
            listener.onError("GL 渲染异常：${e.message}", e)
        }
    }

    // ---------------------------------------------------------------- cleanup

    private fun cleanup() {
        runCatching { surfaceTexture?.setOnFrameAvailableListener(null) }
        runCatching { cameraSurface?.release() }
        cameraSurface = null
        runCatching { surfaceTexture?.release() }
        surfaceTexture = null
        if (texId != 0) {
            runCatching { GLES20.glDeleteTextures(1, intArrayOf(texId), 0) }
            texId = 0
        }
        if (program != 0) {
            runCatching { GLES20.glDeleteProgram(program) }
            program = 0
        }
        eglDisplay?.let { display ->
            eglSurface?.let { runCatching { EGL14.eglDestroySurface(display, it) } }
            eglContext?.let { runCatching { EGL14.eglDestroyContext(display, it) } }
            runCatching { EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT) }
            runCatching { EGL14.eglTerminate(display) }
        }
        eglDisplay = null
        eglContext = null
        eglSurface = null
    }

    private fun floatBufferOf(data: FloatArray): FloatBuffer =
        ByteBuffer.allocateDirect(data.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
            .apply { put(data); position(0) }
}
