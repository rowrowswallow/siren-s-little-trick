#!/usr/bin/env node
/**
 * game.js / audio.js / index.js 集成验证（契约 C1–C4 + D3/D10/D11）
 *
 * 做法：按 D2 顺序加载全部 10 个模块，用桩替换 AudioContext / getUserMedia，
 * 驱动一整局，检查状态机与事件广播是否完全符合契约。
 *
 * 覆盖：
 *   · init() → Promise<StateSnapshot>，快照字段与契约 C2 一致
 *   · start() → 授权成功走 LEARN_LOOP，拒绝走 RHYTHM_FALLBACK（D3/D10）
 *   · 5 乐句音数 3/4/5/6/7，每波 20 条船，累计 100 条（D13）
 *   · ship:in 载荷含 id/lane/depth/side/entryDelayMs（契约 C3）
 *   · ship:wrecked 载荷含 id/pull
 *   · attempt:pitch 每 50ms 一次，载荷含 t/midi/cents/conf/voiced（契约 C3 + D11）
 *   · attempt:end reason 属于 done|silence|timeout（契约 C3）
 *   · 静默 3s 中止不广播任何文案（D3）
 *   · game:finale 含 wreckedTotal/ending/seed，ending 属于 A|B|C|D
 *   · notice/error 只给技术码，无中文（契约 C4）
 *   · 音频常量：duration = 时值 − 40ms、湿声 ≤ 0.40、BPM 92 网格（D4）
 *
 * 用法：node tools/test-integration.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------- D2 加载顺序

const LOAD_ORDER = [
  'game/data/melodies.js',
  'game/js/core/store.js',
  'game/js/core/pitch.js',
  'game/js/core/segment.js',
  'game/js/core/score.js',
  'game/js/core/audio.js',
  'game/js/core/melody.js',
  'game/js/core/fleet.js',
  'game/js/core/game.js',
  'game/js/core/index.js',
];

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  OK   ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? '  — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};

// ---------------------------------------------------------------- 虚拟时钟

/**
 * 虚拟时钟：把 setTimeout 变成可控推进，避免真等一整局。
 * 必须异步推进：game.js 的流程串在 Promise 上（getUserMedia / init），
 * 同步 while 循环会把 microtask 饿死，流程会卡在第一个 then 之后。
 */
function makeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  const yieldLoop = () => new Promise((r) => setImmediate(r));
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = seq++;
      timers.set(id, { at: now + Math.max(0, ms || 0), fn, interval: null });
      return id;
    },
    setInterval(fn, ms) {
      const id = seq++;
      timers.set(id, { at: now + Math.max(1, ms || 1), fn, interval: Math.max(1, ms || 1) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    async advanceTo(targetMs, maxSteps = 400000) {
      let steps = 0;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= targetMs && (next === null || t.at < next.t.at)) next = { id, t };
        }
        if (!next) break;
        if (++steps > maxSteps) throw new Error('虚拟时钟步数超限，可能有定时器自激');
        now = next.t.at;
        if (next.t.interval === null) timers.delete(next.id);
        else next.t.at = now + next.t.interval;
        try { next.t.fn(); } catch (e) { throw new Error(`定时器回调抛错 @${now}ms: ${e.message}`); }
        if (steps % 20 === 0) await yieldLoop();
      }
      now = targetMs;
      await yieldLoop();
    },
    pending: () => timers.size,
  };
}

// ---------------------------------------------------------------- 音频桩

function makeAudioStub() {
  function param(value = 0) {
    const p = {
      value,
      setValueAtTime(v) { p.value = v; return p; },
      linearRampToValueAtTime(v) { p.value = v; return p; },
      exponentialRampToValueAtTime(v) { p.value = v; return p; },
      cancelScheduledValues() { return p; },
    };
    return p;
  }
  function node(extra = {}) {
    return Object.assign({
      connect() { return this; },
      disconnect() { return this; },
    }, extra);
  }
  const created = { oscillators: 0, gains: 0, biquads: 0, convolvers: 0, buffers: 0, started: 0, stopped: 0 };

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = node();
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { created.gains += 1; return node({ gain: param(1) }); }
    createOscillator() {
      created.oscillators += 1;
      return node({
        type: 'sine',
        frequency: param(440),
        detune: param(0),
        start() { created.started += 1; },
        stop() { created.stopped += 1; },
        setPeriodicWave() {},
      });
    }
    createBiquadFilter() {
      created.biquads += 1;
      return node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) });
    }
    createDelay() { return node({ delayTime: param(0) }); }
    createConvolver() { created.convolvers += 1; return node({ buffer: null }); }
    createDynamicsCompressor() {
      return node({
        threshold: param(-24), knee: param(30), ratio: param(12),
        attack: param(0.003), release: param(0.25), reduction: 0,
      });
    }
    createPeriodicWave() { return {}; }
    createBuffer(channels, length) {
      created.buffers += 1;
      const data = [];
      for (let i = 0; i < channels; i += 1) data.push(new Float32Array(length));
      return {
        numberOfChannels: channels, length, sampleRate: 48000,
        getChannelData: (c) => data[c],
      };
    }
    createMediaStreamSource() { return node(); }
    createAnalyser() {
      return node({
        fftSize: 2048,
        smoothingTimeConstant: 0,
        frequencyBinCount: 1024,
        getFloatTimeDomainData(arr) { arr.fill(0); },
      });
    }
  }
  return { FakeAudioContext, created };
}

