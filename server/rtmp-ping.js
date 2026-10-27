/**
 * RTMP User Control 心跳回应。
 *
 * node-media-server v4 的 Rtmp.eventHandler 是空函数，摄像机/硬件编码器发
 * User Control PingRequest（event 6）时服务端不回 PingResponse（event 7）。
 * 很多摄像机等不到 pong，会按自身超时（常见 1~3 分钟）主动断开 RTMP，
 * 现场表现就是“推一会儿自己掉”。
 *
 * 这里给会话补一个标准 PingResponse，不改 node_modules。
 */
function patchRtmpPing(session, logger) {
  const rtmp = session?.rtmp;
  if (!rtmp || rtmp.__pingPatched) return;
  rtmp.__pingPatched = true;

  rtmp.eventHandler = function () {
    try {
      const payload = this.parserPacket?.payload;
      if (!payload || payload.length < 6) return;
      const eventType = payload.readUInt16BE(0);
      if (eventType !== 6) return; // 6 = PingRequest

      // RTMP 消息头：fmt=0 / csid=2（协议控制通道）
      // 1B basic + 11B message header + 6B user control payload
      const out = Buffer.alloc(18);
      out[0] = 0x02;                    // fmt=0, csid=2
      out.writeUIntBE(0, 1, 3);         // timestamp
      out.writeUIntBE(6, 4, 3);         // message length
      out[7] = 4;                       // message type: user control
      out.writeUInt32LE(0, 8);          // message stream id
      out.writeUInt16BE(7, 12);         // event 7 = PingResponse
      payload.copy(out, 14, 2, 6);      // 原样回带 4 字节时间戳
      this.onOutputCallback?.(out);
      logger?.verbose?.(`[RTMP] 已回应 PingRequest ${session.id}`);
    } catch (e) {
      logger?.verbose?.('[RTMP] ping 回应失败', e?.message);
    }
  };

  logger?.verbose?.(`[RTMP] 已挂载 ping 回应 ${session.id}`);
}

module.exports = { patchRtmpPing };
