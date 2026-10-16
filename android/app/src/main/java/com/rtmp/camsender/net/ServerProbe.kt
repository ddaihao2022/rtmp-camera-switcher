package com.rtmp.camsender.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL

/**
 * 导播系统探测。
 *
 * 服务器（server/index.js）已经暴露 GET /api/server-info，返回：
 *   { lanIp, rtmpPort, httpFlvPort, apiPort, rtmpBase, candidates }
 * 这里用它做两件事：验证填写的地址、扫描局域网自动找到电脑。
 */
object ServerProbe {

    const val DEFAULT_API_PORT = 3001

    data class ServerInfo(
        val host: String,
        val lanIp: String,
        val rtmpPort: Int,
        val httpFlvPort: Int,
        val apiPort: Int,
        val rtmpBase: String
    ) {
        fun rtmpUrl(streamKey: String) = "rtmp://$host:$rtmpPort/live/$streamKey"
        fun flvUrl(streamKey: String) = "http://$host:$httpFlvPort/live/$streamKey.flv"
    }

    /** 探测指定主机。成功返回 [ServerInfo]，失败返回 null。 */
    suspend fun probe(host: String, apiPort: Int = DEFAULT_API_PORT, timeoutMs: Int = 2500): ServerInfo? =
        withContext(Dispatchers.IO) {
            var conn: HttpURLConnection? = null
            try {
                val url = URL("http://$host:$apiPort/api/server-info")
                conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    requestMethod = "GET"
                    setRequestProperty("Accept", "application/json")
                }
                if (conn.responseCode != 200) return@withContext null
                val body = BufferedReader(conn.inputStream.reader()).use { it.readText() }
                val json = JSONObject(body)
                ServerInfo(
                    host = host,
                    lanIp = json.optString("lanIp", host),
                    rtmpPort = json.optInt("rtmpPort", 1935),
                    httpFlvPort = json.optInt("httpFlvPort", 8000),
                    apiPort = json.optInt("apiPort", apiPort),
                    rtmpBase = json.optString("rtmpBase", "rtmp://$host:1935/live")
                )
            } catch (e: Throwable) {
                null
            } finally {
                runCatching { conn?.disconnect() }
            }
        }

    /**
     * 扫描本机所在的局域网（最多 254 个地址，32 并发），返回第一个响应 /api/server-info 的服务器。
     */
    suspend fun discover(
        apiPort: Int = DEFAULT_API_PORT,
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> }
    ): ServerInfo? = coroutineScope {
        val prefix = localSubnetPrefix() ?: return@coroutineScope null
        val hosts = (1..254).map { "$prefix.$it" }
        val semaphore = Semaphore(32)
        val done = java.util.concurrent.atomic.AtomicInteger(0)

        val results = hosts.map { ip ->
            async(Dispatchers.IO) {
                semaphore.withPermit {
                    val info = probe(ip, apiPort, timeoutMs = 700)
                    onProgress(done.incrementAndGet(), hosts.size)
                    info
                }
            }
        }.mapNotNull { it.await() }

        // 优先返回 lanIp 与探测地址一致的那个（排除虚拟网卡）
        results.firstOrNull() ?: null
    }

    /** 取本机第一个私网 IPv4 的 /24 前缀，例如 192.168.1。 */
    fun localSubnetPrefix(): String? {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            for (nif in interfaces) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        val ip = addr.hostAddress ?: continue
                        val parts = ip.split(".")
                        if (parts.size == 4) return "${parts[0]}.${parts[1]}.${parts[2]}"
                    }
                }
            }
            null
        } catch (e: Throwable) {
            null
        }
    }

    /** 本机所有私网地址，便于提示用户与电脑在同一网段。 */
    fun localAddresses(): List<String> {
        val out = ArrayList<String>()
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        addr.hostAddress?.let { out.add(it) }
                    }
                }
            }
        } catch (e: Throwable) {
            // 忽略
        }
        return out
    }
}
