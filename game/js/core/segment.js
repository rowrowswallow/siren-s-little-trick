/* 塞壬的小把戏 —— 后端：segment.js（音符切分 + 起音检测）
 *
 * 依据：02-后端开发规格书 D6
 *   · 稳定音判定：连续 ≥ 100ms（2 帧）且 hz 波动 ≤ 60 音分
 *   · 音高取值：该段 hz 的中位数（抗离群点）
 *   · 音符边界：相邻稳定段音高差 ≥ 80 音分 → 新音符；< 80 → 合并
 *   · 碎片丢弃：< 80ms 的丢弃
 *   · 起音时刻：回溯到 RMS 能量上升沿
 *   · 哼唱特殊处理：闭口哼唱无辅音起音、能量上升缓慢（50–150ms），
 *     判定阈值改为"达到稳定能量的 60%"，不做任何惩罚
 *
 * 本文件不触碰 document / window 渲染（D0 硬规则 1）。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};
  var Pitch = Siren.Pitch;

  // ---------------------------------------------------------------- 参数（D6）

  var CFG = {
    STABLE_MIN_MS: 100,        // 稳定音最短持续
    STABLE_MIN_FRAMES: 2,      // 至少 2 帧
    STABLE_MAX_CENTS_SWING: 60,// 段内 hz 波动上限（音分）
    BOUNDARY_CENTS: 80,        // 相邻段音高差 ≥ 此值 → 新音符
    FRAGMENT_MIN_MS: 80,       // 短于此的碎片丢弃
    SILENCE_RMS_FACTOR: 1.8,   // RMS 低于噪音基线 × 此值视为静默
    // ⚠️ 补丁：静默阈值的**相对上限**。噪音基线是录音前 500ms 估出来的一个数，
    //    估高了就会把整句真实演唱全判成静默——手机 / 平板上尤其容易，
    //    扬声器串音、空调开停、有人说话都会抬高它，而玩家侧的表现是
    //    "我唱满全场却一个音都没切出来、0 分"。这里补一条只看本句自身的判据：
    //    阈值不得高于本句实测峰值的此比例。它与基线判据取 min，
    //    **只会让阈值变低、绝不会变高**，所以不可能把原本能切出的音切没。
    SILENCE_PEAK_RATIO: 0.2,
    ONSET_RATIO: 0.6,          // 达到稳定能量的 60% 即认作起音（D6 哼唱处理）
    // ⚠️ 补丁（D6 原文缺失）：合并的**时间判据**。
    //    D6 只写了"音高差 < 80 音分 → 合并"，没考虑两段之间是否隔着静音。
    //    后果：连续同音（《小星星》开头的两个 C）会被静音切成两段后**又并回一个音**，
    //    实测端到端只能切出 4/7 个音，完整度与音型轮廓双双受损。
    //    合并的本意是抗"同一音内的抖动"，而静音是明确的换音信号，不应跨越。
    MERGE_MAX_GAP_MS: 25       // 两段间隔超过此值即不合并（小于半帧，避免误伤抖动）
  };

  // ---------------------------------------------------------------- 工具

  /** 该段 hz 的中位数（D6：取值用中位数抗离群点） */
  function medianHz(frames) {
    var arr = [];
    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].hz > 0) arr.push(frames[i].hz);
    }
    if (!arr.length) return 0;
    arr.sort(function (a, b) { return a - b; });
    var mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  /** 段内 hz 波动（音分）：最大最小相对中位数的偏移 */
  function swingCents(frames, medHz) {
    if (!(medHz > 0)) return Infinity;
    var maxAbs = 0;
    for (var i = 0; i < frames.length; i += 1) {
      if (!(frames[i].hz > 0)) continue;
      var c = Math.abs(Pitch.centsBetween(frames[i].hz, medHz));
      if (c > maxAbs) maxAbs = c;
    }
    return maxAbs;
  }

  /**
   * 从能量序列回溯起音时刻（D6：回溯到 RMS 能量上升沿）
   * @param {Array} frames 该音符覆盖的帧（含 t / rms）
   * @param {number} stableRms 该音符稳定段的 RMS 中位数
   * @returns {number} 起音时刻（ms）
   */
  function findOnset(frames, stableRms) {
    if (!frames.length) return 0;
    var threshold = stableRms * CFG.ONSET_RATIO;
    // 从稳定段起点向前回溯，找能量首次超过阈值的帧
    var onset = frames[0].t;
    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].rms >= threshold) { onset = frames[i].t; break; }
    }
    return onset;
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * 把逐帧音高序列切成音符序列。
   *
   * @param {Array<{t:number, hz:number, conf:number, rms:number}>} frames
   *        按时间升序的帧。t 单位 ms；hz=0 表示该帧无音高。
   * @param {Object} [opts]
   *        opts.noiseFloor 环境噪音基线 RMS（用于静默判定）
   *        opts.frameIntervalMs 帧间隔（默认按 t 差推断）
   * @returns {{notes:Array, stats:Object}}
   *        notes: [{ startMs, endMs, durationMs, hz, midi, rms, onsetMs }]
   */
  function segment(frames, opts) {
    opts = opts || {};
    var noiseFloor = opts.noiseFloor || 0;
    var silenceRms = noiseFloor * CFG.SILENCE_RMS_FACTOR;

    var notes = [];
    var i = 0;
    var n = frames.length;

    // 基线估高的兜底：再看一眼本句自己的峰值（见 CFG.SILENCE_PEAK_RATIO 的说明）。
    if (silenceRms > 0) {
      var framePeak = 0;
      for (var p = 0; p < n; p += 1) {
        if (frames[p].rms > framePeak) framePeak = frames[p].rms;
      }
      if (framePeak > 0) silenceRms = Math.min(silenceRms, framePeak * CFG.SILENCE_PEAK_RATIO);
    }

    while (i < n) {
      // 跳过无音高 / 静默帧
      if (!(frames[i].hz > 0) || frames[i].rms < silenceRms) { i += 1; continue; }

      // 以当前帧为种子，向后扩展"音高相近"的连续帧
      var run = [frames[i]];
      var j = i + 1;
      while (j < n) {
        var f = frames[j];
        if (!(f.hz > 0) || f.rms < silenceRms) break;
        var med = medianHz(run);
        if (Math.abs(Pitch.centsBetween(f.hz, med)) > CFG.BOUNDARY_CENTS) break;
        run.push(f);
        j += 1;
      }

      var medHz = medianHz(run);
      var swing = swingCents(run, medHz);
      var spanMs = run[run.length - 1].t - run[0].t;

      // 稳定性判定：时长 + 帧数 + 段内波动
      var stable = spanMs >= CFG.STABLE_MIN_MS - 1e-6
        && run.length >= CFG.STABLE_MIN_FRAMES
        && swing <= CFG.STABLE_MAX_CENTS_SWING;

      if (stable) {
        var rmsArr = run.map(function (x) { return x.rms; }).sort(function (a, b) { return a - b; });
        var stableRms = rmsArr[Math.floor(rmsArr.length / 2)];
        notes.push({
          startMs: run[0].t,
          endMs: run[run.length - 1].t,
          durationMs: spanMs,
          hz: medHz,
          midi: Pitch.hzToMidi(medHz),
          rms: stableRms,
          onsetMs: findOnset(frames.slice(Math.max(0, i - 6), j), stableRms),
          swingCents: swing
        });
      }

      i = j;
    }

    // 合并相邻同音（D6：相邻稳定段音高差 < 80 音分 → 合并）
    //   ⚠️ 必须同时满足时间连续：若两段之间隔着静音（间隔 > MERGE_MAX_GAP_MS），
    //      说明那是两次独立的发音（连续同音），不能合并。见 CFG 处的说明。
    var merged = [];
    for (var k = 0; k < notes.length; k += 1) {
      var cur = notes[k];
      var prev = merged.length ? merged[merged.length - 1] : null;
      var gapMs = prev ? (cur.startMs - prev.endMs) : Infinity;
      var pitchClose = prev && Math.abs(Pitch.centsBetween(cur.hz, prev.hz)) < CFG.BOUNDARY_CENTS;
      var timeContinuous = gapMs <= CFG.MERGE_MAX_GAP_MS;

      if (prev && pitchClose && timeContinuous) {
        // 合并：时长相加，音高取两段按时间加权的中位数
        var totalDur = prev.durationMs + cur.durationMs;
        var wPrev = totalDur > 0 ? prev.durationMs / totalDur : 0.5;
        var mergedHz = prev.hz * wPrev + cur.hz * (1 - wPrev);
        prev.endMs = cur.endMs;
        prev.durationMs = prev.endMs - prev.startMs;
        prev.hz = mergedHz;
        prev.midi = Pitch.hzToMidi(mergedHz);
      } else {
        merged.push(cur);
      }
    }

    // 丢弃碎片（D6：< 80ms 丢弃）
    var finalNotes = merged.filter(function (x) { return x.durationMs >= CFG.FRAGMENT_MIN_MS; });

    return {
      notes: finalNotes,
      stats: {
        rawNotes: notes.length,
        mergedNotes: merged.length,
        keptNotes: finalNotes.length,
        droppedFragments: merged.length - finalNotes.length,
        silenceRms: silenceRms
      }
    };
  }

  function config() { return JSON.parse(JSON.stringify(CFG)); }

  Siren.Segment = {
    segment: segment,
    medianHz: medianHz,
    swingCents: swingCents,
    findOnset: findOnset,
    config: config
  };
})(typeof window !== 'undefined' ? window : globalThis);
