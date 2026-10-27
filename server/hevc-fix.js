/**
 * 老式 FLV HEVC（legacy codec id = 12）兼容修复
 *
 * 背景：部分国产摄像头 App / 老版本推流端把 H.265 塞进 FLV 时用的是**非标准**做法：
 *   - VideoTag 首字节写成 0x1C（frameType=1, codecId=12），走 AVC 那套 5 字节头；
 *   - **从不发 sequence header**（AVCPacketType 永远只有 1），于是 VPS/SPS/PPS 只以
 *     带内 NAL 的形式混在关键帧里；
 *   - NAL 用 4 字节长度前缀（AVCC 风格）。
 *
 * 这样一来 ffmpeg 拿不到 hvcC（extradata），就读不出分辨率、直接报
 * "No start code is found / unspecified size"，服务端转码和录制全部失败。
 *
 * 这里在 NMS 广播前把这类包就地改写成 **enhanced-RTMP 的 hvc1**：
 *   1) 从关键帧带内 NAL 里捞出 VPS/SPS/PPS，合成标准 hvcC；
 *   2) 输出 5 字节（sequence header）或 8 字节（coded frames）的增强头 + 原 NAL；
 *   3) 每个关键帧前补发一次 sequence header，让中途才连上来的播放器/ffmpeg 也能拿到参数集。
 *
 * 同时顺带从 HEVC SPS 解析分辨率，供导播台机位列表显示。
 */

const FOURCC_HEVC = 'hvc1';

/** 去掉 HEVC RBSP 的防竞争字节 0x00 0x00 0x03 */
function removeEmulationPrevention(bytes) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < bytes.length; i += 1) {
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
      for (let i = 0; i < n; i += 1) v = v * 2 + this.bit();
      return v;
    },
    skip(n) {
      for (let i = 0; i < n; i += 1) this.bit();
    },
    ue() {
      let zeros = 0;
      while (this.bit() === 0 && zeros < 32) zeros += 1;
      if (zeros === 0) return 0;
      return 2 ** zeros - 1 + this.u(zeros);
    },
  };
}

/**
 * 拆「4 字节大端长度 + NAL」格式的负载
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {Buffer[]}
 */
function splitLengthPrefixedNals(buf, offset = 0) {
  const nals = [];
  let p = offset;
  while (p + 4 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len <= 0 || p + 4 + len > buf.length) break;
    nals.push(buf.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return nals;
}

/**
 * 拆 Annex-B（00 00 01 / 00 00 00 01 起始码）的 NAL 负载。
 * GStreamer 的 flvmux 推 HEVC 时经常直接把 Annex-B 塞进 VideoTag，
 * 而不是 AVCC 的 4 字节长度前缀；不转换就会被 ffmpeg 当成超大 NAL 长度。
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
function splitAnnexBNals(buf) {
  const nals = [];
  let start = -1;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      // 4 字节起始码 00 00 00 01 会在第二个 00 处命中；
      // 前面那个 00 也属于起始码，不能算进上一个 NAL 的尾部。
      let scStart = i;
      if (i > 0 && buf[i - 1] === 0) scStart = i - 1;
      if (start >= 0 && scStart > start) nals.push(buf.subarray(start, scStart));
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < buf.length) nals.push(buf.subarray(start));
  return nals.filter((n) => n.length > 0);
}

/**
 * 自动识别 Annex-B / AVCC，返回不带前缀的 NAL 列表。
 * @param {Buffer} buf
 * @returns {{ nals: Buffer[], annexB: boolean }}
 */
function splitNals(buf) {
  const annexB = buf.length >= 4
    && ((buf[0] === 0 && buf[1] === 0 && buf[2] === 1)
      || (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1));
  return {
    annexB,
    nals: annexB ? splitAnnexBNals(buf) : splitLengthPrefixedNals(buf, 0),
  };
}

/** 把 NAL 列表重新打包成 4 字节大端长度前缀（enhanced-RTMP 要求） */
function toLengthPrefixed(nals) {
  const parts = [];
  for (const nal of nals) {
    if (!nal || !nal.length) continue;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length, 0);
    parts.push(len, Buffer.from(nal));
  }
  return Buffer.concat(parts);
}

