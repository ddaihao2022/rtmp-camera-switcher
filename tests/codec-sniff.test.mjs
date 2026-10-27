/**
 * 编码嗅探单测：用 ffmpeg 真实产出的 AVC sequence header 样本，验证
 * 1) 能从 VideoTag 头认出 codecId=7；
 * 2) 能从 SPS 解析出正确分辨率（含 1080p 这类需要裁剪的）；
 * 3) enhanced-RTMP 的 FourCC（hvc1/av01/vp09）也能识别；
 * 4) 帧率统计按包计数正确结算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codec = require('../server/codec.js');

// 以下 hex 取自 ffmpeg 9.0.2 用 libx264 编码后写入 FLV 的第一个视频 tag body
// （即 AVCDecoderConfigurationRecord），完整原样，未裁剪
const SAMPLES = [
  ['1280x720 high', 1280, 720,
    '17000000000164001fffe1001a6764001facd9405005bb0110000003001000000303c0f183196001000668ebe3cb22c0fdf8f800'],
  ['1920x1080 main', 1920, 1080,
    '1700000000014d4028ffe1001a674d4028eca03c0113f2e022000003000200000300641e30632c01000568ebe3cb20'],
  ['640x360 baseline', 640, 360,
    '17000000000142c01fffe100196742c01fd900a02ff97011000003000100000300780f18324801000568cb83cb20'],
];

test('describeVideoTag 识别 AVC (0x17 / 0x27)', () => {
  assert.equal(codec.describeVideoTag(Buffer.from([0x17, 0x00, 0, 0, 0])), 7);
  assert.equal(codec.describeVideoTag(Buffer.from([0x27, 0x01, 0, 0, 0])), 7);
  assert.equal(codec.describeVideoTag(Buffer.from([0x47, 0x01, 0, 0, 0])), 7);
});

test('describeVideoTag 识别 enhanced-RTMP 的 FourCC', () => {
  assert.equal(codec.describeVideoTag(Buffer.from([0x90, 0x68, 0x76, 0x63, 0x31, 0x00])), 'hvc1');
  assert.equal(codec.describeVideoTag(Buffer.from([0x90, 0x61, 0x76, 0x30, 0x31, 0x00])), 'av01');
  assert.equal(codec.describeVideoTag(Buffer.from([0x90, 0x76, 0x70, 0x30, 0x39, 0x00])), 'vp09');
});

test('describeVideoTag 对垃圾数据返回 null 而不是瞎猜', () => {
  assert.equal(codec.describeVideoTag(Buffer.alloc(0)), null);
  assert.equal(codec.describeVideoTag(Buffer.from([0x00, 0x00])), null);
});

for (const [label, width, height, hex] of SAMPLES) {
  test(`SPS 解析分辨率 ${label} → ${width}x${height}`, () => {
    const body = Buffer.from(hex, 'hex');
    assert.equal(body[0] & 0x0f, 7);
    assert.equal(body[1], 0); // AVCPacketType = 0（sequence header）
    const dims = codec.parseAvcSequenceHeader(body);
    assert.equal(dims.width, width);
    assert.equal(dims.height, height);
    assert.equal(dims.bitDepth, 8);
    assert.equal(dims.chromaFormatIdc, 1);
  });
}

test('applyPacket 从 AVC sequence header 记录 8-bit 4:2:0', () => {
  const info = codec.createStreamInfo();
  const body = Buffer.from(SAMPLES[0][3], 'hex');
  codec.applyPacket(info, { codec_type: 9, flags: 2, data: body });
  assert.equal(info.videoCodec, 7);
  assert.equal(info.videoBitDepth, 8);
  assert.equal(info.videoChromaFormat, 1);
});

test('applyPacket 统计帧率与编码', () => {
  const info = codec.createStreamInfo();
  const frame = { codec_type: 9, flags: 4, data: Buffer.from([0x27, 0x01, 0, 0, 0, 0xff]) };
  codec.applyPacket(info, frame);
  assert.equal(info.videoCodec, 7);
  // 人为把时间窗拨回，再喂一帧，应结算出帧率
  info.windowStart = Date.now() - 2000;
  info.videoFrames = 29;
  codec.applyPacket(info, frame);
  assert.ok(info.videoFramerate >= 10, `fps=${info.videoFramerate}`);
  assert.equal(info.videoFrames, 0);
});

test('trackPacket 按 streamPath 分桶，音频格式也能读到', () => {
  const map = new Map();
  codec.trackPacket(map, '/live/cam1', { codec_type: 9, flags: 4, data: Buffer.from([0x27, 1, 0, 0, 0, 1]) });
  codec.trackPacket(map, '/live/cam1', { codec_type: 8, flags: 1, data: Buffer.from([0xaf, 0x01, 0x00]) });
  assert.equal(map.get('/live/cam1').videoCodec, 7);
  assert.equal(map.get('/live/cam1').audioCodec, 10); // AAC
  assert.equal(map.get('/live/cam2'), undefined);
});