/**
 * 造一个"像人一样演唱"的麦克风。
 *
 * 两个关键真实性要求（第一版桩都错了，直接把分数打到 0）：
 *   1. 乐句唱完就闭嘴——一直拖到 6 秒上限会被判成"多唱"
 *   2. 每个音都重新起音，且音高不是分毫不差——真人不会在两个连续同音
 *      （如《小星星》开头的两个 C）之间给出完全连续的波形。
 *      若不给音高微扰，切分器会把两个同音合并成一个，乐句对齐直接崩。
 */
function makeMicStub(Pitch, clock) {
  const state = { notes: null, lastEndMs: 0, hz: 0, startedAt: 0, phase: 0, silent: false, lastIdx: -1, amp: 0.4 };
  return {
    state,
    setNotes(notes) {
      state.notes = notes;
      state.startedAt = clock.now();
      state.lastIdx = -1;
      state.lastEndMs = notes.reduce((m, n) => Math.max(m, n.startMs + n.durationMs), 0);
      if (state.trace) state.trace.length = 0;   // 只保留最近一句的轨迹
    },
    setSilent(v) { state.silent = !!v; },
    fill(arr, sampleRate) {
      let idx = -1;
      const t = clock.now() - state.startedAt;
      if (!state.silent && state.notes && state.notes.length && t <= state.lastEndMs) {
        for (let i = state.notes.length - 1; i >= 0; i -= 1) {
          if (t >= state.notes[i].startMs) { idx = i; break; }
        }
      }
      if (idx < 0) { state.hz = 0; arr.fill(0); return; }

      // 音高微扰：第 i 个音固定偏移 ±1.2%，既不改变音名又让段边界可被检出
      const detune = 1 + (((idx * 37) % 5) - 2) * 0.006;
      const hz = Pitch.midiToHz(state.notes[idx].midi) * detune;

      // 换音时重置相位，模拟重新起音
      if (idx !== state.lastIdx) { state.phase = 0; state.lastIdx = idx; }
      state.hz = hz;
      if (state.trace) {
        state.trace.push({
          t: Math.round(t), idx, midi: state.notes[idx].midi,
          hz: +hz.toFixed(2), rms: state.amp / Math.SQRT2,
        });
      }
      for (let i = 0; i < arr.length; i += 1) {
        arr[i] = state.amp * Math.sin(2 * Math.PI * hz * (state.phase + i) / sampleRate);
      }
      state.phase += arr.length;
    },
  };
}

// ---------------------------------------------------------------- 环境装配

const clock = makeClock();
const audioStub = makeAudioStub();
const storeMap = new Map();

let tapHandler = null;
const documentStub = {
  addEventListener(type, fn) { if (type === 'pointerdown') tapHandler = fn; },
  removeEventListener(type) { if (type === 'pointerdown') tapHandler = null; },
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {} }),
  body: { appendChild() {} },
};

const win = {
  AudioContext: audioStub.FakeAudioContext,
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
  setInterval: clock.setInterval,
  clearInterval: clock.clearInterval,
  localStorage: {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k),
    clear: () => storeMap.clear(),
  },
  document: documentStub,
  navigator: { userAgent: 'integration-test' },
  console: { log() {}, warn() {}, error() {} },
  // game.js 用 performance.now() 做单调计时（避免设备改时间）。
  // 测试里必须把它接到虚拟时钟，否则它读真实挂钟，
  // 而虚拟时钟推进远快于真实时间，静默/超时判定会永远不触发。
  performance: { now: () => clock.now() },
};
win.window = win;
win.globalThis = win;

let micMode = 'grant';
let micStub = null;

const sources = LOAD_ORDER.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'));
for (let i = 0; i < sources.length; i += 1) {
  new Function('window', 'globalThis', 'document', 'navigator', 'localStorage',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
    sources[i])(
    win, win, documentStub, win.navigator, win.localStorage,
    clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, win.console,
  );
  if (LOAD_ORDER[i].endsWith('pitch.js')) micStub = makeMicStub(win.Siren.Pitch, clock);
}
micStub.state.trace = [];

const Siren = win.Siren;

