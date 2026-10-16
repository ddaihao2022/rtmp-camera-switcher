package com.rtmp.camsender.stream

import android.content.Context
import android.view.OrientationEventListener

/**
 * 手机物理方向监听（0/90/180/270）。
 *
 * 用物理方向而不是 Display.getRotation()，因为主界面锁竖屏，
 * Display 的旋转角不会反映用户把手机横过来这个事实。
 */
class OrientationMonitor(context: Context) {

    companion object {
        /** 最近一次物理方向，0=自然竖持，90=逆时针横持，270=顺时针横持。 */
        @Volatile
        var lastOrientationDegrees: Int = 0
            internal set
    }

    private val listener = object : OrientationEventListener(context) {
        override fun onOrientationChanged(orientation: Int) {
            if (orientation == ORIENTATION_UNKNOWN) return
            lastOrientationDegrees = when {
                orientation >= 315 || orientation < 45 -> 0
                orientation < 135 -> 90
                orientation < 225 -> 180
                else -> 270
            }
        }
    }

    fun enable() {
        runCatching { if (listener.canDetectOrientation()) listener.enable() }
    }

    fun disable() {
        runCatching { listener.disable() }
    }
}
