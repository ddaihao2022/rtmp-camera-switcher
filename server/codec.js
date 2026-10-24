/**
 * 码流编码嗅探
 *
 * 背景：node-media-server 的 publisher.videoCodec 初值是 0，只有推流端发来
 * `@setDataFrame(onMetaData)` 时才会被赋值（broadcast_server.js:198）。
 * 因此只要推流端不发 metadata（部分摄像头 App、中转转码、ffmpeg 加了
 * `-flvflags no_metadata`、屏幕采集工具等），导播台读到的 videoCodec 就一直是 0，
 * 被前端判成"不支持的编码"而拒绝播放 —— 明明流本身是标准 H.264。
 *
 * 这里直接从码流本身判定：FLV VideoTag 首字节低 4 位就是 codecId（7=AVC），
 * enhanced-RTMP 则是高位置 1 + 紧随的 4 字节 FourCC（hvc1/av01/vp09）。
 * 另外顺带从 AVC sequence header 的 SPS 里解析出分辨率，并从包头统计实时帧率，
 * 这样不发 metadata 的推流端也能在机位列表里显示编码 / 分辨率 / 帧率。
 */

const FOURCC_HEVC = 'hvc1';
const FOURCC_VP9 = 'vp09';
const FOURCC_AV1 = 'av01';

const HIGH_PROFILE_IDC = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** 去掉 H.264 RBSP 的防竞争字节 0x00 0x00 0x03 */
function removeEmulationPrevention(bytes) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0x00 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function createBitReader(bytes) {
  let bytePos = 0;
  let bitPos = 0;
  return {
    bit() {
      if (bytePos >= bytes.length) return 0;
      const b = (bytes[bytePos] >> (7 - bitPos)) & 1;
      bitPos += 1;
      if (bitPos === 8) {
        bitPos = 0;
        bytePos += 1;
      }
      return b;
    },
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + this.bit();
      return v;
    },
    /** 无符号指数哥伦布 */
    ue() {
      let zeros = 0;
      while (this.bit() === 0 && zeros < 32) zeros += 1;
      if (zeros === 0) return 0;
      return (2 ** zeros - 1) + this.u(zeros);
    },
    /** 有符号指数哥伦布 */
    se() {
      const v = this.ue();
      return v % 2 === 1 ? (v + 1) / 2 : -(v / 2);
    },
  };
}

function skipScalingList(reader, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const deltaScale = reader.se();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/**
 * 从 SPS NAL（首字节是 0x67 这种 nal header）解析分辨率
 * @param {Buffer} nal
 * @returns {{width:number,height:number}|null}
 */
function parseSpsDimensions(nal) {
  if (!nal || nal.length < 5) return null;
  const rbsp = removeEmulationPrevention(nal.subarray(1));
  const r = createBitReader(rbsp);

  const profileIdc = r.u(8);
  r.u(8); // constraint_set flags
  r.u(8); // level_idc
  r.ue(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  let separateColourPlane = 0;

  if (HIGH_PROFILE_IDC.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit();
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      // seq_scaling_matrix_present_flag
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.bit(); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }

  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag

  const widthInMbs = r.ue() + 1;
  const heightInMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
  r.bit(); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (r.bit()) {
    cropLeft = r.ue();
    cropRight = r.ue();
    cropTop = r.ue();
    cropBottom = r.ue();
  }

  const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
  const subWidthC = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
  const subHeightC = chromaArrayType === 1 ? 2 : 1;
  const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
  const cropUnitY = (chromaArrayType === 0 ? 1 : subHeightC) * (2 - frameMbsOnly);

  const width = widthInMbs * 16 - cropUnitX * (cropLeft + cropRight);
  const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - cropUnitY * (cropTop + cropBottom);

  if (!width || !height || width > 16384 || height > 16384) return null;
  return { width, height };
}

/**
 * 从 FLV AVC sequence header（AVCDecoderConfigurationRecord）取 SPS 并解析
 * @param {Buffer} data 完整 VideoTag body：[0]=0x17 [1]=0x00 [2..4]=cts [5..]=config record
 */
function parseAvcSequenceHeader(data) {
  if (!data || data.length < 13) return null;
  let p = 5;
  if (data[p] !== 1) return null; // configurationVersion
  p += 4; // version/profile/compat/level
  p += 1; // lengthSizeMinusOne 那一个字节
  const numSps = data[p] & 0x1f;
  p += 1;
  if (!numSps) return null;
  const spsLength = data.readUInt16BE(p);
  p += 2;
  if (!spsLength || p + spsLength > data.length) return null;
  return parseSpsDimensions(data.subarray(p, p + spsLength));
}

/** 从 FLV VideoTag body 判断编码；返回 7 / 12 / 'hvc1' / 'av01' / 'vp09' / null */
function describeVideoTag(data) {
  if (!data || data.length < 2) return null;
  const head = data[0];
  const isExHeader = (head & 0x80) !== 0;
  if (isExHeader) {
    if (data.length < 5) return null;
    const fourcc = data.subarray(1, 5).toString('latin1').toLowerCase();
    return [FOURCC_HEVC, FOURCC_AV1, FOURCC_VP9].includes(fourcc) ? fourcc : null;
  }
  const codecId = head & 0x0f;
  return codecId || null;
}

function createStreamInfo() {
  return {
    videoCodec: null,
    audioCodec: null,
    videoWidth: 0,
    videoHeight: 0,
    videoFramerate: 0,
    videoFrames: 0,
    windowStart: 0,
  };
}

/**
 * 用一条 AVPacket 更新某个流的嗅探结果
 * @param {object} info createStreamInfo() 建立的记录（原地修改）
 * @param {object} packet NMS 的 AVPacket：codec_type 9=视频 8=音频，flags 3/4=视频帧
 */
function applyPacket(info, packet) {
  if (!packet || !info) return;
  const data = packet.data;
  if (!data || data.length < 2) return;

  if (packet.codec_type === 9) {
    const codec = describeVideoTag(data);
    if (codec) info.videoCodec = codec;

    if (info.videoCodec === 7 && packet.flags === 2) {
      const dims = parseAvcSequenceHeader(data);
      if (dims) {
        info.videoWidth = dims.width;
        info.videoHeight = dims.height;
      }
    }

    if (packet.flags === 3 || packet.flags === 4) {
      const now = Date.now();
      if (!info.windowStart) info.windowStart = now;
      info.videoFrames += 1;
      const elapsed = now - info.windowStart;
      if (elapsed >= 1000) {
        info.videoFramerate = Math.round((info.videoFrames * 1000) / elapsed);
        info.videoFrames = 0;
        info.windowStart = now;
      }
    }
  } else if (packet.codec_type === 8) {
    info.audioCodec = data[0] >> 4; // FLV SoundFormat，10=AAC
  }
}

/** 把一条包喂给按 streamPath 索引的嗅探表 */
function trackPacket(infoMap, streamPath, packet) {
  if (!infoMap || !streamPath || !packet) return;
  let info = infoMap.get(streamPath);
  if (!info) {
    info = createStreamInfo();
    infoMap.set(streamPath, info);
  }
  applyPacket(info, packet);
}

module.exports = {
  describeVideoTag,
  parseSpsDimensions,
  parseAvcSequenceHeader,
  createStreamInfo,
  applyPacket,
  trackPacket,
};
