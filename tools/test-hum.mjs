#!/usr/bin/env node
/**
 * 哼唱 vs 真唱：端到端验证（D14 步骤 3 + D6 哼唱特殊处理 + PRD Q2「同分」决策）
 *
 * 与 test-score.mjs 的区别：那个直接喂"理想音符"，这个喂**音频样本**，
 * 走 音高检测 → 起音检测 → 音符切分 → 打分 的完整链路。
 * 因此它能验证"哼唱不惩罚"，而 test-score.mjs 验证不了（它跳过了切分）。
 *
 * 三种演唱方式的建模差异只体现在**能量包络**上（D6 原文：
 * "闭口哼唱无辅音起音，能量上升缓慢 50–150ms，判定阈值改为达到稳定能量的 60%"）：
 *   · 真唱  : 10ms 内冲到满能量（辅音起音）
 *   · 哼唱  : 80ms 线性爬到满能量（无起音辅音）
 *   · 气声  : 150ms 缓慢爬升（更极端）
 * 音高本身三种方式完全相同——差异全部交给起音检测处理。
 *
 * 用法：node tools/test-hum.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sb = {};
for (const rel of [
  'game/js/core/pitch.js',
  'game/js/core/segment.js',
  'game/js/core/fleet.js',
  'game/data/melodies.js',
  'game/js/core/melody.js',
  'game/js/core/score.js',
]) {
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(sb, sb);
}
const { Pitch, Segment, Score, Melody, MELODIES } = sb.Siren;

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  OK   ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? '  — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};

const SR = 48000;
const W = 2048;
const TICK = 50;          // 检测间隔（与 D11 一致）
const BPM = 92;

// ---------------------------------------------------------------- 演唱合成

/**
 * 把音符序列渲染成麦克风会收到的样本流，再按 50ms 一帧跑音高检测。
 *
 * ⚠️ 必须建模"音符间隔"，否则会测出假问题：
 *    D4.3 强制 duration = 时值 − 40ms，播放时每个音之间真的留了 40ms 空隙；
 *    若测试素材做成音与音首尾相接（无空隙），相邻同音会被切分器合并成一个音，
 *    于是《小星星》开头的两个 C 只剩一个——那不是算法错，是测试素材不真实。
 *
 * @param {Array} notes      目标音符（含 midi / onsetMs / durationMs）
 * @param {Object} opt
 *   opt.attackMs    能量上升时间（真唱 10 / 哼唱 80 / 气声 150）
 *   opt.gapMs       音符间的实际空隙（默认 40，与 D4.3 的 DURATION_GAP_MS 一致）
 *   opt.centsOff    音分偏差
 *   opt.octave      八度偏移
 *   opt.dropIdx     漏掉的音
 *   opt.noiseFloor  背景噪音 RMS
 */
function singAndDetect(notes, opt = {}) {
  const {
    attackMs = 10,
    gapMs = 40,
    centsOff = 0,
    octave = 0,
    dropIdx = [],
    noiseFloor = 0.003,
    totalMs = 6000,
  } = opt;

  const frames = [];
  let phase = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const FULL = 0.30;
  const floorLevel = noiseFloor * 1.2;

  for (let t = TICK; t <= totalMs; t += TICK) {
    // 当前该发哪个音
    let idx = -1;
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      if (dropIdx.includes(i)) continue;
      if (t >= notes[i].onsetMs && t < notes[i].onsetMs + notes[i].durationMs) { idx = i; break; }
    }

    let hz = 0;
    let rms = noiseFloor;

    if (idx >= 0) {
      const n = notes[idx];
      const into = t - n.onsetMs;
      const freq = Pitch.midiToHz(n.midi + octave) * Math.pow(2, centsOff / 1200);
      hz = freq;

      // 能量包络：attackMs 内从基准线爬到满（辅音起音 vs 哼唱起音的差别）
      const progress = Math.min(1, into / Math.max(1, attackMs));
      rms = floorLevel + (FULL - floorLevel) * progress;
    }

    // 音符间隔：播放在"时值 − gapMs"处收声，留出真实空隙（D4.3）
    // 跨音符边界时，空隙落在前一个音的尾部
    for (let i = 0; i < notes.length; i += 1) {
      if (dropIdx.includes(i)) continue;
      const soundEnd = notes[i].onsetMs + notes[i].durationMs - gapMs;
      const noteEnd = notes[i].onsetMs + notes[i].durationMs;
      if (t >= soundEnd && t < noteEnd) {
        // 收声到接近底噪（模拟 D4.3 留下的 40ms 间隔）
        hz = 0;
        rms = noiseFloor * 1.05;
        break;
      }
    }

    // 生成一帧样本：正弦 + 底噪
    const buf = new Float32Array(W);
    const amp = hz > 0 ? rms * Math.SQRT2 : 0;
    for (let i = 0; i < W; i += 1) {
      let v = (rnd() * 2 - 1) * noiseFloor;
      if (hz > 0) v += amp * Math.sin(2 * Math.PI * hz * (phase + i) / SR);
      buf[i] = v;
    }
    phase += W;

    const r = Pitch.detectPitch(buf, SR, W);
    frames.push({ t, hz: r.hz, conf: r.conf, rms });
  }

  const seg = Segment.segment(frames, { noiseFloor });
  return { frames, seg };
}

