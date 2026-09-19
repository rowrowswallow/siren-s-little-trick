#!/usr/bin/env node
/**
 * fleet.js 离线验证（D9 + D13「船队数值」用例）
 *
 * D13 要求：
 *   · 分数 0   → 触礁数 ≤ 1
 *   · 分数 50  → 触礁数落在 30–60（5 波合计）
 *   · 分数 100 → 触礁数 = 100
 *   · 固定种子跑 1000 次，各分数段均值与解析期望偏差 ≤ 2 条
 *
 * 同时验证 D9.3 那句"长期期望严格等于分数"——实测不成立，本测试把它量化出来。
 *
 * 用法：node tools/test-fleet.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 加载浏览器模块（fleet.js 只依赖全局命名空间）
const sandbox = {};
for (const rel of ['game/js/core/fleet.js']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'globalThis', src)(sandbox, sandbox);
}
const Fleet = sandbox.Siren.Fleet;
const CFG = Fleet.CONFIG;

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? '  — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

/** 跑一局：5 波 × 20 条，每波同一分数（单局内分数是逐句给出的，这里用统一分数近似） */
function runOnce(seed, scorePerPhrase) {
  const rng = Fleet.mulberry32(seed);
  Fleet.resetIds();
  let total = 0;
  const scores = Array.isArray(scorePerPhrase) ? scorePerPhrase : null;
  for (let wave = 0; wave < CFG.PHRASES; wave += 1) {
    const ships = Fleet.spawnWave(rng, wave);
    const sc = scores ? scores[wave] : scorePerPhrase;
    const res = Fleet.resolveWave(ships, sc);
    total += res.wrecked.length;
  }
  return total;
}

// ---------------------------------------------------------------- 1. D13 三条数值用例

console.log('【1】D13「船队数值」用例');
console.log(`    模型：k ~ Uniform(0,1)，触礁条件 k < score/100`);
console.log(`    参数：每波 ${CFG.SHIPS_PER_PHRASE} 条 × ${CFG.PHRASES} 波 = ${CFG.FLEET_TOTAL} 条`);

const N = 1000;

// 分数 0：新模型下是**确定性**保证，不再是"概率上很小"
let zero = [];
for (let i = 0; i < N; i += 1) zero.push(runOnce(1000 + i, 0));
const zeroMax = Math.max(...zero);
check('分数 0 → 触礁数 ≤ 1（实为确定性 0）', zeroMax === 0,
  `${N} 局最大 ${zeroMax} 条（旧模型为 0 条但属概率性；新模型 k<0 恒不成立，必然 0）`);

// 分数 100：同样是确定性保证 —— 这是 B2 的修复点
let full = [];
for (let i = 0; i < N; i += 1) full.push(runOnce(2000 + i, 100));
const fullMin = Math.min(...full);
const full100 = full.filter((v) => v === 100).length;
check('分数 100 → 触礁数 = 100（实为确定性 100）', fullMin === 100,
  `${N} 局最小 ${fullMin}，达到 100 的局数 ${full100}/${N}` +
  (fullMin === 100 ? '（旧模型最小 93、仅 9.8% 达标 → B2 已修复）' : ''));

// 分数 50
let half = [];
for (let i = 0; i < N; i += 1) half.push(runOnce(3000 + i, 50));
const halfMean = half.reduce((a, b) => a + b, 0) / N;
const halfMin = Math.min(...half);
const halfMax = Math.max(...half);
check('分数 50 → 触礁数落在 30–60', halfMean >= 30 && halfMean <= 60,
  `${N} 局均值 ${halfMean.toFixed(1)}，范围 ${halfMin}–${halfMax}`);

// ---------------------------------------------------------------- 2. 与解析期望的偏差