function isPlausibleNals(nals) {
  if (!nals.length) return false;
  let vcl = 0;
  let paramSets = 0;
  for (const nal of nals) {
    if (!nal || nal.length < 2) return false;
    const t = hevcNalType(nal);
    if (t < 0 || t > 63) return false;
    if (t <= 31) vcl += 1;
    if (t === 32 || t === 33 || t === 34) paramSets += 1;
  }
  return vcl > 0 || paramSets > 0;
}

/**
 * 不同推流端的 FLV VideoTag 头长度不一致（标准 5 字节、GStreamer 有时只留 4 字节、
 * enhanced 编码帧 8 字节）。这里按候选偏移逐个试，选 NAL 结构最合理的那个，
 * 避免“差一个字节”就把整个 NAL 长度读错。
 */
function findNalPayload(data, offsets) {
  for (const off of offsets) {
    if (off < 0 || off >= data.length) continue;
    const payload = data.subarray(off);
    const parsed = splitNals(payload);
    if (!isPlausibleNals(parsed.nals)) continue;
    if (!parsed.annexB) {
      // AVCC：长度前缀应基本覆盖整个 payload；差太多说明偏移选错了
      const covered = parsed.nals.reduce((s, n) => s + 4 + n.length, 0);
      if (payload.length - covered > 8) continue;
    }
    return { offset: off, ...parsed };
  }
  return null;
}

/** 给 enhanced-RTMP 编码帧套 8 字节头（payload 已长度前缀化） */
function buildEnhancedFrame(data, isKey, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out[0] = 0x80 | ((isKey ? 1 : 2) << 4) | 1;
  out.write(FOURCC_HEVC, 1, 'latin1');
  // 原 cts 在 [2..4]，实时采集恒为 0，照抄即可
  out[5] = data[2];
  out[6] = data[3];
  out[7] = data[4];
  payload.copy(out, 8);
  return out;
}

/** 给 enhanced-RTMP sequence header 套 5 字节头 */
function buildEnhancedSeq(hvcC) {
  const out = Buffer.alloc(5 + hvcC.length);
  out[0] = 0x90; // keyframe + sequence header
  out.write(FOURCC_HEVC, 1, 'latin1');
  hvcC.copy(out, 5);
  return out;
}

/** HEVC NAL 类型：32=VPS 33=SPS 34=PPS */
function hevcNalType(nal) {
  if (!nal || nal.length < 2) return -1;
  return (nal[0] >> 1) & 0x3f;
}

function pickParamSets(nals) {
  let vps = null;
  let sps = null;
  let pps = null;
  for (const nal of nals) {
    const t = hevcNalType(nal);
    if (t === 32 && !vps) vps = nal;
    else if (t === 33 && !sps) sps = nal;
    else if (t === 34 && !pps) pps = nal;
    if (vps && sps && pps) break;
  }
  return vps && sps && pps ? { vps, sps, pps } : null;
}

/**
 * 合成 HEVCDecoderConfigurationRecord（hvcC）
 * 前 12 字节的 profile/tier/level/兼容位直接从 SPS 的 profile_tier_level() 抄
 *（SPS 前 2 字节是 NAL 头，第 3 字节含 vps_id/层数，PTL 从 SPS[3] 起，正好 12 字节）。
 */
function buildHvcC(vps, sps, pps) {
  const parts = [Buffer.from([1])]; // configurationVersion
  if (sps.length >= 15) {
    parts.push(Buffer.from(sps.subarray(3, 15)));
  } else {
    parts.push(Buffer.from([0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5d]));
  }
  parts.push(Buffer.from([0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0x00, 0x00, 0x0f]));
  const sets = [[32, vps], [33, sps], [34, pps]];
  parts.push(Buffer.from([sets.length]));
  for (const [type, nal] of sets) {
    const arrHead = Buffer.from([0x20 | type]);
    const num = Buffer.alloc(2);
    num.writeUInt16BE(1, 0);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(nal.length, 0);
    parts.push(arrHead, num, len, Buffer.from(nal));
  }
  return Buffer.concat(parts);
}

