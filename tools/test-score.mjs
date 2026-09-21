#!/usr/bin/env node
/**
 * score.js 离线验证（D7 + D13「音频与算法」用例）
 *
 * D13 要求：
 *   · 自唱正确旋律得分 ≥ 80（10 次 ≥ 8 次达成）
 *   · 故意低八度演唱，得分与正常无显著差异        ← P2 的数学基础
 *   · 故意跑调，得分明显下降
 *   · 哼唱（闭口）与真唱得分无显著差异
 *   · 同一次演唱重复打分，结果完全一致（零随机）
 *
 * 用合成"演唱"驱动，不需要麦克风。
 *
 * 用法：node tools/test-score.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const sandbox = {};
for (const rel of [
  'game/js/core/pitch.js',
  'game/js/core/fleet.js',      // melody 依赖 mulberry32
  'game/data/melodies.js',
  'game/js/core/melody.js',
  'game/js/core/score.js',
]) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'globalThis', src)(sandbox, sandbox);
}
const { Pitch, Score, Melody, Fleet, MELODIES, MELODY_INDEX } = sandbox.Siren;
const CFG = Score._config();

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fails.push(`${name}${detail ? '  — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ---------------------------------------------------------------- 合成演唱

const BPM = 92;

/** 由一个音符序列合成"实际演唱"：可加音分偏移、提前/延后、漏音、多音、起始静音 */
function sing(notes, opt = {}) {
  const {
    centsOff = 0,          // 每个音的音分偏移（可为数组或函数）
    onsetShiftMs = 0,      // 整体提前/延后（正 = 晚）
    onsetJitter = 0,       // 每个音的额外抖动
    dropIdx = [],          // 漏掉的音下标
    extra = 0,             // 额外多唱几个音
    humOffsetMs = 0,       // 哼唱：起音能量上升慢，检测到的起音更晚
    octave = 0,            // 整体移调（半音）
    seed = 1,
  } = opt;
  const rng = Fleet.mulberry32(seed);
  const out = [];
  for (let i = 0; i < notes.length; i += 1) {
    if (dropIdx.includes(i)) continue;
    const n = notes[i];
    // 目标音可能来自 _buildTarget（midi + onsetMs/hz）或直接是 MIDI 数组
    const baseMidi = typeof n === 'number' ? n : n.midi;
    const baseOnset = typeof n === 'number' ? 0 : (n.onsetMs !== undefined ? n.onsetMs : (n.startMs || 0));
    const cents = typeof centsOff === 'function'
      ? centsOff(i, n)
      : (Array.isArray(centsOff) ? (centsOff[i] || 0) : centsOff);
    const hz = Pitch.midiToHz(baseMidi + octave) * Math.pow(2, cents / 1200);
    const jit = onsetJitter ? (rng() * 2 - 1) * onsetJitter : 0;
    const onsetMs = baseOnset + onsetShiftMs + jit + humOffsetMs;
    out.push({
      hz,
      midi: Pitch.hzToMidi(hz),
      startMs: onsetMs,
      onsetMs,
      durationMs: typeof n === 'number' ? 326 : (n.durationMs || 326),
    });
  }
  for (let k = 0; k < extra; k += 1) {
    const midi = 60 + Math.floor(rng() * 12);
    out.push({
      hz: Pitch.midiToHz(midi),
      midi,
      startMs: 5000 + k * 300,
      onsetMs: 5000 + k * 300,
      durationMs: 300,
    });
  }
  out.sort((a, b) => a.onsetMs - b.onsetMs);
  return out;
}

// 用《小星星》第一句作目标（7 音，含同音重复，正好考验 D4.3 的同音间隔）
const twinkle = MELODIES[0].phrases[0];
const targetDegrees = { degrees: twinkle.degrees, eighths: twinkle.eighths, scale: 'major' };
const target = Score._buildTarget(
  targetDegrees,
  (d) => Melody.toMidi(d, targetDegrees.scale),
  BPM,
);

