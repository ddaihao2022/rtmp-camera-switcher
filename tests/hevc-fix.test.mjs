/**
 * legacy FLV HEVC（codec id 12）修复单测
 *
 * 覆盖：
 *  1) 从真实设备关键帧的带内 NAL 里捞出 VPS/SPS/PPS，合成标准 hvcC；
 *  2) 从 HEVC SPS 解析分辨率（真实样本是 1280x720）；
 *  3) 代码帧 / 关键帧被改写成 enhanced-RTMP hvc1 头，flags 同步修正；
 *  4) 关键帧会额外补发 sequence header（供中途连上来的 ffmpeg / 播放器取参数集）；
 *  5) 垃圾数据不瞎改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hf = require('../server/hevc-fix.js');

// 真实设备（某国产摄像头 App）推上来的参数集
const VPS = Buffer.from('40010c01ffff21600000030000030000030000030096ac0c0000030004000003007940', 'hex');
const SPS = Buffer.from('42010121600000030000030000030000030096a00280802d165aeedc9ae5d4d404040410000003001000000301e080', 'hex');
const PPS = Buffer.from('4401c17284890224', 'hex');

// 期望的 hvcC（ffmpeg 能直接吃）
const EXPECTED_HVCC =
  '01216000000300000300000300f000fcfdf8f800000f03200001002340010c01ffff21600000030000030000030000030096ac0c0' +
  '000030004000003007940210001002f42010121600000030000030000030000030096a00280802d165aeedc9ae5d4d40404041' +
  '0000003001000000301e08022000100084401c17284890224';

/** 造一个 legacy codec 12 的关键帧 body（4 字节长度前缀 NAL） */
function legacyKeyFrameBody(nals) {
  const chunks = [];
  for (const nal of nals) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length, 0);
    chunks.push(len, Buffer.from(nal));
  }
  const payload = Buffer.concat(chunks);
  const body = Buffer.alloc(5 + payload.length);
  body[0] = 0x1c; // frameType=1(key) | codecId=12
  body[1] = 0x01; // AVCPacketType = coded frames
  payload.copy(body, 5);
  return body;
}

test('pickParamSets 能从带内 NAL 里认出 VPS/SPS/PPS', () => {
  const junk = Buffer.from([0x02, 0x01, 0xaa, 0xbb]);
  const nals = [junk, VPS, SPS, PPS];
  const sets = hf.pickParamSets(nals);
  assert.ok(sets);
  assert.equal(sets.vps.toString('hex'), VPS.toString('hex'));
  assert.equal(sets.sps.toString('hex'), SPS.toString('hex'));
  assert.equal(sets.pps.toString('hex'), PPS.toString('hex'));
});

test('pickParamSets 缺参数集时返回 null（不能瞎凑）', () => {
  assert.equal(hf.pickParamSets([VPS, SPS]), null);
  assert.equal(hf.pickParamSets([]), null);
});

test('buildHvcC 与 ffmpeg 能解的 hvcC 逐字节一致', () => {
  assert.equal(hf.buildHvcC(VPS, SPS, PPS).toString('hex'), EXPECTED_HVCC);
});

test('HEVC SPS 解析出 1280x720', () => {
  assert.deepEqual(hf.parseHevcSpsDimensions(SPS), { width: 1280, height: 720 });
});

test('SPS 是垃圾数据时返回 null', () => {
  assert.equal(hf.parseHevcSpsDimensions(Buffer.alloc(0)), null);
  assert.equal(hf.parseHevcSpsDimensions(Buffer.from([1, 2])), null);
});

test('isLegacyHevc 只认 codec 12，enhanced 头和 H.264 都不算', () => {
  assert.equal(hf.isLegacyHevc(Buffer.from([0x1c, 1, 0, 0, 0, 0])), true);
  assert.equal(hf.isLegacyHevc(Buffer.from([0x2c, 1, 0, 0, 0, 0])), true);
  assert.equal(hf.isLegacyHevc(Buffer.from([0x17, 0, 0, 0, 0, 0])), false);
  assert.equal(hf.isLegacyHevc(Buffer.from([0x91, 0x68, 0x76, 0x63, 0x31, 0])), false);
});