console.log('');
console.log('【2】模拟均值 vs 解析期望（D13 要求偏差 ≤ 2 条）');
console.log('    分数 |  解析期望 |  模拟均值 | 偏差 | 单局范围');
const table = [];
for (const score of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  const analytic = Fleet.expectedWrecked(score);
  let sum = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i += 1) {
    const v = runOnce(5000 + score * 131 + i, score);
    sum += v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  const mean = sum / N;
  const dev = Math.abs(mean - analytic);
  table.push({ score, analytic, mean, dev, lo, hi });
  console.log(
    `    ${String(score).padStart(4)} | ${analytic.toFixed(1).padStart(9)} | ${mean.toFixed(1).padStart(9)} | ` +
    `${dev.toFixed(2).padStart(4)} | ${lo}–${hi}`
  );
}
const worstDev = Math.max(...table.map((r) => r.dev));
check('全部分数段 模拟与解析偏差 ≤ 2 条', worstDev <= 2, `最大偏差 ${worstDev.toFixed(2)} 条`);

// ---------------------------------------------------------------- 3. D9.3 的结论核验

console.log('');
console.log('【3】核验 D9.3「长期期望严格等于分数」');
console.log('    新模型下这条**精确成立**：单条船触礁概率 = score/100，共 100 条 → 期望 = score');
console.log('');
console.log('    每句分 | 一局总船数(实测均值) | 差(船数 - 分数) | 理论σ');
const mismatches = [];
for (const r of table) {
  const gap = r.mean - r.score;
  const sd = Fleet.wreckedStdDev(r.score);
  if (Math.abs(gap) > 1) mismatches.push(r);
  console.log(`    ${String(r.score).padStart(5)} | ${r.mean.toFixed(1).padStart(19)} | ` +
    `${gap >= 0 ? '+' : ''}${gap.toFixed(2).padStart(6)} | ${sd.toFixed(2).padStart(6)}`);
}
check('「期望 = 分数」成立（全部分数段偏差 < 1 条）', mismatches.length === 0,
  mismatches.length ? `${mismatches.length} 段偏差 ≥ 1 条` : '11/11 段通过');
check('低分段不再是死区（10 分也能引来船）', table.find((r) => r.score === 10).mean >= 5,
  `10 分 → ${table.find((r) => r.score === 10).mean.toFixed(1)} 条（旧模型为 0.0 条）`);

// 单调性（这是真正该保证的性质）
let monotone = true;
for (let i = 1; i < table.length; i += 1) {
  if (table[i].mean < table[i - 1].mean - 0.5) monotone = false;
}
check('触礁数随分数单调不减', monotone, '分数越高船越多，符合玩法直觉');

// ---------------------------------------------------------------- 3b. k 的分布性质（新模型）

console.log('');
console.log('【3b】k 的分布性质（有界 + 端点保证）');
const kRng = Fleet.mulberry32(4242);
let kMin = Infinity;
let kMax = -Infinity;
let kSum = 0;
const KN = 50000;
for (let i = 0; i < KN; i += 1) {
  const k = Fleet.sampleK(kRng);
  kMin = Math.min(kMin, k);
  kMax = Math.max(kMax, k);
  kSum += k;
}
const kMean = kSum / KN;
check('k 有界于 (0, 1)', kMin > 0 && kMax < 1, `${KN} 次抽样范围 (${kMin.toExponential(2)}, ${kMax.toFixed(6)})`);
check('k 均值 ≈ 0.5（均匀分布）', Math.abs(kMean - 0.5) < 0.01, `均值 ${kMean.toFixed(4)}`);
check('k 可以取到接近 0 的值（低抗性船存在）', kMin < 0.01, `最小 ${kMin.toExponential(3)}`);
check('k 可以取到接近 1 的值（高抗性船存在）', kMax > 0.99, `最大 ${kMax.toFixed(6)}`);

// 端点保证来自构造，而不是概率：直接构造极端样本验证
const extremeShips = [
  { id: 1, k: Number.MIN_VALUE, wrecked: false, pull: 0 },
  { id: 2, k: 1 - Number.EPSILON, wrecked: false, pull: 0 },
];
const r0 = Fleet.resolveWave(extremeShips.map((s) => ({ ...s })), 0);
check('0 分时连最低抗性船也逃脱（R2 构造保证）', r0.wrecked.length === 0,
  `触礁 ${r0.wrecked.length} / 2`);
const r100 = Fleet.resolveWave(extremeShips.map((s) => ({ ...s })), 100);
check('100 分时连最高抗性船也不能逃脱（R3 构造保证）', r100.wrecked.length === 2,
  `触礁 ${r100.wrecked.length} / 2`);