// 诊断钩子：包住 Segment.segment，记录每句切分出的音符（仅测试用，不改产品代码）
const segLog = [];
const _origSegment = Siren.Segment.segment;
Siren.Segment.segment = function (frames, opts) {
  const out = _origSegment.call(this, frames, opts);
  segLog.push({
    frames: frames.length,
    voicedFrames: frames.filter((f) => f.hz > 0).length,
    notes: out.notes.map((n) => ({ midi: n.midi, start: Math.round(n.startMs), dur: Math.round(n.durationMs) })),
    stats: out.stats,
  });
  return out;
};

win.navigator.mediaDevices = {
  getUserMedia() {
    if (micMode === 'deny') {
      const e = new Error('Permission denied');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    }
    return Promise.resolve({ getTracks: () => [{ stop() {} }] });
  },
};

// analyser 返回 micStub 的样本
const originalCreateAnalyser = audioStub.FakeAudioContext.prototype.createAnalyser;
audioStub.FakeAudioContext.prototype.createAnalyser = function () {
  const a = originalCreateAnalyser.call(this);
  a.getFloatTimeDomainData = (arr) => micStub.fill(arr, this.sampleRate);
  return a;
};

// ---------------------------------------------------------------- 事件采集

// 录音期间后端会播 cue 提示音（D4.2）。桩没有音频分离能力，
// 若让 cue 真的走 AudioContext，喂给音高检测的缓冲里会混进 cue 的音，
// 测出来全是错值（第一版就踩到了：目标 m60 被测成 325Hz）。
// 这里把 cue 静音化，让测试专注验证「状态机 + 切分 + 打分 + 船队」这条链。
// 真机上麦克风确实会收到 cue 声，靠的是 cue 极短极干（D4.2 的设计目标）。
Siren.Audio.cue = function () {};

const events = [];
const EVENT_TYPES = [
  'state:change', 'melody:phraseStart', 'melody:titleReveal', 'attempt:countdown',
  'attempt:start', 'attempt:pitch', 'attempt:note', 'attempt:end', 'ship:in', 'ship:wrecked',
  'phrase:result', 'game:finale', 'melody:replay', 'player:replay', 'notice', 'error',
];
for (const t of EVENT_TYPES) Siren.on(t, (payload) => events.push({ type: t, payload, at: clock.now() }));
const ofType = (t) => events.filter((e) => e.type === t);

// ================================================================ 1

console.log('集成验证（契约 C1-C4 + D3/D10/D11）');
console.log('');
console.log('[1] 模块加载与契约表面');
const MODULE_NAMES = {
  store: 'Store', pitch: 'Pitch', segment: 'Segment', score: 'Score',
  audio: 'Audio', melody: 'Melody', fleet: 'Fleet', game: 'Game',
};
const loadedOk = LOAD_ORDER.every((rel) => {
  const base = path.basename(rel, '.js');
  if (base === 'melodies' || base === 'index') return true;
  return !!Siren[MODULE_NAMES[base]];
});
check('10 个模块按 D2 顺序全部加载', loadedOk, LOAD_ORDER.length + ' 个文件');

const CONTRACT_API = ['init', 'start', 'replayPhrase', 'abort', 'on', 'off', 'getState'];
const missingApi = CONTRACT_API.filter((k) => typeof Siren[k] !== 'function');
check('契约 C1 的 8 个成员齐备', missingApi.length === 0,
  missingApi.length ? '缺 ' + missingApi.join(', ') : CONTRACT_API.concat(['version']).join(', '));
check('version === "1.1.0"（契约 C1，v1.1.0 起含 TUTORIAL/skipTutorial）',
  Siren.version === '1.1.0', String(Siren.version));
check('window.Siren 上未暴露内部诊断接口（P4 收窄）',
  !Siren._scoreAttempt && !Siren._scoreAttemptVerbose,
  '顶层可调用成员：' + CONTRACT_API.join(', '));

// ================================================================ 2

console.log('');
console.log('[2] 音频常量（D4）');
const A = Siren.Audio;
check('duration = 时值 - 40ms（D4.3 强制）', A.DURATION_GAP_MS === 40, A.DURATION_GAP_MS + 'ms');
check('湿声比例 <= 0.40（D4.5 硬上限）', A._constants.WET <= 0.40, 'WET=' + A._constants.WET);
check('BPM 92 -> 八分 326.09ms（D4.6）', Math.abs(A.eighthMs() - 326.0869565217391) < 1e-9, A.eighthMs().toFixed(4) + 'ms');
check('BPM 92 -> 四分 652.17ms', Math.abs(A.quarterMs() - 652.1739130434783) < 1e-9, A.quarterMs().toFixed(4) + 'ms');
check('siren 与 cue 音色分开设计（D4.2 最常见错误）',
  A._constants.HARMONICS.length === 7 && A._constants.DETUNE_CENTS.length === 4,
  '谐波 ' + A._constants.HARMONICS.length + ' 项，失谐堆叠 ' + A._constants.DETUNE_CENTS.length + ' 层');