console.log('score.js 离线验证');
console.log(`  目标乐句：《小星星》第 1 句，${target.length} 个音`);
console.log(`  音高：${target.map((t) => Pitch.midiToName(t.midi)).join(' ')}`);
console.log(`  权重：contour ${CFG.W_CONTOUR} / pitch ${CFG.W_PITCH} / rhythm ${CFG.W_RHYTHM} / completeness ${CFG.W_COMPLETENESS}`);
console.log('');

// ---------------------------------------------------------------- 1. 完美演唱

console.log('【1】完美演唱应得高分');
const perfect = Score._scoreAttempt(target, sing(target));
check('完美演唱 = 100 分', perfect.score === 100, `得分 ${perfect.score}`);

// 10 次不同"录音"（加轻微抖动）→ D13 要求 ≥8 次 ≥80
let highCount = 0;
const scores = [];
for (let i = 0; i < 10; i += 1) {
  const s = Score._scoreAttempt(target, sing(target, { onsetJitter: 25, centsOff: () => (Math.random() * 2 - 1) * 20, seed: 100 + i }));
  scores.push(s.score);
  if (s.score >= 80) highCount += 1;
}
check('轻微人声抖动下 10 次中 ≥8 次 ≥80 分', highCount >= 8,
  `${highCount}/10 达标，分数：${scores.join(', ')}`);

// ---------------------------------------------------------------- 2. 相对音高（P2）

console.log('');
console.log('【2】相对音高：整体移调不应扣分（P2 的数学基础）');
const normal = Score._scoreAttempt(target, sing(target)).score;
for (const [label, octave, cents] of [
  ['低八度 -12 半音', -12, 0],
  ['高八度 +12 半音', +12, 0],
  ['整体低 2 个半音', -2, 0],
  ['整体高 2 个半音', +2, 0],
  ['低八度 + 20 音分', -12, 20],
]) {
  const s = Score._scoreAttempt(target, sing(target, { octave, centsOff: cents }));
  check(`${label} → 与正常无显著差异`, Math.abs(s.score - normal) <= 5,
    `得分 ${s.score}（正常 ${normal}）`);
}

// 超出补偿上限才该扣分
const off5 = Score._scoreAttempt(target, sing(target, { octave: 5 }));
const off5v = Score._scoreAttemptVerbose(target, sing(target, { octave: 5 }));
check('整体跑 5 个半音 → 补偿 2 半音后仍剩 300 音分，如实扣分', off5.score < normal - 20,
  `得分 ${off5.score}（正常 ${normal}），移调补偿 offset=${off5v.transposition.offset}，pitch 维度 ${off5v.dims.pitch.toFixed(2)}`);
check('跑 5 半音时对齐仍正确（不是全判漏唱）',
  off5v.pairs.every((p) => p.actualIdx !== null),
  `命中 ${off5v.pairs.filter((p) => p.actualIdx !== null).length}/${target.length}`);

// ---------------------------------------------------------------- 3. 跑调应降分

console.log('');
console.log('【3】跑调应明显降分（验证不是"随便唱都给高分"）');
// ⚠️ 注意：系统性跑调（整场都偏低同一个量）会被 D7.2 的移调补偿吃掉——
//    这是 P2「相对音高优先」的设计意图，不是缺陷。只有**超出 ±2 半音补偿上限**
//    的偏差才会如实扣分。真实人声的"30–80 音分偏低"正属于被补偿的范围。
const off60 = Score._scoreAttempt(target, sing(target, { centsOff: 60 }));
const off150 = Score._scoreAttempt(target, sing(target, { centsOff: 150 }));
const off250 = Score._scoreAttempt(target, sing(target, { centsOff: 250 }));
const off400 = Score._scoreAttempt(target, sing(target, { centsOff: 400 }));
const off600 = Score._scoreAttempt(target, sing(target, { centsOff: 600 }));
console.log(`    系统性偏差 +60 音分（一个半音内）→ ${off60.score} 分  ← 被移调补偿吸收，符合 P2`);
console.log(`    系统性偏差 +150 音分 → ${off150.score} 分`);
console.log(`    系统性偏差 +250 音分 → ${off250.score} 分`);
console.log(`    系统性偏差 +400 音分 → ${off400.score} 分`);
console.log(`    系统性偏差 +600 音分 → ${off600.score} 分`);
console.log('    容差边界扫描（补偿上限 200 音分 + Pitch 容差 50 音分 → 约 250 音分处拐点）：');
const scan = [];
for (let cents = 200; cents <= 700; cents += 50) {
  const s = Score._scoreAttempt(target, sing(target, { centsOff: cents })).score;
  scan.push({ cents, s });
  console.log(`      +${String(cents).padStart(3)} 音分 → ${String(s).padStart(3)} 分`);
}
const monotone = scan.every((r, i) => i === 0 || r.s <= scan[i - 1].s + 1e-9);
check('补偿上限附近（≤250 音分）系统性偏差不扣分（P2 + 容差）',
  off60.score === 100 && off150.score === 100 && off250.score === 100,
  `${off60.score} / ${off150.score} / ${off250.score}`);