// ---------------------------------------------------------------- 测试素材

const twinkle = MELODIES[0].phrases[0];
const phrase = { degrees: twinkle.degrees, eighths: twinkle.eighths, scale: 'major' };
const target = Score._buildTarget(phrase, (d) => Melody.toMidi(d, 'major'), BPM);

console.log('哼唱 vs 真唱：端到端验证');
console.log('');
console.log('  素材：《小星星》第 1 句，' + target.length + ' 个音');
console.log('  音名：' + target.map((n) => Pitch.midiToName(n.midi)).join(' '));
console.log('  链路：合成音频 → YIN 音高检测(50ms/帧) → 起音检测 → 音符切分 → 四维打分');
console.log('');

const score = (opt) => {
  const { seg } = singAndDetect(target, opt);
  const v = Score._scoreAttemptVerbose(target, seg.notes);
  return { seg, v, score: v.score };
};

// ---------------------------------------------------------------- 1. 三种演唱方式

console.log('【1】三种演唱方式的得分（D6 要求哼唱不做任何惩罚）');
const sung = score({ attackMs: 10 });
const hummed = score({ attackMs: 80 });
const breathy = score({ attackMs: 150 });

const show = (label, r) => {
  console.log(`    ${label.padEnd(14)} 得分 ${String(r.score).padStart(3)}` +
    `   切出 ${r.seg.notes.length}/${target.length} 音` +
    `   起音偏差 ${r.v.pairs.filter((p) => p.actualIdx !== null).map((p) => {
      const a = r.seg.notes[p.actualIdx];
      const t = target[p.targetIdx];
      return Math.round((a.onsetMs !== undefined ? a.onsetMs : a.startMs) - t.onsetMs);
    }).join(',')} ms`);
};
show('真唱 (10ms)', sung);
show('哼唱 (80ms)', hummed);
show('气声 (150ms)', breathy);
console.log('');

check('真唱能切出全部音', sung.seg.notes.length === target.length,
  `${sung.seg.notes.length}/${target.length}`);
check('哼唱能切出全部音', hummed.seg.notes.length === target.length,
  `${hummed.seg.notes.length}/${target.length}`);
check('气声能切出全部音', breathy.seg.notes.length === target.length,
  `${breathy.seg.notes.length}/${target.length}`);

check('哼唱与真唱得分无显著差异（PRD Q2「同分」）', Math.abs(hummed.score - sung.score) <= 3,
  `哼唱 ${hummed.score} vs 真唱 ${sung.score}，差 ${Math.abs(hummed.score - sung.score)} 分`);
check('气声与真唱得分无显著差异', Math.abs(breathy.score - sung.score) <= 3,
  `气声 ${breathy.score} vs 真唱 ${sung.score}，差 ${Math.abs(breathy.score - sung.score)} 分`);

// 起音延迟是否被 D7.3 的"减中位数偏移"吸收
const onsetDeltas = hummed.v.pairs
  .filter((p) => p.actualIdx !== null)
  .map((p) => hummed.seg.notes[p.actualIdx].startMs - target[p.targetIdx].onsetMs);
const spread = Math.max(...onsetDeltas) - Math.min(...onsetDeltas);
check('哼唱的起音延迟是整体性的（可被中位数偏移吸收）', spread < 120,
  `各音起音偏差范围 ${Math.round(Math.min(...onsetDeltas))}~${Math.round(Math.max(...onsetDeltas))}ms，跨度 ${Math.round(spread)}ms`);

// ---------------------------------------------------------------- 2. 单调性直觉

console.log('');
console.log('【2】分数梯度是否符合直觉');
const cases = [
  ['完美真唱', { attackMs: 10 }],
  ['完美哼唱', { attackMs: 80 }],
  ['整体偏低 60 音分', { attackMs: 10, centsOff: 60 }],
  ['整体低八度（应不扣分）', { attackMs: 10, octave: -12 }],
  ['整体跑 3 个半音（超补偿上限）', { attackMs: 10, centsOff: 300 }],
  ['漏唱第 4 个音', { attackMs: 10, dropIdx: [3] }],
];
const results = {};
for (const [label, opt] of cases) {
  const r = score(opt);
  results[label] = r.score;
  console.log(`    ${label.padEnd(30)} ${String(r.score).padStart(3)} 分` +
    `   (contour ${(r.v.dims.contour * 100).toFixed(0)}% / pitch ${(r.v.dims.pitch * 100).toFixed(0)}%` +
    ` / rhythm ${(r.v.dims.rhythm * 100).toFixed(0)}% / complete ${(r.v.dims.completeness * 100).toFixed(0)}%)`);
}
console.log('');