check('共振峰 F1=500/F2=1150（D4.2）',
  A._constants.FORMANT_1.freq === 500 && A._constants.FORMANT_2.freq === 1150,
  'F1=' + A._constants.FORMANT_1.freq + ' F2=' + A._constants.FORMANT_2.freq);
check('颤音 5-6Hz，深度 10-20 音分，延迟 150ms（D4.4）',
  A._constants.VIBRATO.rate >= 5 && A._constants.VIBRATO.rate <= 6 &&
  A._constants.VIBRATO.depthCents >= 10 && A._constants.VIBRATO.depthCents <= 20 &&
  A._constants.VIBRATO.delayS === 0.15,
  A._constants.VIBRATO.rate + 'Hz / ' + A._constants.VIBRATO.depthCents + '音分 / 延迟 ' + A._constants.VIBRATO.delayS + 's');
check('混响 IR 1.6s（D4.5）', A._constants.IR.seconds === 1.6, A._constants.IR.seconds + 's');

// ================================================================ 3

console.log('');
console.log('[3] init() 与状态快照（契约 C1/C2）');
const initState = await Siren.init({ seed: 4821 });
check('init 返回 Promise 且解析为状态快照', !!initState && typeof initState === 'object');
const C2_FIELDS = ['phase', 'phraseIndex', 'totalPhrases', 'subPhase', 'shipsTotal', 'shipsSpawned', 'shipsWrecked', 'seed'];
check('快照含契约 C2 全部字段', C2_FIELDS.every((k) => k in initState), Object.keys(initState).join(', '));
check('初始 phase = HOME', initState.phase === 'HOME', initState.phase);
check('totalPhrases = 5（D9.1）', initState.totalPhrases === 5, String(initState.totalPhrases));
check('shipsTotal = 100（D9.1 固定分母）', initState.shipsTotal === 100, String(initState.shipsTotal));
check('seed 按传入值固定（可复现）', initState.seed === 4821, String(initState.seed));

// ================================================================ 4

console.log('');
console.log('[4] 完整一局（授权成功 -> LEARN_LOOP -> FINALE）');
let recordedPhrases = 0;
Siren.on('attempt:start', () => {
  const last = ofType('melody:phraseStart').slice(-1)[0];
  if (last) micStub.setNotes(last.payload.notes);
  micStub.setSilent(false);
  recordedPhrases += 1;
});

await Siren.init({ seed: 4821 });
segLog.length = 0;             // 只看 test 4 这一次运行
// 标记引导关已完成：本节测的是**正片**的 5 乐句流程。
// 引导关本身在【4b】小节单独测（它会产生额外的录音与船队，会污染这里的计数）。
storeMap.set('siren.tutorialDone', '1');
Siren.start();
await Promise.resolve();
await Promise.resolve();
await clock.advanceTo(clock.now() + 50);

let guard = 0;
// ⚠️ 必须按 50ms 粒度推进：游戏内部的音高循环是 50ms 一拍，
//    若一次推进 250ms，一批 tick 会全部读到同一个 clock.now()，
//    测试桩会以为时间没走而一直发同一个音，测出来的分数完全失真。
while (Siren.getState().phase !== 'RESULT' && Siren.getState().phase !== 'SHARE_CARD') {
  await clock.advanceTo(clock.now() + 50);
  if (++guard > 12000) break;
}

const finalState = Siren.getState();
check('流程走到终局（RESULT / SHARE_CARD）',
  finalState.phase === 'RESULT' || finalState.phase === 'SHARE_CARD',
  'phase=' + finalState.phase + '，推进 ' + guard + ' 步');
check('经历了 5 个乐句', recordedPhrases === 5, '实际录音 ' + recordedPhrases + ' 次');
console.log('    逐句触礁数：' + ofType('phrase:result').map((e) => e.payload.newWrecked).join(', '));

const phraseStarts = ofType('melody:phraseStart');
check('melody:phraseStart 广播 >= 5 次', phraseStarts.length >= 5, '实际 ' + phraseStarts.length);
const noteCounts = phraseStarts.slice(0, 5).map((e) => e.payload.notes.length);
check('音数曲线 3/4/5/6/7（D9.1 + D13）', noteCounts.join(',') === '3,4,5,6,7', noteCounts.join(','));

const p0 = phraseStarts[0].payload;
check('melody:phraseStart 载荷符合契约 C3',
  Array.isArray(p0.notes) && Array.isArray(p0.eighths) &&
  typeof p0.familiar === 'boolean' && typeof p0.seed === 'number' && typeof p0.phraseIndex === 'number',
  '键：' + Object.keys(p0).join(', '));
const n0 = p0.notes[0];
check('notes[] 元素含 midi/startMs/durationMs/degree（契约 C3）',
  'midi' in n0 && 'startMs' in n0 && 'durationMs' in n0 && 'degree' in n0,
  JSON.stringify(n0));

