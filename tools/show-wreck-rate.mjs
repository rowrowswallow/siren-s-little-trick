#!/usr/bin/env node
/**
 * 触礁率曲线查看器（调参用）
 *
 * 当前模型（2026-09 起，见 docs/规格问题清单.md B1/B2）：
 *   k ~ Uniform(0,1) 有界；触礁条件 k < score/100
 *   → 单条船触礁概率恰好等于 score/100
 *   → score=0 恒全逃、score=100 恒全触礁（构造保证，非概率）
 *   → D9.3「长期期望严格等于分数」精确成立
 *
 * 改 fleet.js 的判定曲线后跑这个脚本，立刻能看到整条曲线怎么动。
 * 用法：node tools/show-wreck-rate.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sb = {};
new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'game/js/core/fleet.js'), 'utf8'))(sb, sb);
const F = sb.Siren.Fleet;
const C = F.CONFIG;

function runOnce(rng, score) {
  let total = 0;
  for (let w = 0; w < C.PHRASES; w += 1) {
    const ships = F.spawnWave(rng, w);
    total += F.resolveWave(ships, score).wrecked.length;
  }
  return total;
}

console.log('当前触礁率模型');
console.log('');
console.log('  判定式:  k < score/100        （k ~ Uniform(0,1)，有界）');
console.log('  每波 ' + C.SHIPS_PER_PHRASE + ' 条 x ' + C.PHRASES + ' 波 = ' + C.FLEET_TOTAL + ' 条');
console.log('  k 取值区间: (' + C.K_MIN + ', ' + C.K_MAX + ')');
console.log('');
console.log('  性质: 单条船触礁概率 = score/100，所以一局期望触礁数 = score');
console.log('        单局波动服从二项分布 B(100, score/100)');
console.log('');

console.log('=== 一局曲线 ===');
console.log('每句分 | 单条触礁率 | 一局期望 | 理论σ | 实测范围(2000局)');
for (let S = 0; S <= 100; S += 10) {
  const p = S / 100;
  let sum = 0;
  let lo = 999;
  let hi = -1;
  for (let i = 0; i < 2000; i += 1) {
    const v = runOnce(F.mulberry32(50000 + S * 977 + i), S);
    sum += v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  console.log(
    String(S).padStart(6) + ' | ' + (p * 100).toFixed(0).padStart(9) + '% | ' +
    F.expectedWrecked(S).toFixed(1).padStart(8) + ' | ' +
    F.wreckedStdDev(S).toFixed(2).padStart(5) + ' | ' + (lo + '-' + hi).padStart(12)
  );
}
console.log('');

console.log('=== D13 三条数值用例 ===');
for (const [S, want] of [[0, '<=1'], [50, '30~60'], [100, '=100']]) {
  let sum = 0;
  let lo = 999;
  let hi = -1;
  for (let i = 0; i < 2000; i += 1) {
    const v = runOnce(F.mulberry32(90000 + S * 31 + i), S);
    sum += v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const mean = sum / 2000;
  let ok = 'OK';
  if (S === 0 && mean > 1) ok = 'FAIL';
  if (S === 50 && (mean < 30 || mean > 60)) ok = 'FAIL';
  if (S === 100 && (lo !== 100 || hi !== 100)) ok = 'FAIL';
  console.log('  ' + String(S).padStart(3) + ' 分 -> 均值 ' + mean.toFixed(1).padStart(5) +
    '  范围 ' + (lo + '-' + hi).padStart(9) + '   (要求 ' + want + ')  ' + ok);
}
console.log('');

console.log('=== 结局分布（A: 100条 / B: >=70 / C: >=20 / D: <20）===');
for (const S of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  const cnt = { A: 0, B: 0, C: 0, D: 0 };
  for (let i = 0; i < 2000; i += 1) {
    const v = runOnce(F.mulberry32(700000 + S * 17 + i), S);
    if (v >= 100) cnt.A += 1;
    else if (v >= 70) cnt.B += 1;
    else if (v >= 20) cnt.C += 1;
    else cnt.D += 1;
  }
  console.log('  ' + String(S).padStart(3) + ' 分 -> A ' + (cnt.A / 20).toFixed(0).padStart(3) + '%  B ' +
    (cnt.B / 20).toFixed(0).padStart(3) + '%  C ' + (cnt.C / 20).toFixed(0).padStart(3) + '%  D ' +
    (cnt.D / 20).toFixed(0).padStart(3) + '%');
}
console.log('');
console.log('端点由构造保证，不依赖运气：');
console.log('  score=0   -> k < 0 恒不成立 -> 必然 0 条（连最低抗性船也逃）');
console.log('  score=100 -> k < 1 恒成立   -> 必然 100 条（连最高抗性船也留）');
console.log('所以满分会稳定触发结局 A。');
