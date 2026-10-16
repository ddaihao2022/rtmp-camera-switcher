pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
    // 直接把插件 id 映射到 Maven Central 上的真实坐标，
    // 避免依赖 plugins.gradle.org 上的插件标记（该域名在部分网络下不可达）。
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "org.jetbrains.kotlin.jvm") {
                useModule("org.jetbrains.kotlin:kotlin-gradle-plugin:${requested.version}")
            }
        }
    }
}

rootProject.name = "rtmp-selftest"

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}
