/**
 * 端口被占用时的启动提示：打包版双击后不该「什么都不发生」
 *
 * 场景就是升级时最常踩的坑：旧实例还在跑，占着 3001/1935/8000，
 * 新实例起不来 —— 现在必须给出一句人话（日志 + Electron 弹窗），并以非 0 退出。
 *
 * 做法：测试自己先用一个高位端口顶替 API 端口占住，再启动服务端
 * （RTMP/FLV 换到别的空闲端口，cwd 指向临时目录，不碰 data/，也不碰本机实例），
 * 期望它在几秒内退出、并打印「端口已被占用」。
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 3601;      // 顶替 3001 的那个「旧实例」
const RTMP_PORT = 13601;    // 换开的推流端口
const FLV_PORT = 8601;      // 换开的播放端口
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDirParent = mkdtempSync(path.join(os.tmpdir(), 'rtmp-porttest-'));

const squatter = net.createServer(() => {});
await new Promise((resolve, reject) => {
  squatter.once('error', reject);
  // 必须绑 0.0.0.0：Windows 上「127.0.0.1 已占用」不影响别人再绑 0.0.0.0，模拟不出冲突
  squatter.listen(API_PORT, resolve);
});

let child = null;
let out = '';
let failed = false;
try {
  console.log('端口占用提示');
  console.log(`  已占住 ${API_PORT}（模拟旧实例还在跑）`);

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: dataDirParent,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(API_PORT), RTMP_PORT: String(RTMP_PORT), FLV_PORT: String(FLV_PORT) },
  });
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });

  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    sleep(20000).then(() => 'timeout'),
  ]);

  try {
    assert.notEqual(exited, 'timeout', '端口被占用时应在数秒内退出，而不是挂在那儿');
    assert.notEqual(exited, 0, `应以非 0 退出码结束，实际 ${exited}`);
    assert.ok(out.includes('端口已被占用'), `应打印「端口已被占用」，实际输出：\n${out}`);
    assert.ok(out.includes(String(API_PORT)), '提示里应带上被占用的端口号');
    assert.ok(out.includes('退出正在运行的旧实例'), '提示里应说清怎么处理');
    console.log('  ✓ 端口被占用：数秒内退出，不静默');
    console.log('  ✓ 日志给出「谁占用 / 怎么办」');
  } catch (err) {
    failed = true;
    console.error(`  ✗ ${err.message}`);
  }

  if (!failed) console.log('\n✅ 端口冲突提示 2 项全部通过');
} finally {
  if (child && child.exitCode === null) child.kill();
  squatter.close();
  await sleep(300);
  if (existsSync(dataDirParent)) rmSync(dataDirParent, { recursive: true, force: true });
}

if (failed) process.exit(1);
