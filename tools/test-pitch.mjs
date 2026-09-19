#!/usr/bin/env node
/**
 * pitch.js 离线验证（D5）
 *
 * 用合成信号验证 YIN 音高检测的精度与性能——不需要麦克风、不需要浏览器。
 * 这是"算法是否可信"的第一道关；真机采集仍需人工在探针页跑。
 *
 * 覆盖：
 *   1. 纯正弦：全音域（男女声 + 低八度哼唱）音分误差
 *   2. 带谐波的类人声信号（基频弱于二三次谐波，YIN 最容易出错的情况）
 *   3. 抛物线插值是否真的必要（关掉插值对比误差）
 *   4. 单次检测耗时（D5 预算 < 5ms）
 *   5. 边界：静音、白噪声、超出音域的信号应返回"无音高"
 *
 * 用法：node tools/test-pitch.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 在 Node 里加载浏览器模块（模块自带 UMD 式挂载）
const source = fs.readFileSync(path.join(ROOT, 'game', 'js', 'core', 'pitch.js'), 'utf8');
const sandbox = {};
new Function('window', 'globalThis', source)(sandbox, sandbox);
const Pitch = sandbox.Siren.Pitch;

const SR = 48000;
const W = 2048;

// ---------------------------------------------------------------- 信号生成

function sine(hz, n = W, sr = SR, amp = 0.5, phase = 0) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) b[i] = amp * Math.sin(2 * Math.PI * hz * i / sr + phase);
  return b;
}

/** 类人声：基频 + 若干谐波，基频振幅可调低（模拟共振峰偏移后的"难例"） */
function voiceLike(hz, n = W, sr = SR, baseAmp = 0.6) {
  const b = new Float32Array(n);
  const h = [baseAmp, 0.5, 0.35, 0.2, 0.1];
  for (let i = 0; i < n; i += 1) {
    let v = 0;
    for (let k = 0; k < h.length; k += 1) {
      v += h[k] * Math.sin(2 * Math.PI * hz * (k + 1) * i / sr);
    }
    b[i] = v * 0.35;
  }
  return b;
}

function noise(n = W, amp = 0.4) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (Math.random() * 2 - 1) * amp;
  return b;
}

const silence = () => new Float32Array(W);

// ---------------------------------------------------------------- 断言工具

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? '  — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ---------------------------------------------------------------- 1. 纯正弦精度

console.log('【1】纯正弦音高精度（音分误差）');
console.log('    音域覆盖：低八度哼唱 C3 → 女声高音 E5（即 D4 规定的 90–660Hz）');
const SINE_CASES = [
  { name: 'C3', hz: 130.81 },
  { name: 'G3', hz: 196.00 },
  { name: 'C4', hz: 261.63 },
  { name: 'E4', hz: 329.63 },
  { name: 'G4', hz: 392.00 },
  { name: 'A4', hz: 440.00 },
  { name: 'C5', hz: 523.25 },
  { name: 'D5', hz: 587.33 },
  { name: 'E5', hz: 659.26 },
];

let worstSine = 0;
for (const c of SINE_CASES) {
  const r = Pitch.detectPitch(sine(c.hz), SR, W);
  const cents = r.hz > 0 ? Math.abs(Pitch.centsBetween(r.hz, c.hz)) : Infinity;
  worstSine = Math.max(worstSine, cents);
  check(
    `纯正弦 ${c.name} (${c.hz}Hz)`,
    cents <= 5,
    `测得 ${r.hz.toFixed(2)}Hz / ${Pitch.midiToName(r.midi)} · 误差 ${cents.toFixed(2)} 音分 · conf ${r.conf.toFixed(3)}`,
  );
}
check('纯正弦最大误差 ≤ 5 音分', worstSine <= 5, `实测最大 ${worstSine.toFixed(2)} 音分`);

// ---------------------------------------------------------------- 2. 类人声信号