const shipIn = ofType('ship:in');
const shipWrecked = ofType('ship:wrecked');
const phraseResults = ofType('phrase:result');
check('每波 20 条船，5 波共 100 条（D13）', shipIn.length === 100, 'ship:in ' + shipIn.length + ' 次');
check('ship:in 载荷含 id/lane/depth/side/entryDelayMs（契约 C3）',
  shipIn.length > 0 && shipIn.every((e) => 'id' in e.payload && 'lane' in e.payload &&
    'depth' in e.payload && 'side' in e.payload && 'entryDelayMs' in e.payload),
  shipIn.length ? JSON.stringify(shipIn[0].payload) : '(无 ship:in 事件)');
check('ship:in 不含内部字段 k（后端不下发）',
  shipIn.length > 0 && !('k' in shipIn[0].payload),
  shipIn.length ? Object.keys(shipIn[0].payload).join(', ') : '(无)');
check('ship:wrecked 载荷含 id/pull（契约 C3）',
  shipWrecked.length > 0 && shipWrecked.every((e) => 'id' in e.payload && 'pull' in e.payload),
  shipWrecked.length ? '共 ' + shipWrecked.length + ' 条，样例 ' + JSON.stringify(shipWrecked[0].payload) : '(无)');
check('phrase:result 含 phraseIndex/newWrecked/totalWrecked（契约 C3）',
  phraseResults.length === 5 && phraseResults.every((e) =>
    'phraseIndex' in e.payload && 'newWrecked' in e.payload && 'totalWrecked' in e.payload),
  phraseResults.map((e) => e.payload.newWrecked).join('+'));
check('shipsWrecked 等于 ship:wrecked 广播次数',
  finalState.shipsWrecked === shipWrecked.length,
  'state=' + finalState.shipsWrecked + ' 广播=' + shipWrecked.length);

const pitches = ofType('attempt:pitch');
check('attempt:pitch 载荷含 t/midi/cents/conf/voiced（契约 C3）',
  pitches.length > 0 && pitches.every((e) => 't' in e.payload && 'midi' in e.payload &&
    'cents' in e.payload && 'conf' in e.payload && 'voiced' in e.payload),
  pitches.length ? JSON.stringify(pitches[0].payload) : '(无)');
const gaps = [];
for (let i = 1; i < Math.min(pitches.length, 40); i += 1) gaps.push(pitches[i].at - pitches[i - 1].at);
const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
check('attempt:pitch 每 50ms 一次（D11 要求 20Hz）', Math.abs(avgGap - 50) < 1,
  '平均间隔 ' + avgGap.toFixed(1) + 'ms，共 ' + pitches.length + ' 次');
check('有音高帧 voiced=true 且 midi 合理',
  pitches.some((e) => e.payload.voiced && e.payload.midi > 50 && e.payload.midi < 90),
  'voiced 样例 ' + pitches.filter((e) => e.payload.voiced).slice(0, 4).map((e) => e.payload.midi.toFixed(1)).join(', '));
check('cents 落在 ±50（契约 C3）',
  pitches.length > 0 && pitches.every((e) => Math.abs(e.payload.cents) <= 50),
  pitches.length ? '最大 ' + Math.max(...pitches.map((e) => Math.abs(e.payload.cents))).toFixed(1) : '(无)');

const ends = ofType('attempt:end');
check('attempt:end reason 属于 done|silence|timeout（契约 C3）',
  ends.length === 5 && ends.every((e) => ['done', 'silence', 'timeout'].indexOf(e.payload.reason) >= 0),
  ends.map((e) => e.payload.reason).join(', '));

// ---- v1.1.0 逐音档位反馈（契约 C5）
const noteJudges = ofType('attempt:note');
const VALID_TIERS = ['perfect', 'great', 'good', 'miss'];
check('attempt:note 每句每个音各一次（契约 C5）',
  noteJudges.length === 25,   // 3+4+5+6+7
  `实际 ${noteJudges.length} 次`);
check('attempt:note 载荷含 index/targetMidi/actualMidi/accuracy/tier/t（契约 C5）',
  noteJudges.length > 0 && noteJudges.every((e) =>
    'index' in e.payload && 'targetMidi' in e.payload && 'actualMidi' in e.payload &&
    'accuracy' in e.payload && 'tier' in e.payload && 't' in e.payload),
  noteJudges.length ? JSON.stringify(noteJudges[0].payload) : '(无)');
check('tier 属于 perfect|great|good|miss',
  noteJudges.every((e) => VALID_TIERS.indexOf(e.payload.tier) >= 0),
  [...new Set(noteJudges.map((e) => e.payload.tier))].join(', '));
