/* 塞壬的小把戏 —— 后端：audio.js（音色合成 + 调度）
 *
 * 依据：02-后端开发规格书 D4
 *   · 三种音色：siren（海妖唱旋律）/ cue（提示音，极短极干极中性）/ tick（节拍）
 *     ⚠️ D4.2 明确警告："最常见的错误是用一个音色贯穿全场"，siren 与 cue 必须分开设计
 *   · 三层加法合成：谐波基线 + 失谐堆叠（人声感）+ 共振峰滤波（让"音"变成"人声"）
 *   · 包络：attack 10–20ms，指数衰减，**duration = 时值 − 40ms**（否则连续同音会糊成一个）
 *   · 混响：ConvolverNode + 代码生成 IR（1.6s，噪声 × (1-i/len)^2.8，双声道），干 70/湿 30
 *   · 限幅：总输出串 DynamicsCompressor
 *   · 颤音：5–6Hz，深度 10–20 音分，延迟 150ms 淡入
 *   · 节拍网格：BPM 92 → 四分 652.17ms，八分 326.09ms，全部整数八分格
 *
 * ⚠️ 本文件是唯一允许触碰 AudioContext 的模块；仍不得触碰 DOM 渲染（D0 硬规则 1）。
 *    不打包任何音频文件，全部代码合成。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  // ---------------------------------------------------------------- 常量（D4）

  var HARMONICS = [1, 0, 1 / 9, 0, 1 / 25, 0, 1 / 49];   // ≈三角波，柔和，音乐盒感

  // 失谐堆叠——"人声感"的最大来源
  var DETUNE_CENTS = [-7, 0, 5, 9];
  var DETUNE_GAIN = [0.55, 1.0, 0.65, 0.4];
  var DETUNE_DELAY_MS = [0, 12, 20, 8];                   // 模拟多人不同步

  // 共振峰：海妖角色 F1=500Hz(+6dB,Q=4) 串联 F2=1150Hz(+4dB,Q=6)
  var FORMANT_1 = { freq: 500, q: 4, gainDb: 6 };
  var FORMANT_2 = { freq: 1150, q: 6, gainDb: 4 };

  var ATTACK_S = 0.012;              // 12ms（D4.3 建议 10–20ms）
  var DURATION_GAP_MS = 40;          // ⚠️ D4.3 强制：duration = 时值 − 40ms

  var VIBRATO = { rate: 5.5, depthCents: 15, delayS: 0.15 };

  var IR = { seconds: 1.6, decay: 2.8, highpassHz: 300 };
  var WET = 0.30;                    // ⚠️ 绝不超过 0.40（会模糊音高轮廓）

  var BPM = 92;

  /** 排程提前量：playPhrase 默认比 ctx.currentTime 晚这么久开始出声 */
  var AUDIO_LEAD_S = 0.08;

  // ---------------------------------------------------------------- 状态

  var ctx = null;
  var masterGain = null;
  var limiter = null;
  var dryGain = null;
  var wetGain = null;
  var convolver = null;
  var reverbHighpass = null;
  var noiseBuffer = null;
  var irBuilt = false;
  var muted = false;

  // 音色链缓存：每种音色一条共振峰链（避免每次发声重建 BiquadFilter）
  var chains = {};

  // 活跃声部计数（便于诊断；不做对象池是因为每个音符的生命周期由 stop() 明确结束）
  var activeVoices = 0;
  var scheduledVoices = [];

  // ---------------------------------------------------------------- 上下文（D4.1）

  /**
   * 保证 AudioContext 已创建并处于 running。
   * ⚠️ 必须在用户手势内调用（iOS 关键）。
   */
  function ensureAudio() {
    if (!ctx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('本环境不支持 AudioContext');
      ctx = new Ctor();
      buildOutputChain();
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      // 返回 Promise，但调用方可能不 await；这里不阻塞
      var p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(function () { /* 忽略 */ });
    }
    return ctx;
  }

  /**
   * 保证 AudioContext 已创建**且处于 running**，返回 Promise<ctx>。
   *
   * ⚠️ D4.1 的示例是同步版（创建 + 触发 resume，不等待）。实践中有两个坑：
   *   1. 不等待 resume 就排程播放，此时 currentTime 几乎不动，所有音符时间点挤在一起；
   *   2. 更隐蔽的：调用方各自 new AudioContext，而 playPhrase 读的是**本模块内部**的 ctx，
   *      于是 ctx 为 null → playPhrase 静默 return 0 → "点了没声音"且无任何报错。
   *      所以外部一律走这个函数，不要自己 new。
   */
  function ready() {
    var c;
    try {
      c = ensureAudio();
    } catch (e) {
      return Promise.reject(e);
    }
    if (c.state === 'running') return Promise.resolve(c);
    return c.resume().then(function () {
      if (c.state !== 'running') throw new Error('AudioContext 状态为 ' + c.state + '，请先在页面任意处点一下');
      return c;
    });
  }

  function buildOutputChain() {
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.9;

    // D4.8-3：总输出必须限幅（合唱段落容易爆音）
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    dryGain = ctx.createGain();
    dryGain.gain.value = 1 - WET;
    wetGain = ctx.createGain();
    wetGain.gain.value = WET;

    masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    // 混响支路（IR 延后生成，只在需要时构建一次）
    dryGain.connect(masterGain);
    wetGain.connect(masterGain);
  }

  /** 代码生成脉冲响应（D4.5）——不打包音频文件 */
  function ensureReverb() {
    if (irBuilt || !ctx) return;
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * IR.seconds);
    var ir = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch += 1) {
      var data = ir.getChannelData(ch);
      for (var i = 0; i < len; i += 1) {
        var decay = Math.pow(1 - i / len, IR.decay);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    convolver = ctx.createConvolver();
    convolver.buffer = ir;

    // 混响链上串 highpass @300Hz（否则低频糊成一团）
    var hp = ctx.createBiquadFilter();
    reverbHighpass = hp;
    hp.type = 'highpass';
    hp.frequency.value = IR.highpassHz;

    convolver.connect(hp);
    hp.connect(wetGain);
    irBuilt = true;
  }

  /** 白噪声缓冲（cue 音色用，短促） */
  function ensureNoise() {
    if (noiseBuffer || !ctx) return;
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * 0.05);
    noiseBuffer = ctx.createBuffer(1, len, sr);
    var d = noiseBuffer.getChannelData(0);
    for (var i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
  }

  // ---------------------------------------------------------------- 音色链

  function buildFormantChain(type) {
    var input = ctx.createGain();
    var out = ctx.createGain();

    if (type === 'siren') {
      // 串联两个 peaking 滤波 → 介于 /o/ 与 /a/ 之间的开放元音
      var f1 = ctx.createBiquadFilter();
      f1.type = 'peaking';
      f1.frequency.value = FORMANT_1.freq;
      f1.Q.value = FORMANT_1.q;
      f1.gain.value = FORMANT_1.gainDb;

      var f2 = ctx.createBiquadFilter();
      f2.type = 'peaking';
      f2.frequency.value = FORMANT_2.freq;
      f2.Q.value = FORMANT_2.q;
      f2.gain.value = FORMANT_2.gainDb;

      input.connect(f1);
      f1.connect(f2);
      f2.connect(out);
    } else if (type === 'cue') {
      // 极短极干极中性：只做轻微带通，绝不抢注意力
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 0.9;
      input.connect(bp);
      bp.connect(out);
    } else {
      input.connect(out);
    }
    return { input: input, output: out };
  }

  function chainFor(type) {
    if (!chains[type]) chains[type] = buildFormantChain(type);
    return chains[type];
  }

  /** 分贝 → 线性增益 */
  function dbToGain(db) { return Math.pow(10, db / 20); }

  // ---------------------------------------------------------------- 发声

  /**
   * 播一个音（三种音色共用内核，参数按 D4 分设计）。
   *
   * @param {Object} o
   *   o.type      'siren' | 'cue' | 'tick'
   *   o.freq      基频 Hz
   *   o.startTime AudioContext 时间（秒）
   *   o.durationS 期望发声时长（秒）。内部会按 D4.3 减去 40ms 间隔
   *   o.gain      峰值增益（默认按音色给）
   *   o.detune    是否启用失谐堆叠（siren 用）
   *   o.vibrato   是否启用颤音（siren 用）
   *   o.reverb    是否走混响（siren 用）
   */
  function playTone(o) {
    if (!ctx) return null;
    var type = o.type || 'siren';
    var now = o.startTime !== undefined ? o.startTime : ctx.currentTime;
    var requestedS = Math.max(0.05, o.durationS || 0.3);

    // ⚠️ D4.3：duration = 时值 − 40ms。若不留间隔，连续同音会糊成一个音，
    //    玩家根本不知道要唱两次（《小星星》开头两个 C 就是这种情况）。
    var durationS = Math.max(0.06, requestedS - DURATION_GAP_MS / 1000);

    var peak = o.gain !== undefined ? o.gain
      : (type === 'siren' ? 0.16 : type === 'cue' ? 0.07 : 0.12);

    var chain = chainFor(type);
    var voiceGain = ctx.createGain();
    voiceGain.gain.value = 0;

    // 包络（D4.3）
    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(peak, now + ATTACK_S);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);

    voiceGain.connect(chain.input);

    var oscillators = [];
    var useDetune = o.detune !== undefined ? o.detune : (type === 'siren');
    var gains = useDetune ? DETUNE_GAIN : [1];
    var cents = useDetune ? DETUNE_CENTS : [0];
    var delaysMs = useDetune ? DETUNE_DELAY_MS : [0];

    for (var i = 0; i < gains.length; i += 1) {
      var osc = ctx.createOscillator();
      // 谐波基线用自定义周期波（≈三角波，音乐盒感）
      if (type === 'siren') {
        var real = new Float32Array(HARMONICS.length);
        var imag = new Float32Array(HARMONICS.length);
        for (var h = 0; h < HARMONICS.length; h += 1) imag[h] = HARMONICS[h];
        osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
      } else {
        osc.type = type === 'tick' ? 'square' : 'triangle';
      }

      var f = o.freq * Math.pow(2, cents[i] / 1200);
      osc.frequency.value = f;

      // 颤音（D4.4）：5–6Hz，10–20 音分，延迟 150ms 后淡入
      if (o.vibrato !== false && type === 'siren') {
        var lfo = ctx.createOscillator();
        lfo.frequency.value = VIBRATO.rate;
        var lfoGain = ctx.createGain();
        // 深度换算：音分 → Hz（近似线性，深度很小）
        lfoGain.gain.setValueAtTime(0, now);
        lfoGain.gain.setValueAtTime(0, now + VIBRATO.delayS);
        lfoGain.gain.linearRampToValueAtTime(
          f * (Math.pow(2, VIBRATO.depthCents / 1200) - 1),
          now + VIBRATO.delayS + 0.1
        );
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        lfo.start(now);
        lfo.stop(now + durationS + 0.1);
        oscillators.push(lfo);
      }

      var g = ctx.createGain();
      g.gain.value = gains[i];

      // 各层 8–25ms 延迟，模拟多人不同步
      if (delaysMs[i] > 0) {
        var dly = ctx.createDelay(0.2);
        dly.delayTime.value = delaysMs[i] / 1000;
        osc.connect(dly);
        dly.connect(g);
      } else {
        osc.connect(g);
      }
      g.connect(voiceGain);

      osc.start(now);
      osc.stop(now + durationS + 0.05);
      oscillators.push(osc);
    }

    // 混响路由：siren 走干湿混合，cue / tick 保持极干（D4.2：绝不抢注意力）
    var useReverb = o.reverb !== undefined ? o.reverb : (type === 'siren');
    if (useReverb) {
      ensureReverb();
      chain.output.connect(dryGain);
      if (convolver) chain.output.connect(convolver);
    } else {
      chain.output.connect(masterGain);
    }

    var voice = { oscillators: oscillators, gain: voiceGain, timer: null, stopped: false };
    scheduledVoices.push(voice);
    activeVoices += 1;
    // 排程中的音也要保留，不能在它真正开始之前就丢掉取消句柄。
    voice.timer = global.setTimeout(function () {
      disposeVoice(voice, false);
    }, Math.max(0, now - ctx.currentTime + durationS + 0.2) * 1000);

    return { stopAt: now + durationS + 0.05 };
  }

  // ---------------------------------------------------------------- 节拍网格（D4.6）

  function eighthMs() { return 60000 / BPM / 2; }
  function quarterMs() { return 60000 / BPM; }

  /**
   * 播放一个乐句（notes[] 来自契约 C3：{midi, startMs, durationMs, degree}）
   * @param {Array} notes
   * @param {Object} [opts] opts.when（AudioContext 时间基准）, opts.gain, opts.reverb
   * @returns {number} 乐句本身时长（秒）——**不含排程提前量**
   *
   * ⚠️ 返回值语义必须是「乐句时长」。曾经改成 `lead + 时长`（为了修 lab 听不到声音），
   *    而 game.js 仍按旧语义计算准备时间，凭空多出 140ms。
   *    排程提前量请用 AUDIO_LEAD_S 单独加，不要混进返回值。
   */
  function playPhrase(notes, opts) {
    opts = opts || {};
    if (!ctx || !notes || !notes.length) return 0;
    var base = opts.when !== undefined ? opts.when : ctx.currentTime + AUDIO_LEAD_S;
    var Pitch = Siren.Pitch;
    var totalS = 0;

    for (var i = 0; i < notes.length; i += 1) {
      var n = notes[i];
      var startS = base + n.startMs / 1000;
      var durS = n.durationMs / 1000;
      playTone({
        type: 'siren',
        freq: Pitch.midiToHz(n.midi),
        startTime: startS,
        durationS: durS,
        gain: opts.gain,
        reverb: opts.reverb
      });
      totalS = Math.max(totalS, n.startMs / 1000 + durS);
    }
    return totalS;
  }

  /** 提示音（玩家演唱时的音块提示：极短极干极中性） */
  function cue(midi, when) {
    if (!ctx) return;
    playTone({
      type: 'cue',
      freq: Siren.Pitch.midiToHz(midi),
      startTime: when !== undefined ? when : ctx.currentTime,
      durationS: 0.09,
      detune: false,
      vibrato: false,
      reverb: false
    });
  }

  /** 节拍（兜底模式用，干脆清楚） */
  function tick(when, accent) {
    if (!ctx) return;
    playTone({
      type: 'tick',
      freq: accent ? 1200 : 800,
      startTime: when !== undefined ? when : ctx.currentTime,
      durationS: 0.07,
      gain: accent ? 0.14 : 0.09,
      detune: false,
      vibrato: false,
      reverb: false
    });
  }

  // ---------------------------------------------------------------- 控制

  function setMuted(v) {
    muted = !!v;
    if (masterGain) masterGain.gain.value = muted ? 0 : 0.9;
  }

  function isMuted() { return muted; }

  function disposeVoice(voice, stop) {
    if (voice.stopped) return;
    voice.stopped = true;
    global.clearTimeout(voice.timer);
    for (var i = 0; i < voice.oscillators.length; i += 1) {
      try { if (stop) voice.oscillators[i].stop(); } catch (e) { /* 已结束 */ }
      try { voice.oscillators[i].disconnect(); } catch (e) { /* 已断开 */ }
    }
    try { voice.gain.disconnect(); } catch (e) { /* 已断开 */ }
    scheduledVoices = scheduledVoices.filter(function (v) { return v !== voice; });
    activeVoices = Math.max(0, activeVoices - 1);
  }

  /** 取消当前和未来的音符，同时清除混响尾音；保留已解锁的 AudioContext。 */
  function stopPlayback() {
    var voices = scheduledVoices.slice();
    for (var i = 0; i < voices.length; i += 1) disposeVoice(voices[i], true);
    Object.keys(chains).forEach(function (type) {
      try { chains[type].input.disconnect(); } catch (e) { /* 忽略 */ }
      try { chains[type].output.disconnect(); } catch (e) { /* 忽略 */ }
    });
    chains = {};
    try { if (convolver) convolver.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (reverbHighpass) reverbHighpass.disconnect(); } catch (e) { /* 忽略 */ }
    convolver = null;
    reverbHighpass = null;
    irBuilt = false;
  }

  /** 释放音频资源（回 HOME / 中止时调用） */
  function release() {
    stopPlayback();
  }

  function stats() {
    return {
      ready: !!ctx,
      state: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : 0,
      currentTime: ctx ? ctx.currentTime : 0,
      activeVoices: activeVoices,
      irBuilt: irBuilt,
      muted: muted,
      wet: WET,
      bpm: BPM
    };
  }

  /**
   * 只读访问模块内部的 AudioContext（诊断用；不要用它去 new 节点）。
   * ⚠️ 刻意不叫 getContext —— 那个名字与 canvas.getContext('2d') 同名，
   *    既容易被静态检查误判为渲染调用，也容易让读代码的人混淆。
   */
  function getAudioContext() { return ctx; }

  // ---------------------------------------------------------------- 输入增益归一化

  /**
   * 麦克风输入增益归一化。
   *
   * 为什么需要：实测（试唱台 lab-v7）用户"声音很大、几乎贴着麦克风"，
   * 但进来的峰值只有 0.032 RMS（约 −30 dBFS），正常应为 −12 ~ −6 dBFS，
   * 差 15–20 dB；且 120 帧里 100 帧低于 0.005。这类差距只能来自设备/系统层
   * （其他程序共享麦克风、系统输入级别、笔记本麦增益偏低），**不是用户的问题**。
   *
   * 而 YIN 本身在 0.003 RMS 以上就有 100% 检出率（已离线验证），
   * 所以只要把信号抬进 0.02–0.05 的可用区间即可，不需要高保真。
   *
   * 策略（宁可少放大，不可放大噪声）：
   *   · 只在明显过轻时增益；已经够响就完全不动；
   *   · 增益上限 MAX_GAIN，避免把底噪也抬成"有音高"；
   *   · 保底：若增益后底噪会超过 NOISE_CEILING，按噪声反推更保守的增益；
   *   · 绝不削波。
   */
  var GAIN_CFG = {
    TARGET: 0.035,        // 期望的语音峰值（落在 YIN 的舒适区）
    MAX_GAIN: 8,          // 最多放大 8 倍（约 +18 dB）
    PEAK_CEILING: 0.7,    // 增益后峰值不超过此值，留足余量不削波
    NOISE_CEILING: 0.02   // 增益后底噪不得超过此值（否则噪声会被当成音高）
  };

  /**
   * 由实测峰值与底噪推算安全增益。
   * @param {number} peakRms 校准期测到的语音峰值（RMS）
   * @param {number} noiseRms 环境底噪（RMS）
   * @returns {number} 增益倍数（1 表示不放大）
   */
  function computeInputGain(peakRms, noiseRms) {
    if (!(peakRms > 0)) return 1;
    if (peakRms >= GAIN_CFG.TARGET) return 1;          // 已经够响，不动

    var gain = GAIN_CFG.TARGET / peakRms;              // 按目标推算
    gain = Math.min(gain, GAIN_CFG.PEAK_CEILING / peakRms);   // 不削波
    if (noiseRms > 0) gain = Math.min(gain, GAIN_CFG.NOISE_CEILING / noiseRms); // 不抬噪声
    gain = Math.min(gain, GAIN_CFG.MAX_GAIN);
    return Math.max(1, gain);
  }

  /**
   * 原地施加增益。检测前对时域缓冲乘一个系数即可——
   * 音高检测只看周期结构，线性缩放不改变音高结果，但能把信号抬到置信度门槛之上。
   * @param {Float32Array} buf
   * @param {number} gain
   */
  function applyInputGain(buf, gain) {
    if (!(gain > 1)) return buf;
    for (var i = 0; i < buf.length; i += 1) {
      var v = buf[i] * gain;
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      buf[i] = v;
    }
    return buf;
  }

  Siren.Audio = {
    ensureAudio: ensureAudio,
    ready: ready,
    playPhrase: playPhrase,
    playTone: playTone,
    cue: cue,
    tick: tick,
    setMuted: setMuted,
    isMuted: isMuted,
    stopPlayback: stopPlayback,
    release: release,
    getAudioContext: getAudioContext,
    computeInputGain: computeInputGain,
    applyInputGain: applyInputGain,
    GAIN_CFG: GAIN_CFG,
    stats: stats,
    eighthMs: eighthMs,
    quarterMs: quarterMs,
    BPM: BPM,
    DURATION_GAP_MS: DURATION_GAP_MS,
    AUDIO_LEAD_S: AUDIO_LEAD_S,
    _constants: {
      HARMONICS: HARMONICS, DETUNE_CENTS: DETUNE_CENTS, DETUNE_GAIN: DETUNE_GAIN,
      FORMANT_1: FORMANT_1, FORMANT_2: FORMANT_2, WET: WET, IR: IR, VIBRATO: VIBRATO
    }
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