check('超出补偿上限 200 音分后分数单调不增', monotone,
  scan.map((r) => `${r.cents}:${r.s}`).join(' '));
check('严重跑调大幅扣分（+600 音分）', off600.score <= 70, `${off600.score}`);

// 随机音准抖动（不是系统性偏差，无法被移调补偿吸收）
const wobble = Score._scoreAttempt(target, sing(target, {
  centsOff: (i) => (i % 2 === 0 ? 200 : -200),
  seed: 5,
})).score;
check('忽高忽低（±200 音分交替）→ 明显扣分', wobble < normal - 15, `${wobble}（正常 ${normal}）`);

// 音型轮廓唱反
const inverted = target.map((t, i) => ({ ...t, midi: i === 0 ? t.midi : 2 * target[0].midi - t.midi }));
const invScore = Score._scoreAttempt(target, sing(inverted)).score;
check('音型轮廓反向 → 轮廓维度受损', invScore < normal - 15, `得分 ${invScore}（正常 ${normal}）`);

// ---------------------------------------------------------------- 4. 漏音 / 多音

console.log('');
console.log('【4】漏音与多音');
const drop1 = Score._scoreAttempt(target, sing(target, { dropIdx: [3] })).score;
const drop3 = Score._scoreAttempt(target, sing(target, { dropIdx: [1, 3, 5] })).score;
console.log(`    漏 1 个音 → ${drop1} 分`);
console.log(`    漏 3 个音 → ${drop3} 分`);
check('漏 1 个音扣分但不致命', drop1 < normal && drop1 >= 60, `${drop1}`);
check('漏 3 个音扣分更多', drop3 < drop1, `${drop3} < ${drop1}`);

const extra1 = Score._scoreAttempt(target, sing(target, { extra: 1 })).score;
const extra5 = Score._scoreAttempt(target, sing(target, { extra: 5 })).score;
console.log(`    多唱 1 个音 → ${extra1} 分`);
console.log(`    多唱 5 个音 → ${extra5} 分`);
check('多唱宽容（1 个音几乎不扣）', extra1 >= 85, `${extra1}`);
check('多唱 5 个音惩罚有上限（不超过 0.3）', extra5 >= normal - 35, `${extra5}`);

// ---------------------------------------------------------------- 5. 节奏

console.log('');
console.log('【5】节奏：允许整体慢/快半拍，只惩罚参差不齐（D7.3）');
const late = Score._scoreAttempt(target, sing(target, { onsetShiftMs: 200 })).score;
const early = Score._scoreAttempt(target, sing(target, { onsetShiftMs: -200 })).score;
check('整体晚 200ms → 不显著扣分（减去中位数偏移）', Math.abs(late - normal) <= 5, `${late}`);
check('整体早 200ms → 不显著扣分', Math.abs(early - normal) <= 5, `${early}`);