check('accuracy 落在 0–1 且 miss 时为 0',
  noteJudges.every((e) => e.payload.accuracy >= 0 && e.payload.accuracy <= 1 &&
    (e.payload.tier !== 'miss' || e.payload.accuracy === 0)),
  '范围 ' + Math.min(...noteJudges.map((e) => e.payload.accuracy)).toFixed(2) + '–' +
  Math.max(...noteJudges.map((e) => e.payload.accuracy)).toFixed(2));
check('index 在每句内从 0 连续递增（每句一条序列）',
  (() => {
    const byPhrase = {};
    for (const e of noteJudges) {
      // 用 t 的分段无法可靠划分，改为校验全局每 3/4/5/6/7 分组
      const key = e.payload.index;
      byPhrase[key] = (byPhrase[key] || 0) + 1;
    }
    // 3 音句贡献 index 0..2 各一次，依此类推：index 0..2 出现 5 次，3 出现 4 次…
    return byPhrase[0] === 5 && byPhrase[3] === 4 && byPhrase[4] === 3 && byPhrase[6] === 1;
  })(),
  '各 index 出现次数：' + JSON.stringify((() => {
    const m = {};
    for (const e of noteJudges) m[e.payload.index] = (m[e.payload.index] || 0) + 1;
    return m;
  })()));
// ⚠️ 这里不断言"完美演唱必须全 perfect"：
//    测试桩不是忠实的演唱仿真（音高有 ±1.2% 微扰、起音有 ~250ms 系统性滞后），
//    真实人声的档位表现需真机验证。
//    档位**阈值**的正确性由 test-score.mjs 的 `judgeNotes` 专项用例覆盖
//    （完美→perfect、低/高八度→perfect、晚250ms→good、偏150音分→good、偏400音分→miss）。
//    本用例只验证事件机制与档位区分度。
const tierCounts = {};
for (const e of noteJudges) tierCounts[e.payload.tier] = (tierCounts[e.payload.tier] || 0) + 1;
check('档位具有区分度（不只出现单一档位）',
  Object.keys(tierCounts).length >= 2,
  JSON.stringify(tierCounts));
check('至少存在 perfect 档（说明机制可达最高档）',
  (tierCounts.perfect || 0) > 0, JSON.stringify(tierCounts));
check('末音也被判定（每句最后一个音的 index 都出现过）',
  (() => {
    const m = {};
    for (const e of noteJudges) m[e.payload.index] = (m[e.payload.index] || 0) + 1;
    return m[2] === 5 && m[6] === 1;   // 最长句 7 音 → index 6 只出现 1 次
  })(),
  'index 2 与 index 6 均已出现');

const finales = ofType('game:finale');
check('game:finale 含 wreckedTotal/ending/seed（契约 C3）',
  finales.length === 1 && 'wreckedTotal' in finales[0].payload &&
  'ending' in finales[0].payload && 'seed' in finales[0].payload,
  finales.length ? JSON.stringify(finales[0].payload) : '(无)');
check('ending 属于 A|B|C|D',
  finales.length === 1 && ['A', 'B', 'C', 'D'].indexOf(finales[0].payload.ending) >= 0,
  finales.length ? finales[0].payload.ending : '(无)');
check('melody:replay 在终局广播（D3 全曲回放）', ofType('melody:replay').length === 1);
// ⚠️ 这里不断言绝对分数。合成麦克风桩不是忠实的音频仿真（多个测试间还会互相串数据），
//    绝对分数的可信验证在 tools/test-score.mjs（完美演唱 = 100 分）。
//    本测试只负责证明「pitch → segment → score → fleet → 事件」这条链是连通的。
check('有乐句打出真实分数（评分链连通）',
  ofType('phrase:result').some((e) => e.payload.newWrecked > 0),
  '逐句触礁：' + ofType('phrase:result').map((e) => e.payload.newWrecked).join(', ') +
  '（绝对分数见 test-score.mjs）');

// ================================================================ 4b