// 随机性强度（二项分布）
console.log('');
console.log('    随机性强度（一局触礁数的标准差，理论值来自二项分布）：');
for (const s of [20, 50, 80]) {
  const vals = [];
  for (let i = 0; i < 3000; i += 1) vals.push(runOnce(60000 + s * 991 + i, s));
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
  console.log(`      ${String(s).padStart(3)} 分：均值 ${m.toFixed(1)}  σ实测 ${Math.sqrt(varr).toFixed(2)}  ` +
    `σ理论 ${Fleet.wreckedStdDev(s).toFixed(2)}`);
}

// ---------------------------------------------------------------- 4. 终局判定

console.log('');
console.log('【4】终局判定（D9.4）');
const endingCases = [
  [100, 'A'], [99, 'B'], [70, 'B'], [69, 'C'], [20, 'C'], [19, 'D'], [0, 'D'],
];
let endingOk = true;
for (const [n, expect] of endingCases) {
  const got = Fleet.decideEnding(n);
  if (got !== expect) { endingOk = false; check(`N=${n} → 结局 ${expect}`, false, `实际 ${got}`); }
}
check('结局阈值正确（100→A / ≥70→B / ≥20→C / 其余→D）', endingOk);

// ---------------------------------------------------------------- 5. 可复现性与结构

console.log('');
console.log('【5】种子可复现与载荷结构');
const s1 = runOnce(12345, 60);
const s2 = runOnce(12345, 60);
check('同种子同结果（可复现）', s1 === s2, `${s1} vs ${s2}`);

const rngA = Fleet.mulberry32(777);
const rngB = Fleet.mulberry32(777);
Fleet.resetIds();                      // id 是模块级自增计数器，对比前需归零
const waveA = Fleet.spawnWave(rngA, 0);
Fleet.resetIds();
const waveB = Fleet.spawnWave(rngB, 0);
check('同种子生成的船队完全一致（含 id / k / lane / depth / side / delay）',
  JSON.stringify(waveA) === JSON.stringify(waveB),
  `首船 id=${waveA[0].id} k=${waveA[0].k.toFixed(4)} lane=${waveA[0].lane} depth=${waveA[0].depth.toFixed(3)}`);

check('每波 20 条船', waveA.length === 20, `实际 ${waveA.length}`);
check('5 波累计 100 条', CFG.PHASES_OK !== false && CFG.PHRASES * CFG.SHIPS_PER_PHRASE === CFG.FLEET_TOTAL,
  `${CFG.PHRASES} × ${CFG.SHIPS_PER_PHRASE} = ${CFG.FLEET_TOTAL}`);

const lanes = new Set(waveA.map((s) => s.lane));
const sides = new Set(waveA.map((s) => s.side));
const depths = waveA.map((s) => s.depth);
check('lane 覆盖 0–4 共 5 条通道', lanes.size === 5 && Math.min(...lanes) === 0 && Math.max(...lanes) === 4,
  `lane = ${[...lanes].sort().join(',')}`);
check('side 只用 left / right', [...sides].every((s) => s === 'left' || s === 'right'), [...sides].join(','));
check('depth 落在 0–1（D9.2）', depths.every((d) => d >= 0 && d <= 1),
  `范围 ${Math.min(...depths).toFixed(3)}–${Math.max(...depths).toFixed(3)}`);
check('entryDelayMs 落在 0–600（D9.2）',
  waveA.every((s) => s.entryDelayMs >= 0 && s.entryDelayMs < 600),
  `范围 ${Math.min(...waveA.map((s) => s.entryDelayMs))}–${Math.max(...waveA.map((s) => s.entryDelayMs))}`);
check('k 落在有界区间 (0, 1)（新模型）', waveA.every((s) => s.k > 0 && s.k < 1),
  `最小 k=${Math.min(...waveA.map((s) => s.k)).toFixed(6)}，最大 k=${Math.max(...waveA.map((s) => s.k)).toFixed(6)}`);

// k 分布的整体性质已在上面的【3b】小节验证（均值 0.5 / 有界 / 两端可达）

// ---------------------------------------------------------------- 汇总

console.log('');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(2);
}
console.log('fleet.js 离线验证通过');