// 参差不齐：确定性交替 ±400ms（超出 RHYTHM_TOL_MS=120 / 达到 RHYTHM_ZERO_MS=400）
// 用确定性模式而非随机抖动：随机抖动有一半样本落在容差内，测不出边界；
// 且"整体慢半拍不算错"是 D7.3 的设计意图——随机抖动配上中位数偏移会显得过于宽容。
const unevenTake = sing(target).map((x, i) => {
  const shift = i % 2 === 0 ? -400 : 400;
  return { ...x, onsetMs: x.onsetMs + shift, startMs: x.startMs + shift };
});
const unevenV = Score._scoreAttemptVerbose(target, unevenTake);
check('忽早忽晚（±400ms 交替）→ 节奏维度明显受损',
  unevenV.dims.rhythm < 0.6,
  `总分 ${unevenV.score}，rhythm 维度 ${unevenV.dims.rhythm.toFixed(3)}，pitch ${unevenV.dims.pitch.toFixed(3)}`);

// ---------------------------------------------------------------- 6. 哼唱（D6 + Q2）

console.log('');
console.log('【6】哼唱与真唱同分（D6 起音阈值 60%，Q2 决策）');
const hum = Score._scoreAttempt(target, sing(target, { humOffsetMs: 80 })).score;
check('哼唱（起音晚 80ms）与真唱无显著差异', Math.abs(hum - normal) <= 5,
  `哼唱 ${hum} vs 真唱 ${normal}`);
const humLate = Score._scoreAttempt(target, sing(target, { humOffsetMs: 150 })).score;
check('哼唱起音晚 150ms 仍无惩罚', Math.abs(humLate - normal) <= 5, `${humLate}`);

// ---------------------------------------------------------------- 6b. 逐音档位（v1.1.0 / 契约 C5）

console.log('');
console.log('【6b】逐音档位判定 judgeNotes（v1.1.0 / 契约 C5）');

const shift = (notes, cents, onsetMs, octave) => notes.map((n) => {
  const hz = Pitch.midiToHz(n.midi + (octave || 0)) * Math.pow(2, cents / 1200);
  return {
    hz: hz,
    midi: Pitch.hzToMidi(hz),
    startMs: n.onsetMs + onsetMs,
    onsetMs: n.onsetMs + onsetMs,
    durationMs: n.durationMs,
  };
});
const tiersOf = (actual) => Score._judgeNotes(target, actual).map((e) => e.tier);
const allTier = (arr, t) => arr.every((x) => x === t);

const jPerfect = tiersOf(shift(target, 0, 0, 0));
check('完美演唱 → 全部 perfect', allTier(jPerfect, 'perfect'), jPerfect.join(', '));

const jLowOct = tiersOf(shift(target, 0, 0, -12));
check('低八度演唱 → 全部 perfect（P2 相对音高）', allTier(jLowOct, 'perfect'), jLowOct.join(', '));
const jHighOct = tiersOf(shift(target, 0, 0, 12));
check('高八度演唱 → 全部 perfect', allTier(jHighOct, 'perfect'), jHighOct.join(', '));

const jCents30 = tiersOf(shift(target, 30, 0, 0));
check('偏低 30 音分（容差内）→ 全部 perfect', allTier(jCents30, 'perfect'), jCents30.join(', '));

const jLate250 = tiersOf(shift(target, 0, 250, 0));
check('整体晚 250ms → 降为 good', allTier(jLate250, 'good'), jLate250.join(', '));

const jCents150 = tiersOf(shift(target, 150, 0, 0));
check('偏低 150 音分 → 降为 good', allTier(jCents150, 'good'), jCents150.join(', '));

const jCents400 = tiersOf(shift(target, 400, 0, 0));
check('偏低 400 音分 → 全部 miss', allTier(jCents400, 'miss'), jCents400.join(', '));

// 漏音
const dropped = shift(target, 0, 0, 0).filter((_, i) => i !== 3);
const jDrop = Score._judgeNotes(target, dropped);
check('漏唱第 4 个音 → 该音判 miss，其余仍 perfect',
  jDrop[3].tier === 'miss' && jDrop[3].actualMidi !== null || jDrop[3].tier === 'miss',
  jDrop.map((e) => e.tier).join(', '));