/**
 * 从 HEVC SPS 解析分辨率
 * @param {Buffer} sps 含 2 字节 NAL 头的 SPS
 * @returns {{width:number,height:number}|null}
 */
function parseHevcSpsDimensions(sps) {
  if (!sps || sps.length < 12) return null;
  const rbsp = removeEmulationPrevention(Buffer.from(sps).subarray(2));
  const r = createBitReader(rbsp);
  try {
    r.u(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.u(3);
    r.u(1); // sps_temporal_id_nesting_flag

    // ---- profile_tier_level(1, maxSubLayersMinus1) ----
    r.u(2); // general_profile_space
    r.u(1); // general_tier_flag
    const profileIdc = r.u(5);
    r.u(32); // general_profile_compatibility_flags
    r.u(4); // progressive/interlaced/non_packed/frame_only
    if (profileIdc >= 4 && profileIdc <= 11) {
      r.u(32); // constraint flags
      r.u(12); // reserved
    } else {
      r.u(44); // general_reserved_zero_44bits
    }
    r.u(8); // general_level_idc
    if (maxSubLayersMinus1 > 0) {
      const subProfile = [];
      const subLevel = [];
      for (let i = 0; i < maxSubLayersMinus1; i += 1) {
        subProfile.push(r.u(1));
        subLevel.push(r.u(1));
      }
      for (let i = maxSubLayersMinus1; i < 8; i += 1) r.u(2); // reserved_zero_2bits
      for (let i = 0; i < maxSubLayersMinus1; i += 1) {
        if (subProfile[i]) r.skip(88);
        if (subLevel[i]) r.skip(8);
      }
    }

    r.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.u(1); // separate_colour_plane_flag
    const picWidth = r.ue();
    const picHeight = r.ue();
    if (r.u(1)) {
      // conformance_window_flag
      const left = r.ue();
      const right = r.ue();
      const top = r.ue();
      const bottom = r.ue();
      const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
      const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
      const width = picWidth - subWidthC * (left + right);
      const height = picHeight - subHeightC * (top + bottom);
      if (valid(width, height)) return { width, height };
    }
    if (valid(picWidth, picHeight)) return { width: picWidth, height: picHeight };
    return null;
  } catch {
    return null;
  }
}

function valid(w, h) {
  return w > 0 && h > 0 && w <= 16384 && h <= 16384;
}

/** 是否为 legacy codec 12 的 FLV VideoTag body */
function isLegacyHevc(data) {
  return Boolean(data && data.length >= 6 && (data[0] & 0x80) === 0 && (data[0] & 0x0f) === 12);
}

/** 是否为 enhanced-RTMP 的 hvc1 VideoTag body */
function isEnhancedHevc(data) {
  return Boolean(data && data.length >= 6 && (data[0] & 0x80) === 0x80
    && data.toString('latin1', 1, 5) === FOURCC_HEVC);
}

/**
 * 为某一路流创建修复器（每个 BroadcastServer 一个）
 */
function createFixer() {
  let hvcC = null;
  let dims = null;
  let logged = false;
  let loggedFormat = false;

  return {
    get hvcC() {
      return hvcC;
    },
    get dimensions() {
      return dims;
    },
    /**
     * 处理一个包（原地改写 packet）
     * @param {object} packet NMS AVPacket
     * @param {(seqPacket:object)=>void} emit 用于补发 sequence header
     * @returns {boolean} 是否改写过
     */
    process(packet, emit) {
      if (!packet || packet.codec_type !== 9) return false;

      const data = packet.data;

      // 已经是 enhanced-RTMP hvc1：兼容两类异常推流端
      //   ① 编码帧用 Annex-B 起始码；② sequence header 用 Annex-B 参数集
      if (isEnhancedHevc(data)) {
        const enhancedType = data[0] & 0x0f; // 0=sequence header 1=coded frames

        if (enhancedType === 0) {
          const found = findNalPayload(data, [5, 4, 6]);
          if (!found) return false; // 已经是标准 hvcC，保持原样
          const sets = pickParamSets(found.nals);
          if (!sets) return false;
          const seq = buildHvcC(sets.vps, sets.sps, sets.pps);
          const next = buildEnhancedSeq(seq);
          packet.data = next;
          packet.size = next.length;
          packet.flags = 2;
          return true;
        }

        if (enhancedType !== 1) return false;
        const found = findNalPayload(data, [8, 7, 9]);
        if (!found) return false;
        if (!loggedFormat && (found.offset !== 8 || found.annexB)) {
          loggedFormat = true;
          console.log(`[hevc-fix] 检测到非标准 enhanced HEVC：头偏移 ${found.offset}，${found.annexB ? 'Annex-B' : 'AVCC'}，已归一化`);
        }
        const isKey = ((data[0] >> 4) & 0x01) === 1;
        const next = buildEnhancedFrame(data, isKey, toLengthPrefixed(found.nals));
        packet.data = next;
        packet.size = next.length;
        packet.flags = isKey ? 3 : 4;
        return true;
      }

      if (!isLegacyHevc(data)) return false;

      const frameType = (data[0] >> 4) & 0x07;
      const packetType = data[1];

      if (packetType === 0) {
        // legacy sequence header：可能直接是 hvcC，也可能是 Annex-B 参数集
        let seq = null;
        for (const off of [5, 4]) {
          const payload = data.subarray(off);
          if (payload.length > 20 && payload[0] === 1) { seq = Buffer.from(payload); break; }
        }
        if (!seq) {
          const found = findNalPayload(data, [5, 4]);
          const sets = found ? pickParamSets(found.nals) : null;
          if (sets) seq = buildHvcC(sets.vps, sets.sps, sets.pps);
        }
        if (!seq) return false;
        hvcC = seq;
        const next = buildEnhancedSeq(seq);
        packet.data = next;
        packet.size = next.length;
        packet.flags = 2;
        if (emit) emit(null);
        return true;
      }

      if (packetType !== 1) return false;

      // 编码帧：偏移 5 是标准 legacy 头，4 是 GStreamer 少写 CTS 的情况，8 是误用 enhanced 头
      const found = findNalPayload(data, [5, 4, 8]);
      if (!found) return false;
      if (!loggedFormat && (found.offset !== 5 || found.annexB)) {
        loggedFormat = true;
        console.log(`[hevc-fix] 检测到非标准 HEVC 封装：头偏移 ${found.offset}，${found.annexB ? 'Annex-B' : 'AVCC'}，已归一化为长度前缀`);
      }

      // 关键帧里通常带内联 VPS/SPS/PPS：捞出来合成 hvcC
      if (!hvcC) {
        const sets = pickParamSets(found.nals);
        if (sets) {
          hvcC = buildHvcC(sets.vps, sets.sps, sets.pps);
          dims = parseHevcSpsDimensions(sets.sps);
          if (!logged) {
            logged = true;
            console.log('[hevc-fix] 已从关键帧合成 hvcC', dims ? `${dims.width}x${dims.height}` : '');
          }
        }
      }
      if (!hvcC) return false;

      const isKey = frameType === 1;
      if (isKey && emit) emit(hvcC);

      const next = buildEnhancedFrame(data, isKey, toLengthPrefixed(found.nals));
      packet.data = next;
      packet.size = next.length;
      packet.flags = isKey ? 3 : 4;
      return true;
    },
  };
}

/** 由 hvcC 造一个 enhanced-RTMP sequence header 包（走 NMS 广播用的轻量对象） */
function buildSequenceHeaderPacket(hvcC, dts = 0) {
  const data = Buffer.alloc(5 + hvcC.length);
  data[0] = 0x80 | (1 << 4) | 0;
  data.write(FOURCC_HEVC, 1, 'latin1');
  Buffer.from(hvcC).copy(data, 5);
  return {
    codec_type: 9,
    codec_id: Buffer.from(FOURCC_HEVC, 'latin1').readUInt32BE(0),
    flags: 2,
    pts: dts,
    dts,
    size: data.length,
    data,
  };
}

module.exports = {
  createFixer,
  buildHvcC,
  buildSequenceHeaderPacket,
  parseHevcSpsDimensions,
  splitLengthPrefixedNals,
  splitAnnexBNals,
  splitNals,
  toLengthPrefixed,
  pickParamSets,
  isLegacyHevc,
  isEnhancedHevc,
};
