plugins {
    kotlin("jvm") version "2.0.21"
    application
}

/**
 * 纯 JVM 的协议自测工程。
 *
 * 直接把 App 里的 rtmp 包（无任何 Android 依赖）原样编译，
 * 对真实的 node-media-server 推一路合成码流，再从 HTTP-FLV 拉回来校验，
 * 覆盖握手 / AMF0 / 分块收发 / FLV 封装 / 服务器登记与清理 全链路。
 *
 * 用法：先 `npm run server`（仓库根目录），再 `gradle -p tools/rtmp-selftest run`
 */
sourceSets {
    main {
        kotlin.srcDirs("src/main/kotlin", "../../app/src/main/java/com/rtmp/camsender/rtmp")
    }
}

dependencies {
    implementation(kotlin("stdlib"))
}

application {
    mainClass.set("com.rtmp.camsender.rtmp.TestMain")
    // 日志含中文，固定 UTF-8 便于重定向到文件后查看
    applicationDefaultJvmArgs = listOf("-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8")
}