// 载荷完整性
const jd0 = Score._judgeNotes(target, shift(target, 0, 0, 0))[0];
check('判定结果含 index/targetMidi/actualMidi/accuracy/tier/t（契约 C5）',
  'index' in jd0 && 'targetMidi' in jd0 && 'actualMidi' in jd0 &&
  'accuracy' in jd0 && 'tier' in jd0 && 't' in jd0,
  JSON.stringify(jd0));
check('accuracy 落在 0–1', jd0.accuracy >= 0 && jd0.accuracy <= 1, String(jd0.accuracy));
check('只判单个音（onlyIndex）时只返回一条',
  Score._judgeNotes(target, shift(target, 0, 0, 0), { onlyIndex: 2 }).length === 1);

// 档位与总分同源：全 perfect 的演唱，四维总分也应当很高
const jScore = Score._scoreAttempt(target, shift(target, 0, 0, 0)).score;
check('档位与总分同源（全 perfect → 总分也高）', jScore >= 95,
  `全 perfect 时总分 ${jScore}`);

// ---------------------------------------------------------------- 7. 零随机 / 确定性

console.log('');
console.log('【7】同一次演唱重复打分结果完全一致（D13 要求）');
const take = sing(target, { onsetJitter: 30, centsOff: 25, seed: 7 });
const r1 = Score._scoreAttempt(target, take).score;
const r2 = Score._scoreAttempt(target, take).score;
const r3 = Score._scoreAttempt(target, take).score;
check('重复打分完全一致', r1 === r2 && r2 === r3, `${r1} / ${r2} / ${r3}`);

// 顺序无关性：打分不应依赖调用历史
const other = Score._scoreAttempt(target, sing(target, { centsOff: 200 }));
const r4 = Score._scoreAttempt(target, take).score;
check('打分无状态（穿插其它输入后结果不变）', r4 === r1, `${r4} vs ${r1}`);

// ---------------------------------------------------------------- 8. 接口收窄（D7.1 / P4）

console.log('');
console.log('【8】接口只返回 { score }（D7.1 硬约束）');
const keys = Object.keys(perfect);
check('返回值只有 score 一个键', keys.length === 1 && keys[0] === 'score', `实际键：${keys.join(', ')}`);
check('不返回维度拆解', !('contour' in perfect) && !('pitch' in perfect) && !('rhythm' in perfect) && !('completeness' in perfect));
check('不返回任何话术字符串', typeof perfect.score === 'number' && !JSON.stringify(perfect).match(/[\u4e00-\u9fa5]/),
  JSON.stringify(perfect));

// ---------------------------------------------------------------- 9. 兜底模式（D10）

console.log('');
console.log('【9】兜底模式：只用 Rhythm，权重 100%（D10）');
const fallbackPerfect = Score._scoreRhythmOnly(target, sing(target));
const fallbackLate = Score._scoreRhythmOnly(target, sing(target, { onsetShiftMs: 200 }));
const fallbackUneven = Score._scoreRhythmOnly(target, unevenTake);
console.log(`    完美打拍 → ${fallbackPerfect.score} 分`);
console.log(`    整体晚 200ms → ${fallbackLate.score} 分`);
console.log(`    忽早忽晚 ±400ms → ${fallbackUneven.score} 分`);
check('兜底模式完美打拍 = 100（能拿满分，D10 要求兜底不残疾）', fallbackPerfect.score === 100, `${fallbackPerfect.score}`);
check('兜底模式整体偏移不扣分', Math.abs(fallbackLate.score - 100) <= 3, `${fallbackLate.score}`);
check('兜底模式参差不齐扣分', fallbackUneven.score < 90, `${fallbackUneven.score}`);

// ---------------------------------------------------------------- 10. 旋律生成约束（D8）

console.log('');
console.log('【10】旋律生成约束（D8）与熟曲库');
const built = Melody.buildPhrases(4821);
check('生成 5 个乐句', built.phrases.length === 5, `实际 ${built.phrases.length}`);
check('音数曲线 3/4/5/6/7', built.phrases.map((p) => p.degrees.length).join(',') === '3,4,5,6,7',
  built.phrases.map((p) => p.degrees.length).join(','));