console.log('');
console.log('【2】类人声信号（含谐波，YIN 易错场景）');
const VOICE_CASES = [
  { name: '低八度哼唱 C3', hz: 130.81 },
  { name: '男声 G3', hz: 196.00 },
  { name: '中音 C4', hz: 261.63 },
  { name: '女声 C5', hz: 523.25 },
];
let worstVoice = 0;
for (const c of VOICE_CASES) {
  const r = Pitch.detectPitch(voiceLike(c.hz), SR, W);
  const cents = r.hz > 0 ? Math.abs(Pitch.centsBetween(r.hz, c.hz)) : Infinity;
  worstVoice = Math.max(worstVoice, cents);
  check(
    `类人声 ${c.name}`,
    cents <= 10,
    `测得 ${r.hz.toFixed(2)}Hz · 误差 ${cents.toFixed(2)} 音分 · conf ${r.conf.toFixed(3)}`,
  );
}
check('类人声最大误差 ≤ 10 音分', worstVoice <= 10, `实测最大 ${worstVoice.toFixed(2)} 音分`);

// 基频很弱的情况（YIN 会锁到二次谐波 = 高八度错误）
const weakBase = voiceLike(220, W, SR, 0.12);
const weakR = Pitch.detectPitch(weakBase, SR, W);
const weakCents = weakR.hz > 0 ? Pitch.centsBetween(weakR.hz, 220) : Infinity;
console.log(`  ℹ 基频很弱时测得 ${weakR.hz.toFixed(1)}Hz（${Pitch.midiToName(weakR.midi)}），偏差 ${isFinite(weakCents) ? weakCents.toFixed(0) + ' 音分' : '无音高'}`);
console.log(`    注：这是 YIN 的固有局限（八度错误），真实人声基频通常不弱于此。`);

// ---------------------------------------------------------------- 3. 抛物线插值必要性

console.log('');
console.log('【3】抛物线插值是否必要（D5 要求"必须做"）');
console.log('    做法：detectPitchRaw 给出插值后的 τ，round 掉小数得到"仅整数 τ"的对照');

let worstInterp = 0;
let worstInteger = 0;
for (const hz of [523.25, 587.33, 659.26, 493.88]) {
  const buf = sine(hz);
  const withInterp = Pitch.detectPitch(buf, SR, W);
  const raw = Pitch.detectPitchRaw(buf, SR, W);
  const integerHz = SR / Math.round(raw.tau);
  const cInterp = Math.abs(Pitch.centsBetween(withInterp.hz, hz));
  const cInteger = Math.abs(Pitch.centsBetween(integerHz, hz));
  worstInterp = Math.max(worstInterp, cInterp);
  worstInteger = Math.max(worstInteger, cInteger);
  console.log(`    ${hz}Hz → 带插值 ${cInterp.toFixed(2)} 音分 / 仅整数τ ${cInteger.toFixed(2)} 音分`);
}
check('带插值误差明显小于不带插值', worstInterp < worstInteger && worstInterp <= 1,
  `最大 ${worstInterp.toFixed(2)} vs ${worstInteger.toFixed(2)} 音分`);

// ---------------------------------------------------------------- 4. 性能

console.log('');
console.log('【4】单次检测耗时（D5 预算 < 5ms）');
const perfBuf = voiceLike(261.63);
// 预热
for (let i = 0; i < 50; i += 1) Pitch.detectPitch(perfBuf, SR, W);
const N = 500;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) Pitch.detectPitch(perfBuf, SR, W);
const t1 = process.hrtime.bigint();
const avgMs = Number(t1 - t0) / 1e6 / N;
check('单次检测平均 < 5ms', avgMs < 5, `实测 ${avgMs.toFixed(3)}ms/次（${N} 次平均）`);
console.log(`    ℹ 注意：这是桌面 Node 的数字。中端安卓 / 小红书 WebView 需人工在探针页实测。`);

// 窗口降到 1024 的兜底路径
const perf1024 = voiceLike(261.63, 1024);
for (let i = 0; i < 50; i += 1) Pitch.detectPitch(perf1024, SR, 1024);
const t2 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) Pitch.detectPitch(perf1024, SR, 1024);
const t3 = process.hrtime.bigint();
const avg1024 = Number(t3 - t2) / 1e6 / N;
console.log(`    ℹ 窗口 1024 时 ${avg1024.toFixed(3)}ms/次（兜底路径，约为 ${(avgMs / avg1024).toFixed(2)}x 加速）`);

