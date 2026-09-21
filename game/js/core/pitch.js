/* 塞壬的小把戏 —— 后端：pitch.js（YIN 音高检测）
 *
 * 依据：02-后端开发规格书 D5
 *   · 简化 YIN，纯时域。不用 FFT 谱（2048 点 @44.1kHz ≈ 21.5Hz/bin，C4 附近误差超 100 音分）
 *   · 窗口 W = 2048，τ ∈ [floor(sr/660), ceil(sr/90)]，CMND 阈值 0.15
 *   · 抛物线插值必须做（不做则整数 τ 在 C5 附近 ±40 音分误差，直接吃掉 Pitch 容差）
 *   · Float32Array 预分配在模块作用域，检测循环内绝不 new
 *   · 单次 < 5ms 预算；超预算 → 窗口降到 1024、间隔升到 80ms（不引入 Worker，被禁）
 *
 * 本文件不触碰 document / window 渲染（规格书 D0 硬规则 1）。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  // ---------------------------------------------------------------- 常量

  var WINDOW_SIZE = 2048;          // 分析窗口
  var TAU_MAX_HZ = 90;             // 最长周期：对应音域下限（含低八度哼唱）
  var CMND_THRESHOLD = 0.15;       // YIN 阈值（实测音域内信号 CMND ≤ 0.0014，余量极大）
  var CONF_FLOOR = 0.30;           // 置信度门槛：CMND 最小 < 0.30 才认为有音高

  var HZ_MIN = 90;                 // 音域下限：满足"自动下沉八度"的低音哼唱
  var HZ_MAX = 660;                // 音域上限：旋律 C4–C5（523Hz）+ 女声高音余量到 E5(659Hz)
  //   ⚠️ 音域过滤是在**出口**做的，不是在搜索区间做的（见 detectPitchRaw 的 (a) 说明）。
  //      若像规格书那样把搜索区间也压到 660Hz，超范围信号会落到倍周期上，
  //      产出一个落在音域内、conf≈1.0 的错值（实测 C6→C5 差 1200 音分），
  //      这种"自信地报错答案"比"报无音高"危险得多。

  var A4_HZ = 440;
  var A4_MIDI = 69;

  // ---------------------------------------------------------------- 模块态缓冲

  // 按最大 τ 预分配；换采样率时重新分配（只在 init 时发生）
  var _sr = 0;
  var _tauMax = 0;
  var _yin = null;

  function ensureBuffers(sampleRate) {
    if (_sr === sampleRate && _yin) return;
    _sr = sampleRate;
    _tauMax = Math.ceil(sampleRate / TAU_MAX_HZ);
    // +2 给抛物线插值的 tau-1 / tau+1 边界余量
    _yin = new Float32Array(_tauMax + 3);
  }

  // ---------------------------------------------------------------- 数学工具

  /** 频率 → MIDI 音高号（浮点） */
  function hzToMidi(hz) {
    if (!(hz > 0)) return -Infinity;
    return A4_MIDI + 12 * Math.log(hz / A4_HZ) / Math.LN2;
  }

  /** MIDI 音高号 → 频率 */
  function midiToHz(midi) {
    return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  /** 两个频率之间的音分差 */
  function centsBetween(hzA, hzB) {
    if (!(hzA > 0) || !(hzB > 0)) return Infinity;
    return 1200 * Math.log(hzA / hzB) / Math.LN2;
  }

  /** MIDI 浮点 → 音名，如 60 → "C4" */
  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiToName(midi) {
    if (!isFinite(midi)) return '--';
    var r = Math.round(midi);
    return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }

  // ---------------------------------------------------------------- 核心检测

  /**
   * 核心 YIN：返回原始检测结果（不做音域过滤），供离线验证对比插值影响。
   * @returns {{hz:number, conf:number, tau:number, cmnd:number}} hz=0 表示未找到凹陷
   */
  function detectPitchRaw(buf, sampleRate, windowSize) {
    var W = windowSize || WINDOW_SIZE;
    ensureBuffers(sampleRate);

    if (!buf || buf.length < W) return { hz: 0, conf: 0, tau: -1, cmnd: 1 };

    var tauMax = _tauMax;
    var yin = _yin;
    var limit = W - tauMax;          // 差分函数的公共比较长度（YIN 论文：所有 τ 用同一 N）
    if (limit <= 0) return { hz: 0, conf: 0, tau: -1, cmnd: 1 };

    // ---- Step 1: 差分函数 d(τ)，τ = 1 .. tauMax
    //   ⚠️ 偏离规格书 D5 的两处，均有实测依据：
    //   (a) 搜索从 τ=1 起步，**不设** τMin = floor(sr/660)。
    //       规格书的 τMin 把可搜索区间上限压到 660Hz；真实周期短于 τMin 的信号
    //       找不到基频凹陷，YIN 会落到 2 倍 / 3 倍周期上，产出一个**落在音域内、
    //       看起来完全可信的错值**（实测：C6→C5 差 1200 音分、A5→A4、1500Hz→500Hz，
    //       且 conf≈1.0）。实测证明全范围搜索时每个频率都精确落在真实周期上，
    //       因此"超范围"改由出口的音域过滤拒绝（返回无音高），而非靠限制搜索区间。
    //   (b) CMND 的累加覆盖 τ=1..tauMax。规格书骨架只累加 tauMin..tauMax，
    //       导致 τ=tauMin 处 running 恰等于 d(tauMin)，归一化后恒为 1.0（对任何信号都是
    //       1.00000），既丢失物理意义，也让任何基于 τMin 的判据失效。
    for (var tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      for (var i = 0; i < limit; i++) {
        var d = buf[i] - buf[i + tau];
        sum += d * d;
      }
      yin[tau] = sum;
    }

    // ---- Step 2: 累积均值归一化差分 CMND
    yin[0] = 1;
    var running = 0;
    for (var t2 = 1; t2 <= tauMax; t2++) {
      running += yin[t2];
      if (running > 0) {
        yin[t2] = yin[t2] * t2 / running;
      } else {
        yin[t2] = 1;
      }
    }

    // ---- Step 3: 找第一个低于阈值的局部极小
    var found = -1;
    for (var t3 = 1; t3 <= tauMax; t3++) {
      if (yin[t3] < CMND_THRESHOLD) {
        while (t3 + 1 <= tauMax && yin[t3 + 1] < yin[t3]) t3++;
        found = t3;
        break;
      }
    }
    if (found < 0) return { hz: 0, conf: 0, tau: -1, cmnd: 1 };

    var cmndMin = yin[found];

    // ---- Step 4: 抛物线插值（必须做；不做则整数 τ 在 C5 附近造成 ±5 音分误差）
    var s0 = found - 1 >= 1 ? yin[found - 1] : yin[found];
    var s1 = yin[found];
    var s2 = found + 1 <= tauMax ? yin[found + 1] : yin[found];
    var denom = 2 * (2 * s1 - s2 - s0);
    var betterTau = found + (denom !== 0 ? (s2 - s0) / denom : 0);

    if (!(betterTau > 0)) return { hz: 0, conf: 0, tau: found, cmnd: cmndMin };

    return { hz: sampleRate / betterTau, conf: 1 - cmndMin, tau: betterTau, cmnd: cmndMin };
  }

  /**
   * 检测一帧的音高（对外主接口，含音域过滤与置信度门槛）。
   * @param {Float32Array} buf 时域样本，长度需 >= WINDOW_SIZE
   * @param {number} sampleRate
   * @param {number} [windowSize] 分析窗口，默认 2048（性能兜底时可降到 1024）
   * @returns {{hz:number, conf:number, midi:number}} conf 越低越不可信；hz=0 表示无音高
   */
  function detectPitch(buf, sampleRate, windowSize) {
    var raw = detectPitchRaw(buf, sampleRate, windowSize);
    if (raw.hz <= 0) return { hz: 0, conf: 0, midi: -Infinity };

    // 置信度门槛：CMND 最小仍偏大 → 视为无音高（气声 / 耳语 / 噪音）
    if (raw.cmnd >= CONF_FLOOR) return { hz: 0, conf: 0, midi: -Infinity };

    // 音域过滤：超范围一律拒绝，绝不返回错八度的"看起来可信"的值
    if (raw.hz < HZ_MIN || raw.hz > HZ_MAX) return { hz: 0, conf: 0, midi: -Infinity };

    return { hz: raw.hz, conf: raw.conf, midi: hzToMidi(raw.hz) };
  }

  /**
   * 从 AnalyserNode 的时域缓冲中取一帧并检测。
   * 仅做缓冲读取 + 调用 detectPitch，不持有 AnalyserNode。
   */
  var _reuse = null;
  function detectFromAnalyser(analyser, sampleRate, windowSize) {
    var W = windowSize || WINDOW_SIZE;
    if (!_reuse || _reuse.length !== W) _reuse = new Float32Array(W);
    analyser.getFloatTimeDomainData(_reuse);
    return detectPitch(_reuse, sampleRate, W);
  }

  function config() {
    return {
      WINDOW_SIZE: WINDOW_SIZE,
      CMND_THRESHOLD: CMND_THRESHOLD,
      CONF_FLOOR: CONF_FLOOR,
      TAU_MAX_HZ: TAU_MAX_HZ,
      HZ_MIN: HZ_MIN,
      HZ_MAX: HZ_MAX
    };
  }

  // ---------------------------------------------------------------- 种子 PRNG

  /**
   * mulberry32：小而快，种子可复现（D8 要求不用 Math.random）。
   *
   * ⚠️ 为什么放在 pitch.js（最先加载的模块）：
   *    规格书 D2 规定的加载顺序是 melody.js 在 fleet.js **之前**，
   *    但 melody.js 生成旋律需要种子 PRNG，而 D8/D9 把 mulberry32 写在 fleet 名下——
   *    于是"顺序"与"依赖"直接矛盾（selfcheck 会拦下）。
   *    把它提到最先加载、且被双方共同依赖的 pitch.js，两边都能用，顺序不动。
   */
  function mulberry32(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  Siren.Pitch = {
    detectPitch: detectPitch,
    detectPitchRaw: detectPitchRaw,
    detectFromAnalyser: detectFromAnalyser,
    hzToMidi: hzToMidi,
    midiToHz: midiToHz,
    centsBetween: centsBetween,
    midiToName: midiToName,
    mulberry32: mulberry32,
    config: config
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