check('同种子可复现', JSON.stringify(Melody.buildPhrases(4821)) === JSON.stringify(built));
check('不同种子不同旋律', JSON.stringify(Melody.buildPhrases(999)) !== JSON.stringify(built));

let bossOriginal = true;
for (let i = 0; i < 200; i += 1) {
  const p = Melody.buildPhrases(i).phrases[4];
  if (p.familiar) bossOriginal = false;
}
check('Boss 乐句（第 5 句）必用原创', bossOriginal, '200 个种子均无熟曲');

// 原创句的五声音阶与进行约束
let allOriginalOk = true;
const violations = [];
for (let i = 0; i < 300; i += 1) {
  const ps = Melody.buildPhrases(i).phrases;
  for (const p of ps) {
    if (p.familiar) continue;
    // 首音 ∈ {0,2}
    if (p.degrees[0] !== 0 && p.degrees[0] !== 2) { allOriginalOk = false; violations.push(`首音 ${p.degrees[0]}`); }
    // 末音 % 5 === 0
    const last = p.degrees[p.degrees.length - 1];
    if (((last % 5) + 5) % 5 !== 0) { allOriginalOk = false; violations.push(`末音 ${last}`); }
    // 相邻级差 ≤ 5（Boss 允许 5）
    for (let k = 1; k < p.degrees.length; k += 1) {
      if (Math.abs(p.degrees[k] - p.degrees[k - 1]) > 5) { allOriginalOk = false; violations.push(`跳进 ${Math.abs(p.degrees[k] - p.degrees[k - 1])}`); }
    }
    // 不得连续 3 个同方向
    let run = 0, prevDir = 0;
    for (let k = 1; k < p.degrees.length; k += 1) {
      const d = Math.sign(p.degrees[k] - p.degrees[k - 1]);
      if (d !== 0 && d === prevDir) run += 1; else run = 1;
      prevDir = d;
      if (run >= 3) { allOriginalOk = false; violations.push('连续 3 个同方向'); }
    }
    // 节奏必须落在八分格
    if (!p.eighths.every((e) => Number.isInteger(e) && e > 0)) { allOriginalOk = false; violations.push('节奏非整数格'); }
  }
}
check('原创句满足 D8 全部约束（300 种子）', allOriginalOk,
  allOriginalOk ? '首音/末音/跳进/同方向/八分格 全部通过' : `违规样例：${[...new Set(violations)].slice(0, 5).join(' , ')}`);

check('熟曲库仅含公有领域', MELODIES.every((m) => m.publicDomain === true), `${MELODIES.length} 首`);
check('熟曲库每条都有 source', MELODIES.every((m) => typeof m.source === 'string' && m.source.length > 4),
  MELODIES.map((m) => m.title).join(' / '));
check('熟曲库不含《生日快乐》或 20 世纪后作品',
  !MELODIES.some((m) => /生日快乐|Happy Birthday/i.test(m.title)),
  MELODIES.map((m) => m.title).join(' / '));
check('按音数分桶索引存在', Object.keys(MELODY_INDEX).length > 0,
  Object.keys(MELODY_INDEX).sort((a, b) => a - b).map((k) => `${k}音×${MELODY_INDEX[k].length}`).join(' '));

// 歌名揭晓规则（D8：仅熟曲且 ≥60 分）
const familiarPhrase = { familiar: true, title: '小星星' };
check('熟曲 + 60 分 → 揭晓歌名', Melody.shouldRevealTitle(familiarPhrase, 60) === true);
check('熟曲 + 59 分 → 不揭晓', Melody.shouldRevealTitle(familiarPhrase, 59) === false);
check('原创 + 100 分 → 不揭晓', Melody.shouldRevealTitle({ familiar: false, title: null }, 100) === false);

// ---------------------------------------------------------------- 汇总

console.log('');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(2);
}
console.log('score.js 离线验证通过');