// ---------------------------------------------------------------- 5. 边界

console.log('');
console.log('【5】边界情况应返回"无音高"（hz=0）');
const rSilence = Pitch.detectPitch(silence(), SR, W);
check('静音 → 无音高', rSilence.hz === 0, `hz=${rSilence.hz}`);

let noiseFalsePositives = 0;
for (let i = 0; i < 100; i += 1) {
  if (Pitch.detectPitch(noise(), SR, W).hz > 0) noiseFalsePositives += 1;
}
check('白噪声误报率 < 5%', noiseFalsePositives < 5, `100 次中误报 ${noiseFalsePositives} 次`);

const rLow = Pitch.detectPitch(sine(45), SR, W);
check('低于音域下限 45Hz → 无音高', rLow.hz === 0, `hz=${rLow.hz}`);

const rHigh = Pitch.detectPitch(sine(1500), SR, W);
check('高于音域上限 1500Hz → 无音高', rHigh.hz === 0, `hz=${rHigh.hz}`);

// 八度错误回归测试：这是 D5 给的 τ 范围导致的真实缺陷
// τMin = floor(sr/660) → 周期短于 τMin 的信号搜不到基频凹陷，
// YIN 会落到 2 倍 / 3 倍周期上，自信地报出一个低八度 / 低十二度的答案。
const OCTAVE_CASES = [
  { hz: 1046.50, name: 'C6', wrong: 'C5 (523Hz)' },
  { hz: 880.00, name: 'A5', wrong: 'A4 (440Hz)' },
  { hz: 1500.00, name: 'F#6', wrong: '约 500Hz' },
  { hz: 784.00, name: 'G5', wrong: 'G4 (392Hz)' },
];
let octaveLeaks = 0;
for (const c of OCTAVE_CASES) {
  const r = Pitch.detectPitch(sine(c.hz), SR, W);
  const leaked = r.hz > 0;
  if (leaked) octaveLeaks += 1;
  check(`${c.name} (${c.hz}Hz) 超范围必须拒绝，不得错报成 ${c.wrong}`,
    !leaked, leaked ? `错报为 ${r.hz.toFixed(1)}Hz / ${Pitch.midiToName(r.midi)}（差 ${Math.abs(Pitch.centsBetween(r.hz, c.hz)).toFixed(0)} 音分）` : 'hz=0 ✓');
}
check('超范围信号零泄漏（无错八度输出）', octaveLeaks === 0, `${octaveLeaks} / ${OCTAVE_CASES.length} 泄漏`);

const rShort = Pitch.detectPitch(new Float32Array(512), SR, W);
check('缓冲不足 → 安全返回，不抛错', rShort.hz === 0, `hz=${rShort.hz}`);

// 不同采样率（D5：运行时读 ctx.sampleRate，不硬编码）
for (const sr of [44100, 48000]) {
  const r = Pitch.detectPitch(sine(440, W, sr), sr, W);
  const cents = Math.abs(Pitch.centsBetween(r.hz, 440));
  check(`采样率 ${sr}Hz 下 A4 精度`, cents <= 5, `误差 ${cents.toFixed(2)} 音分`);
}

// 音名换算自检
console.log('');
console.log('【6】音名 / MIDI 换算');
check('A4 = MIDI 69', Math.round(Pitch.hzToMidi(440)) === 69);
check('C4 = MIDI 60 且音名 C4', Math.round(Pitch.hzToMidi(261.63)) === 60 && Pitch.midiToName(60) === 'C4');
check('MIDI 69 反算回 440Hz', Math.abs(Pitch.midiToHz(69) - 440) < 1e-9);
check('同音音分差为 0', Math.abs(Pitch.centsBetween(440, 440)) < 1e-9);
check('高八度 = 1200 音分', Math.abs(Pitch.centsBetween(880, 440) - 1200) < 1e-6);

// ---------------------------------------------------------------- 汇总

console.log('');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(2);
}
console.log('pitch.js 离线验证通过');
