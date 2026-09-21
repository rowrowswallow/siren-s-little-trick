#!/usr/bin/env node
/**
 * 内存占用实测
 *
 * 用途：回答"整包内存占用是多少"，为"终局缓存玩家录音（PCM）"的决策提供依据。
 * 只测量、不修改任何东西。
 *
 * 度量方式：
 *   · 常驻对象：模块加载后立刻量（AudioContext、本地存储、代码本身）
 *   · 峰值增量：模拟一局（5 乐句 × 6s 录音 + 100 条船 + 打分）后量
 *   · PCM 预测：按 sampleRate × 4 字节 × 时长 推算（每句实际只录到有效时长）
 *
 * 用法：node tools/mem-report.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME = path.join(ROOT, 'game');

const KB = 1024;
const fmt = (b) => (b >= 1024 * KB ? (b / 1024 / KB).toFixed(2) + ' MB' : (b / KB).toFixed(1) + ' KB');
const mb = (n) => n / KB / KB;

// ---------------------------------------------------------------- 1. 静态包体积

console.log('=== 1. 上传包体积（zip 内的文件）===');
const EXCLUDE = ['js/probe', 'js/lab'];
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (!EXCLUDE.some((x) => rel === x || rel.startsWith(x + '/'))) out.push({ rel, abs });
  }
  return out;
}
const files = walk(GAME);
const byDir = {};
let totalBytes = 0;
for (const f of files) {
  const size = fs.statSync(f.abs).size;
  totalBytes += size;
  const top = f.rel.includes('/') ? f.rel.split('/')[0] + '/' + f.rel.split('/')[1].split('.')[0] : '(根)';
  const key = f.rel.startsWith('assets/') ? 'assets/' + f.rel.split('/')[1] : (f.rel.includes('/') ? f.rel.split('/')[0] : '(根)');
  byDir[key] = (byDir[key] || 0) + size;
}
console.log('  分组             体积        占比');
for (const k of Object.keys(byDir).sort((a, b) => byDir[b] - byDir[a])) {
  console.log(`  ${k.padEnd(16)} ${fmt(byDir[k]).padStart(10)}  ${(byDir[k] / totalBytes * 100).toFixed(1).padStart(5)}%`);
}
console.log(`  ${'合计'.padEnd(16)} ${fmt(totalBytes).padStart(10)}   （磁盘）`);
const zipPath = path.join(ROOT, 'dist', 'haixiao-minitool.zip');
if (fs.existsSync(zipPath)) {
  const z = fs.statSync(zipPath).size;
  console.log(`  ${'zip 压缩后'.padEnd(16)} ${fmt(z).padStart(10)}   （压缩率 ${(z / totalBytes * 100).toFixed(1)}%）`);
}

// ---------------------------------------------------------------- 2. 模块常驻内存

console.log('');
console.log('=== 2. 模块常驻内存（后端代码 + 运行时预分配）===');
const before = process.memoryUsage().heapUsed;

// 用最小桩加载全部后端模块（与真实容器相同的加载顺序）
const sb = {};
const stubs = {
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  console: { log() {}, warn() {}, error() {} },
  performance: { now: () => 0 },
};
sb.localStorage = stubs.localStorage;
sb.setTimeout = stubs.setTimeout;
sb.clearTimeout = stubs.clearTimeout;
sb.setInterval = stubs.setInterval;
sb.clearInterval = stubs.clearInterval;
sb.console = stubs.console;
sb.performance = stubs.performance;

const ORDER = [
  'data/melodies.js', 'js/core/store.js', 'js/core/pitch.js', 'js/core/segment.js',
  'js/core/score.js', 'js/core/audio.js', 'js/core/melody.js', 'js/core/fleet.js',
];
for (const rel of ORDER) {
  new Function('window', 'globalThis', fs.readFileSync(path.join(GAME, rel), 'utf8'))(sb, sb);
}
const Siren = sb.Siren;
const afterLoad = process.memoryUsage().heapUsed;
console.log(`  模块加载后堆增量：${fmt(afterLoad - before)}`);

// 关键预分配：YIN 的差分函数缓冲
const sr = 48000;
// PCM 缓存的硬上限（game.js 的 PCM_MAX_SAMPLES × Float32 4 字节 × 5 句）
const PCM_MAX_SAMPLES = 320000;
const PCM_MAX_BYTES = PCM_MAX_SAMPLES * 4;
const PCM_HARD_CAP = PCM_MAX_BYTES * 5;
const tauMax = Math.ceil(sr / 90);
const yinBytes = (tauMax + 3) * 4;
console.log(`  YIN 缓冲（Float32Array ${tauMax + 3}）：${fmt(yinBytes)}  ← 唯一的算法级预分配`);
// 播放链：每种音色一条共振峰链 + 混响 IR
const irBytes = sr * 1.6 * 2 * 4;   // 1.6s 双声道 Float32
console.log(`  混响 IR（ConvolverNode，1.6s 双声道）：${fmt(irBytes)}`);
console.log(`  → 音频子系统常驻合计约 ${fmt(yinBytes + irBytes)}`);

// ---------------------------------------------------------------- 3. 一局峰值

console.log('');
console.log('=== 3. 单局运行期峰值增量 ===');
const beforeRun = process.memoryUsage().heapUsed;

// 旋律 + 目标
const built = Siren.Melody.buildPhrases(4821, Siren.Fleet.CONFIG.NOTES_PER_PHRASE);
// 船队：5 波 × 20 条
Siren.Fleet.resetIds();
const rng = Siren.Fleet.mulberry32(1);
const allShips = [];
for (let w = 0; w < 5; w += 1) {
  const ships = Siren.Fleet.spawnWave(rng, w);
  Siren.Fleet.resolveWave(ships, 50 + w * 5);
  allShips.push(...ships);
}
// 音高帧：每句 6s / 50ms = 120 帧 × 5 句
const allFrames = [];
for (let p = 0; p < 5; p += 1) {
  const notes = Siren.Melody.toNotes(built.phrases[p], 92);
  const frames = [];
  for (let t = 0; t <= 6000; t += 50) {
    const hz = 261.63;
    frames.push({ t, hz, conf: 0.9, rms: 0.02 });
  }
  const seg = Siren.Segment.segment(frames, { noiseFloor: 0.001 });
  const target = Siren.Score._buildTarget(built.phrases[p], (d) => Siren.Melody.toMidi(d, built.phrases[p].scale), 92);
  Siren.Score._scoreAttempt(target, seg.notes);
  allFrames.push(frames);
}
const afterRun = process.memoryUsage().heapUsed;
console.log(`  一局（5 乐句 + 100 船 + 600 音高帧 + 打分）：${fmt(afterRun - beforeRun)}`);
console.log(`  → 这部分完全是临时对象，一局结束即可回收`);

// ---------------------------------------------------------------- 4. PCM 预测

console.log('');
console.log('=== 4. 缓存玩家录音（PCM Float32）===');
console.log('  说明：AudioBuffer 用 Float32，4 字节/样本；采样率取 48000。');
console.log('');
console.log('  ⚠️ 真实峰值由 game.js 的 PCM_MAX_SAMPLES 硬上限决定，不是"句长 × 采样率"：');
console.log('     触顶后**静默丢弃**后续采样（内存有上界，但过长演唱的尾巴录不进回放）。');
console.log('');
console.log('  每句录音时长 | 单句 PCM   | 5 句合计   | 备注');
for (const sec of [2, 3, 4, 6]) {
  const per = sr * sec * 4;
  const capped = per > PCM_MAX_BYTES ? ' ⚠ 超单句上限，实际只存 ' + fmt(PCM_MAX_BYTES) : '';
  console.log(`  ${String(sec).padStart(11)}s | ${fmt(per).padStart(10)} | ${fmt(per * 5).padStart(10)} | ${sec === 6 ? '单句上限（RECORD_MAX_MS）' : ''}${capped}`);
}
console.log('');
console.log(`  硬上限：单句 ${PCM_MAX_SAMPLES} 样本 = ${fmt(PCM_MAX_BYTES)}，5 句合计 ${fmt(PCM_HARD_CAP)}`);
console.log('  ⭐ 上表只是估算。**真实占用以运行时实测为准**：');
console.log('     tools/test-integration.mjs §4 会读取一局的真实 PCM 缓存（Node 下实测 2.89 MB / 757,760 样本）。');

// ---------------------------------------------------------------- 5. 汇总

console.log('');
console.log('=== 5. 汇总（用于对比容器预算）===');
const nodeHeap = process.memoryUsage();
console.log(`  Node 进程当前堆：${fmt(nodeHeap.heapUsed)} / 上限 ${fmt(nodeHeap.heapTotal)}`);
console.log('');
console.log('  项目              | 体积/内存     | 何时占用');
console.log(`  上传包（磁盘）     | ${fmt(totalBytes).padStart(11)} | 常驻`);
console.log(`  后端模块 + 预分配  | ${fmt(afterLoad - before + yinBytes + irBytes).padStart(11)} | 常驻`);
console.log(`  单局临时对象峰值   | ${fmt(afterRun - beforeRun).padStart(11)} | 一局内`);
console.log(`  PCM 缓存（实测）   | ${fmt(2.89 * 1024 * 1024).padStart(11)} | 仅 FINALE 前`);
console.log(`  PCM 缓存（硬上限） | ${fmt(PCM_HARD_CAP).padStart(11)} | 5 句全部顶格`);
console.log('');
console.log('  ⚠️ 这是 Node 侧量的；真机 WebView 的 JS 堆与前端渲染占用需在设备上量。');
console.log('     探针/试唱台可加一段 performance.memory 读数，需要的话告诉我。');