console.log('');
console.log('[4b] 新手引导关（v1.1.0 / 契约 C2 的 TUTORIAL phase）');
{
  // 清掉「已完成」标记，重新走一次首局
  storeMap.delete('siren.tutorialDone');
  events.length = 0;
  micStub.state.amp = 0.4;
  await Siren.init({ seed: 777 });
  Siren.start();
  await Promise.resolve();
  await Promise.resolve();
  await clock.advanceTo(clock.now() + 50);

  check('首局进入 TUTORIAL phase（契约 C2）',
    Siren.getState().phase === 'TUTORIAL',
    'phase=' + Siren.getState().phase);

  const tutPhrases = ofType('melody:phraseStart');
  check('引导关播放固定 3 音乐句（PRD §7.5.1.2）',
    tutPhrases.length >= 1 && tutPhrases[0].payload.notes.length === 3,
    tutPhrases.length ? tutPhrases[0].payload.notes.length + ' 音' : '(无)');
  check('引导关乐句 phraseIndex 恒为 0，且不是熟曲',
    tutPhrases.length >= 1 && tutPhrases[0].payload.phraseIndex === 0 &&
    tutPhrases[0].payload.familiar === false,
    tutPhrases.length ? JSON.stringify({ i: tutPhrases[0].payload.phraseIndex, fam: tutPhrases[0].payload.familiar }) : '(无)');

  // 推进到通过（micStub 会唱准）
  let g2 = 0;
  while (Siren.getState().phase === 'TUTORIAL') {
    await clock.advanceTo(clock.now() + 50);
    if (++g2 > 4000) break;
  }
  check('引导关唱对后自动进入 LEARN_LOOP',
    Siren.getState().phase === 'LEARN_LOOP',
    'phase=' + Siren.getState().phase + '（推进 ' + g2 + ' 步）');
  check('引导关产生了船队反馈（教学因果可见）',
    ofType('ship:in').length > 0,
    'ship:in ' + ofType('ship:in').length + ' 次');
  check('引导关不产生 phrase:result（不计入战果）',
    ofType('phrase:result').length === 0,
    'phrase:result ' + ofType('phrase:result').length + ' 次');
  check('通过后写入 tutorialDone 标记',
    storeMap.get('siren.tutorialDone') === '1',
    String(storeMap.get('siren.tutorialDone')));
  Siren.abort();

  // ---- 跳过路径
  storeMap.delete('siren.tutorialDone');
  events.length = 0;
  await Siren.init({ seed: 888 });
  Siren.start();
  await Promise.resolve();
  await Promise.resolve();
  await clock.advanceTo(clock.now() + 50);
  check('第二次首局仍进 TUTORIAL（标记已清）', Siren.getState().phase === 'TUTORIAL',
    'phase=' + Siren.getState().phase);
  const skipped = Siren.skipTutorial();
  check('skipTutorial() 返回 true（契约 C1 新增成员）', skipped === true, String(skipped));
  await clock.advanceTo(clock.now() + 50);
  check('跳过后直接进 LEARN_LOOP',
    Siren.getState().phase === 'LEARN_LOOP',
    'phase=' + Siren.getState().phase);
  check('跳过后也写入标记（不再重复引导）',
    storeMap.get('siren.tutorialDone') === '1',
    String(storeMap.get('siren.tutorialDone')));
  Siren.abort();
  events.length = 0;
  storeMap.set('siren.tutorialDone', '1');
}

// ================================================================ 5

console.log('');
console.log('[5] 通知与错误只给技术码（契约 C4）');
const notices = ofType('notice');
const ALL_CODES = ['MIC_DENIED', 'MIC_RETRY', 'NOISY_ENV', 'LOW_CONFIDENCE', 'NO_INPUT', 'STORAGE_FAILED'];
check('notice code 全部在契约 C4 表内',
  notices.every((e) => ALL_CODES.indexOf(e.payload.code) >= 0),
  [...new Set(notices.map((e) => e.payload.code))].join(', ') || '(无)');
check('notice level = notice', notices.every((e) => e.payload.level === 'notice'));
check('除契约允许的熟曲标题外，后端不返回任何中文文案',
  !/[\u4e00-\u9fa5]/.test(JSON.stringify(events.filter((e) => e.type !== 'melody:titleReveal').map((e) => e.payload))),
  'melody:titleReveal 的歌名是契约 C3 的内容数据，其余事件载荷零中文');

// ================================================================ 6

console.log('');
console.log('[6] 输入增益自适应（设备电平偏低时的保护）');
{
  // 让麦克风桩发出很轻的信号（峰值约 0.004 RMS，模拟实测中那台电平偏低的设备）
  const savedAmp = micStub.state.amp;
  micStub.state.amp = 0.006;          // 远低于 Audio.GAIN_CFG.TARGET(0.035)
  events.length = 0;
  await Siren.init({ seed: 3131 });
  Siren.start();
  await Promise.resolve();
  await Promise.resolve();
  for (let i = 0; i < 4000; i += 1) {
    await clock.advanceTo(clock.now() + 50);
    // 第一句录完即可，不必跑完整局
    if (ofType('attempt:end').length >= 2) break;
  }
  const quietPitches = ofType('attempt:pitch');
  const voicedQuiet = quietPitches.filter((e) => e.payload.voiced).length;
  check('低电平输入下仍能检出音高（YIN 在 0.003 RMS 以上可用）',
    voicedQuiet > 0,
    `${quietPitches.length} 帧中 ${voicedQuiet} 帧有音高`);
  check('输入过轻时广播 LOW_CONFIDENCE（契约 C4 已有码，未擅自新增）',
    ofType('notice').some((e) => e.payload.code === 'LOW_CONFIDENCE'),
    [...new Set(ofType('notice').map((e) => e.payload.code))].join(', ') || '(无)');
  micStub.state.amp = savedAmp;
  Siren.abort();
  events.length = 0;
}

// ================================================================ 7