check('完美演唱得高分', results['完美真唱'] >= 90, `${results['完美真唱']} 分`);
check('整体低八度不扣分（P2 相对音高）',
  Math.abs(results['整体低八度（应不扣分）'] - results['完美真唱']) <= 3,
  `${results['整体低八度（应不扣分）']} vs ${results['完美真唱']}`);
check('小偏差（60 音分，属移调补偿范围）不扣分',
  Math.abs(results['整体偏低 60 音分'] - results['完美真唱']) <= 3,
  `${results['整体偏低 60 音分']} vs ${results['完美真唱']}`);
// ⚠️ 端到端与"理想输入"判据不同，这里说明清楚，免得后来者以为算法没生效：
//    理想输入下（test-score.mjs）整体跑 3 个半音 → 补偿 2 → 残差 100 音分 → pitch 维度 0%。
//    但音频链路里音高检测本身有微小抖动（每帧 ±几音分），折叠后中位数可能取到 1 而不是 1.05，
//    于是残差恰好落在 CENTS_TOLERANT(50) 与 CENTS_ZERO(200) 之间 → 线性给约 67%。
//    两者都符合 D7.3 的定义，差异来自"输入的理想程度"，不是缺陷。
//    因此这里只断言"明显扣分"（≥8 分差距），不断言具体百分比。
check('大偏差（300 音分，超补偿上限）明显扣分',
  results['整体跑 3 个半音（超补偿上限）'] <= results['完美真唱'] - 8,
  `${results['整体跑 3 个半音（超补偿上限）']} vs ${results['完美真唱']}（差 ${results['完美真唱'] - results['整体跑 3 个半音（超补偿上限）']} 分）`);
check('漏唱扣分但不致命',
  results['漏唱第 4 个音'] < results['完美真唱'] && results['漏唱第 4 个音'] >= 60,
  `${results['漏唱第 4 个音']} 分`);

// ---------------------------------------------------------------- 3. 最差情况

console.log('');
console.log('【3】最差情况的分数下限（避免"随便唱都有高分"）');
// 完全唱反：音高倒序
const invertedTarget = target.map((n, i) => ({
  ...n,
  midi: i === 0 ? n.midi : 2 * target[0].midi - n.midi,
}));
const invSeg = singAndDetect(invertedTarget, { attackMs: 10 }).seg;
const invScore = Score._scoreAttemptVerbose(target, invSeg.notes);
console.log(`    音高完全倒过来唱        ${String(invScore.score).padStart(3)} 分` +
  `   (contour ${(invScore.dims.contour * 100).toFixed(0)}% / pitch ${(invScore.dims.pitch * 100).toFixed(0)}%)`);

// 只唱一个音到底（像念经）
const monotone = target.map((n) => ({ ...n, midi: target[0].midi }));
const monoSeg = singAndDetect(monotone, { attackMs: 10 }).seg;
const monoScore = Score._scoreAttemptVerbose(target, monoSeg.notes);
console.log(`    全程只唱一个音（念经）  ${String(monoScore.score).padStart(3)} 分` +
  `   (contour ${(monoScore.dims.contour * 100).toFixed(0)}% / pitch ${(monoScore.dims.pitch * 100).toFixed(0)}%)`);
console.log('');

check('唱反（音高倒置）分数很低', invScore.score < 70,
  `${invScore.score} 分，contour ${(invScore.dims.contour * 100).toFixed(0)}%`);
check('全程单音分数很低', monoScore.score < 70,
  `${monoScore.score} 分，contour ${(monoScore.dims.contour * 100).toFixed(0)}%`);
check('满分与最差之间有足够区分度',
  results['完美真唱'] - Math.min(invScore.score, monoScore.score) >= 25,
  `最高 ${results['完美真唱']} vs 最低 ${Math.min(invScore.score, monoScore.score)}`);

// ---------------------------------------------------------------- 4. 静默

console.log('');
console.log('【4】一个字没唱');
const silent = singAndDetect(target, { attackMs: 10, dropIdx: [0, 1, 2, 3, 4, 5, 6] });
const silentScore = Score._scoreAttemptVerbose(target, silent.seg.notes);
check('完全静默 → 切不出任何音 → 0 分', silent.seg.notes.length === 0 && silentScore.score === 0,
  `切出 ${silent.seg.notes.length} 个音，${silentScore.score} 分`);

// ---------------------------------------------------------------- 汇总

console.log('');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(2);
}
console.log('哼唱/真唱端到端验证通过');
