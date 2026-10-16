/**
 * 端口占位检查：e2e / CDP 测试要起 server(3001) + vite(5173) + electron，
 * 而渲染层里的 API 地址是写死的 http://localhost:3001 —— 所以本机若装着自己那份
 * RTMP Camera Switcher 并且正在运行，这些测试就没法插进去。
 *
 * 这种情况直接「跳过」（退出码 0 + ⏭ 提示），不要报成失败：先关掉正在运行的实例再跑即可。
 */
import net from 'node:net';

export function portBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.connect({ host, port });
    probe.setTimeout(600);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(false));
  });
}

export async function busyPorts(ports) {
  const out = [];
  for (const p of ports) if (await portBusy(p)) out.push(p);
  return out;
}

/** 端口被占就跳过本测试（退出码 0），返回被占用的端口列表 */
export async function skipIfPortsBusy(ports, label) {
  const busy = await busyPorts(ports);
  if (!busy.length) return busy;
  console.log(`⏭ 跳过「${label}」：需要空闲端口 ${ports.join(' / ')}，当前 ${busy.join(' / ')} 被占用`);
  console.log('   多半是本机正在运行的成品实例（RTMP Camera Switcher）：退出它之后重跑即可。');
  process.exit(0);
}