test('fixer 把关键帧改写成 enhanced hvc1，并补发 sequence header', () => {
  const fixer = hf.createFixer();
  const emitted = [];
  const body = legacyKeyFrameBody([VPS, SPS, PPS, Buffer.from([0x26, 0x01, 0xaf, 0x00])]);
  const packet = { codec_type: 9, flags: 4, dts: 1000, data: body, size: body.length };

  const changed = fixer.process(packet, (hvcC) => emitted.push(hvcC));

  assert.equal(changed, true, '应该发生改写');
  assert.equal(packet.data[0], 0x91, 'enhanced 头：keyframe + sequence/coded frames 位');
  assert.equal(packet.data.subarray(1, 5).toString('latin1'), 'hvc1');
  assert.equal(packet.data.length, 8 + (body.length - 5), '8 字节增强头');
  assert.equal(packet.size, packet.data.length, 'size 必须同步，否则 NMS 按旧长度截断');
  assert.equal(packet.flags, 3, '关键帧 flags 要改成 3，否则 GOP 缓存不生效');
  assert.equal(emitted.length, 1, '关键帧要补发一次 sequence header');
  assert.equal(emitted[0].toString('hex'), EXPECTED_HVCC);
  assert.deepEqual(fixer.dimensions, { width: 1280, height: 720 });
});

test('fixer 对非关键帧只改写、不补发 sequence header', () => {
  const fixer = hf.createFixer();
  // 先喂关键帧让参数集就位
  const key = legacyKeyFrameBody([VPS, SPS, PPS, Buffer.from([0x26, 0x01, 0x01])]);
  fixer.process({ codec_type: 9, flags: 4, dts: 0, data: key, size: key.length }, () => {});

  const emitted = [];
  const inter = Buffer.from([0x2c, 0x01, 0, 0, 0, 0x00, 0x00, 0x00, 0x02, 0x01, 0xaa]);
  const packet = { codec_type: 9, flags: 4, dts: 40, data: inter, size: inter.length };
  const changed = fixer.process(packet, (h) => emitted.push(h));

  assert.equal(changed, true);
  assert.equal(packet.data[0], 0xa1, 'P 帧 = frameType 2 << 4 | packetType 1');
  assert.equal(packet.flags, 4);
  assert.equal(emitted.length, 0);
});

test('fixer 遇到参数集缺失的 P 帧不改写（避免产出无法解码的流）', () => {
  const fixer = hf.createFixer();
  const inter = Buffer.from([0x2c, 0x01, 0, 0, 0, 0x00, 0x00, 0x00, 0x02, 0x01, 0xaa]);
  const packet = { codec_type: 9, flags: 4, dts: 40, data: inter, size: inter.length };
  assert.equal(fixer.process(packet, () => {}), false);
  assert.equal(packet.data[0], 0x2c, '原样保留');
});

test('H.264 包完全不受影响', () => {
  const fixer = hf.createFixer();
  const avc = Buffer.from([0x17, 0x00, 0, 0, 0, 0x01, 0x42, 0x00, 0x1e]);
  const packet = { codec_type: 9, flags: 2, dts: 0, data: avc, size: avc.length };
  assert.equal(fixer.process(packet, () => {}), false);
  assert.equal(packet.data, avc, '同一个 Buffer 未被替换');
});

test('buildSequenceHeaderPacket 产出 0x90 + hvc1 + hvcC，flags=2', () => {
  const hvcC = hf.buildHvcC(VPS, SPS, PPS);
  const pkt = hf.buildSequenceHeaderPacket(hvcC, 1234);
  assert.equal(pkt.codec_type, 9);
  assert.equal(pkt.flags, 2);
  assert.equal(pkt.dts, 1234);
  assert.equal(pkt.data[0], 0x90);
  assert.equal(pkt.data.subarray(1, 5).toString('latin1'), 'hvc1');
  assert.equal(pkt.data.subarray(5).toString('hex'), EXPECTED_HVCC);
  assert.equal(pkt.size, pkt.data.length);
});