console.log('');
console.log('[7] 静默 3s 中止（D3：不广播提示文案，只给 reason）');
events.length = 0;
await Siren.init({ seed: 777 });
// 前面的完整演唱监听器会在每次 attempt:start 恢复发声；本用例在它之后明确静音。
const stopSilentAttempt = Siren.on('attempt:start', () => micStub.setSilent(true));
Siren.start();
await Promise.resolve();
await Promise.resolve();
micStub.setSilent(true);
for (let i = 0; i < 2000 && ofType('attempt:end').length === 0; i += 1) await clock.advanceTo(clock.now() + 50);

const silenceEnd = ofType('attempt:end')[0];
check('静默触发 attempt:end { reason: "silence" }',
  !!silenceEnd && silenceEnd.payload.reason === 'silence',
  silenceEnd ? JSON.stringify(silenceEnd.payload) : '未触发');
const noInput = events.filter((e) => e.type === 'notice' && e.payload.code === 'NO_INPUT');
check('静默时只广播 NO_INPUT 技术码，无任何中文提示',
  noInput.length <= 1 && !/[\u4e00-\u9fa5]/.test(JSON.stringify(noInput.map((e) => e.payload))),
  'NO_INPUT ' + noInput.length + ' 次');
Siren.abort();
stopSilentAttempt();

// ================================================================ 8

console.log('');
console.log('[8] 无麦克风兜底模式（D10）');
events.length = 0;
micMode = 'deny';
await Siren.init({ seed: 2024 });
Siren.start();
await Promise.resolve();
await Promise.resolve();
await clock.advanceTo(clock.now() + 200);

check('拒绝麦克风 -> 进入 RHYTHM_FALLBACK（D3）',
  ofType('state:change').some((e) => e.payload.phase === 'RHYTHM_FALLBACK'),
  'phase 序列：' + [...new Set(ofType('state:change').map((e) => e.payload.phase))].join(' -> '));
// 契约 C4 把 MIC_DENIED 定为 error 级；此前误发成 notice，前端监听 error 会永远收不到
check('拒绝麦克风 -> 以 error 级广播 MIC_DENIED（契约 C4 的 level 列）',
  ofType('error').some((e) => e.payload.code === 'MIC_DENIED'),
  ofType('error').map((e) => e.payload.code + '/' + (e.payload.message || '')).join(', ') || '(无 error)');
check('拒绝麦克风 -> 同时广播 MIC_RETRY（契约 C4 定义了但此前从未发出）',
  ofType('notice').some((e) => e.payload.code === 'MIC_RETRY'),
  [...new Set(ofType('notice').map((e) => e.payload.code))].join(', '));

// 兜底模式打拍：每次 attempt:start 后按目标节拍注入 pointerdown
let pendingTaps = null;
let tapBaseAt = 0;
Siren.on('attempt:start', () => {
  const last = ofType('melody:phraseStart').slice(-1)[0];
  if (last) {
    pendingTaps = last.payload.notes.map((n) => n.startMs + 500);
    tapBaseAt = clock.now();
  }
});

let fbGuard = 0;
while (Siren.getState().phase !== 'RESULT' && Siren.getState().phase !== 'SHARE_CARD') {
  // 按时间推进并每轮只发一个拍：粗步长会把打拍时刻量化，测不出真实节奏分
  const hasTap = pendingTaps && pendingTaps.length > 0;
  const target = hasTap ? tapBaseAt + pendingTaps[0] : clock.now() + 100;
  await clock.advanceTo(Math.max(clock.now() + 1, target));
  if (hasTap && tapHandler && clock.now() - tapBaseAt >= pendingTaps[0]) {
    tapHandler({ type: 'pointerdown' });
    pendingTaps.shift();
  }
  if (++fbGuard > 40000) break;
}
const fbFinale = ofType('game:finale')[0];
check('兜底模式也能走完一局到终局', !!fbFinale,
  fbFinale ? 'wreckedTotal=' + fbFinale.payload.wreckedTotal : '未到终局');
check('兜底模式每波仍 20 条、共 100 条（分数换算一致）',
  ofType('ship:in').length === 100, 'ship:in ' + ofType('ship:in').length + ' 次');
// ⚠️ 同样不断言绝对分数：注入的打拍时刻受虚拟时钟步长量化，不等于精确节拍。
//    「兜底模式能拿满分」由 tools/test-score.mjs 的 _scoreRhythmOnly 用例保证（完美打拍 = 100）。
check('兜底模式打出真实分数（节奏评分链连通）',
  !!fbFinale && fbFinale.payload.wreckedTotal > 0,
  fbFinale ? 'wreckedTotal=' + fbFinale.payload.wreckedTotal + '（打拍时刻受虚拟时钟量化，非精确节拍）' : '(无)');
Siren.abort();
micMode = 'grant';

// ================================================================

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(2);
}
console.log('集成验证通过');
