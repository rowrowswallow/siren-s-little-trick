/* 塞壬的小把戏 —— 后端：score.js（四维打分）
 *
 * 依据：02-后端开发规格书 D7
 *   · 唯一对外接口 _scoreAttempt(target, actual) —— 只返回 { score }
 *   · 权重：Contour 0.30 / Pitch 0.35 / Rhythm 0.25 / Completeness 0.10
 *   · D7.2 全局移调补偿：八度折叠到 [-6,+6] 半音后取中位数，补偿上限 ±2 半音
 *   · D7.3 四维算法；D7.4 已删除诊断话术（本文件不返回任何中文）
 *
 * ⚠️ 硬约束（D7.1）：对外函数只返回 { score }。
 *    绝不返回维度拆解——返回了 UI 迟早会显示出来，P4 承诺就形同虚设。
 *    维度分只在内部与离线验证里可见（tools/test-score.mjs、game/js/lab/）。
 *
 * 本文件不触碰 document / window 渲染（D0 硬规则 1）。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};
  var Pitch = Siren.Pitch;

  // ---------------------------------------------------------------- 参数（D7.3 / D12）

  var CFG = {
    W_CONTOUR: 0.30,
    W_PITCH: 0.35,
    W_RHYTHM: 0.25,
    W_COMPLETENESS: 0.10,

    CENTS_TOLERANT: 50,        // ±50 音分内满分（D12 可调）
    CENTS_ZERO: 200,           // 200 音分以上零分

    RHYTHM_TOL_MS: 120,        // 120ms 内满分（D12 可调）
    RHYTHM_ZERO_MS: 400,       // 400ms 以上零分

    MAX_TRANSPOSE_SEMITONES: 2,// D7.2 补偿上限
    EXTRA_NOTE_PENALTY_MAX: 0.3,
    EXTRA_NOTE_PENALTY_PER: 0.1
  };

  // ---------------------------------------------------------------- 工具

  function clamp01(x) {
    if (!isFinite(x)) return 0;
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  /** 线性衰减：tol 内满分，zero 外零分 */
  function linearScore(value, tol, zero) {
    var v = Math.abs(value);
    if (v <= tol) return 1;
    if (v >= zero) return 0;
    return 1 - (v - tol) / (zero - tol);
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** 八度折叠到 [-6, +6] 半音 */
  function foldOctave(semitones) {
    var x = semitones % 12;
    if (x > 6) x -= 12;
    if (x < -6) x += 12;
    return x;
  }

  /**
   * 音分差折叠到 [0, 600]（八度无关）。
   *
   * ⚠️ 必须用 `((x % 1200) + 1200) % 1200`，**不能只写 `x % 1200`**：
   *    JS 的 % 对负数返回负余数，于是"低八度演唱"会得到负数音分，
   *    在取最小值配对时负数永远胜出，把真正正确的候选挤掉（实测把 perfect 判成了 miss）。
   *    `align()` 里原本写对，`judgeNotes()` 里漏了这一步，故统一抽到这里。
   */
  function foldCents(cents) {
    var f = ((cents % 1200) + 1200) % 1200;
    if (f > 600) f = 1200 - f;
    return f;
  }

  /** 取音符的起音时刻（兼容 onsetMs / startMs 两种字段名） */
  function onsetOf(n) {
    if (n.onsetMs !== undefined) return n.onsetMs;
    if (n.startMs !== undefined) return n.startMs;
    return 0;
  }

  // ---------------------------------------------------------------- D7.2 移调补偿

  /**
   * 全局移调补偿（P2 的数学基础）
   *
   * ⚠️ 两个容易搞混的量，必须分开：
   *
   *   (a) `estimateTranspose` 给出的"对齐用移调量" —— 范围 ±12，目的是让 DTW 正确配对。
   *       它回答"哪个音对应哪个音"，与实际给玩家补偿多少无关，所以不能在那里夹上限。
   *
   *   (b) 本函数给出的"补偿量" —— **必须遵守 D7.2 的 ±2 半音上限**。
   *       超出部分如实计入 Pitch，否则等于"跑多少调都白送"。
   *       实测教训：曾把 (a) 直接当 (b) 用，结果整体跑 3 个半音仍拿 86 分，
   *       而 D7.2 要求这种情况必须扣分。
   *
   * 拆法：
   *   · octaveShift —— 整八度差异，**完全补偿**（这是 P2「低八度不扣分」的实现）
   *   · fineOffset  —— ±2 半音内的整体跑调补偿，超出部分不补，留给 Pitch 维度如实扣分
   */
  function computeTransposition(target, actual, pairs) {
    var diffs = [];
    for (var i = 0; i < pairs.length; i += 1) {
      var p = pairs[i];
      if (p.actualIdx === null) continue;
      diffs.push(actual[p.actualIdx].midi - target[p.targetIdx].midi);
    }
    if (!diffs.length) {
      return { offset: 0, octaveShift: 0, fineOffset: 0, rawMedian: 0, rawFineMedian: 0 };
    }

    var folded = diffs.map(foldOctave);
    var median = medianOf(folded);

    // D7.2 硬上限：超出 ±2 半音的部分不补偿
    var fineOffset = Math.max(-CFG.MAX_TRANSPOSE_SEMITONES,
      Math.min(CFG.MAX_TRANSPOSE_SEMITONES, median));

    var rawMedian = medianOf(diffs);
    // 整八度部分：rawMedian 去掉折叠后的部分，再取整到 12 的倍数（完全补偿）
    var octaveShift = 12 * Math.round((rawMedian - median) / 12);

    return {
      offset: octaveShift + fineOffset,
      octaveShift: octaveShift,
      fineOffset: fineOffset,
      rawMedian: rawMedian,
      rawFineMedian: median     // 诊断用：未夹上限前的细调量
    };
  }

  // ---------------------------------------------------------------- 对齐

  /**
   * 粗对齐代价（只算 DTW 终值，不回溯）——供移调搜索比较优劣。
   * 插入 / 删除代价取 200（与 CENTS_ZERO 同量级）。
   */
  function coarseAlignCost(target, actual, shift) {
    var n = target.length;
    var m = actual.length;
    if (!n || !m) return 0;
    var GAP = CFG.CENTS_ZERO;
    var prev = new Array(m + 1);
    var cur = new Array(m + 1);
    for (var j = 0; j <= m; j += 1) prev[j] = j * GAP;
    for (var i = 1; i <= n; i += 1) {
      cur[0] = i * GAP;
      for (var k = 1; k <= m; k += 1) {
        var cents = Math.abs(Pitch.centsBetween(actual[k - 1].hz, target[i - 1].hz) - shift * 100);
        var folded = cents % 1200;
        if (folded > 600) folded = 1200 - folded;
        var c = folded + Math.abs(onsetOf(actual[k - 1]) - onsetOf(target[i - 1])) * 0.35;
        var diag = prev[k - 1] + c;
        var up = prev[k] + GAP;
        var left = cur[k - 1] + GAP;
        cur[k] = Math.min(diag, up, left);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
  }

  /**
   * 估计整体移调——供 DTW 对齐使用。
   *
   * ⚠️ 不能只取 rawMedian 做八度推算：整体跑 5 个半音时 rawMedian=5、折叠后 median=5，
   *    5 − 5 = 0 → 推断出 0 个八度 → 补偿被夹成 0，于是每个音仍差 500 音分、
   *    全部越界判为漏唱（实测总分 30）。
   *    改为在 [-12, +12] 上穷举搜索使对齐代价最小的全局移调，稳健且与八度无关。
   */
  function estimateTranspose(target, actual) {
    if (!target.length || !actual.length) return 0;
    var bestShift = 0;
    var bestCost = Infinity;
    for (var shift = -12; shift <= 12; shift += 1) {
      var cost = coarseAlignCost(target, actual, shift);
      // 同样代价时优先选绝对值小的（少补偿更保守）
      if (cost < bestCost - 1e-9 ||
          (Math.abs(cost - bestCost) < 1e-9 && Math.abs(shift) < Math.abs(bestShift))) {
        bestCost = cost;
        bestShift = shift;
      }
    }
    return bestShift;
  }

  /**
   * 目标音符序列 ↔ 实际音符序列的 DTW 对齐。
   *
   * ⚠️ 代价函数里**先扣掉整体移调补偿**再比音高：对齐要回答的是"哪个音对应哪个音"，
   *    不是"唱得准不准"。曾经的实现只比绝对音高，导致整体跑 2 个半音时
   *    每个音代价约 200 音分、越过命中阈值，7 个音全被判成漏唱。
   *
   * @param {number} [transpose] 整体移调（半音），由 estimateTranspose 给出
   * @returns {Array<{targetIdx:number, actualIdx:number|null}>}
   */
  function align(target, actual, transpose) {
    var shift = transpose || 0;
    var n = target.length;
    var m = actual.length;
    var pairs = [];
    for (var t0 = 0; t0 < n; t0 += 1) pairs.push({ targetIdx: t0, actualIdx: null });
    if (!n || !m) return pairs;

    var TIME_TO_CENTS = 0.35;   // 100ms 起音差 ≈ 35 音分当量
    var MATCH_CENTS = CFG.CENTS_ZERO;

    function pitchCents(i, j) {
      var cents = Math.abs(Pitch.centsBetween(actual[j].hz, target[i].hz) - shift * 100);
      var folded = cents % 1200;
      if (folded > 600) folded = 1200 - folded;
      return folded;
    }

    function cost(i, j) {
      return pitchCents(i, j) + Math.abs(onsetOf(actual[j]) - onsetOf(target[i])) * TIME_TO_CENTS;
    }

    var INF = 1e12;
    var D = [];
    for (var a = 0; a <= n; a += 1) D.push(new Array(m + 1).fill(INF));
    D[0][0] = 0;
    for (var x = 1; x <= n; x += 1) {
      for (var y = 1; y <= m; y += 1) {
        D[x][y] = cost(x - 1, y - 1) + Math.min(D[x - 1][y - 1], D[x - 1][y], D[x][y - 1]);
      }
    }

    var ai = n;
    var bj = m;
    while (ai > 0 && bj > 0) {
      var diag = D[ai - 1][bj - 1];
      var up = D[ai - 1][bj];
      var left = D[ai][bj - 1];
      var best = Math.min(diag, up, left);
      if (best === diag) {
        if (pitchCents(ai - 1, bj - 1) <= MATCH_CENTS) pairs[ai - 1].actualIdx = bj - 1;
        ai -= 1;
        bj -= 1;
      } else if (best === up) {
        ai -= 1;
      } else {
        bj -= 1;
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------- D7.3 四维

  /**
   * Contour：方向序列编辑距离。
   * Math.sign(Math.round(delta / 2)) 把微差归为"平"（D7.3）。
   */
  function directionSequence(midis) {
    var dirs = [];
    for (var i = 1; i < midis.length; i += 1) {
      dirs.push(Math.sign(Math.round((midis[i] - midis[i - 1]) / 2)));
    }
    return dirs;
  }

  function editDistance(a, b) {
    var n = a.length;
    var m = b.length;
    if (!n && !m) return 0;
    var prev = new Array(m + 1);
    var cur = new Array(m + 1);
    for (var j = 0; j <= m; j += 1) prev[j] = j;
    for (var i = 1; i <= n; i += 1) {
      cur[0] = i;
      for (var k = 1; k <= m; k += 1) {
        var sub = prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1);
        cur[k] = Math.min(sub, prev[k] + 1, cur[k - 1] + 1);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
  }

  function scoreContour(targetMidis, actualMidis) {
    if (actualMidis.length < 2) return targetMidis.length < 2 ? 1 : 0;
    var dt = directionSequence(targetMidis);
    var da = directionSequence(actualMidis);
    if (!dt.length) return 1;
    return clamp01(1 - editDistance(dt, da) / dt.length);
  }

  function scorePitch(target, actual, pairs, offset) {
    var sum = 0;
    var count = 0;
    for (var i = 0; i < pairs.length; i += 1) {
      var p = pairs[i];
      count += 1;
      if (p.actualIdx === null) { sum += 0; continue; }   // 漏唱记 0 分并计入分母
      var expectHz = Pitch.midiToHz(target[p.targetIdx].midi + offset);
      var cents = Pitch.centsBetween(actual[p.actualIdx].hz, expectHz);
      sum += linearScore(cents, CFG.CENTS_TOLERANT, CFG.CENTS_ZERO);
    }
    return count ? clamp01(sum / count) : 0;
  }

  function scoreRhythm(target, actual, pairs) {
    var diffs = [];
    for (var i = 0; i < pairs.length; i += 1) {
      var p = pairs[i];
      if (p.actualIdx === null) continue;
      diffs.push(onsetOf(actual[p.actualIdx]) - onsetOf(target[p.targetIdx]));
    }
    if (!diffs.length) return 0;

    // D7.3：先减去中位数偏移（允许整体慢半拍，只惩罚参差不齐）
    var med = medianOf(diffs);
    var sum = 0;
    for (var j = 0; j < diffs.length; j += 1) {
      sum += linearScore(diffs[j] - med, CFG.RHYTHM_TOL_MS, CFG.RHYTHM_ZERO_MS);
    }
    return clamp01(sum / diffs.length);
  }

  function scoreCompleteness(target, actual, pairs) {
    var hit = 0;
    for (var i = 0; i < pairs.length; i += 1) if (pairs[i].actualIdx !== null) hit += 1;
    var hitRate = target.length ? hit / target.length : 0;

    var extra = actual.length - hit;
    if (extra < 0) extra = 0;
    var penalty = Math.min(CFG.EXTRA_NOTE_PENALTY_MAX, extra * CFG.EXTRA_NOTE_PENALTY_PER);
    return clamp01(hitRate - penalty);
  }

  // ---------------------------------------------------------------- 目标构建

  /**
   * 把旋律定义转成打分子系统需要的目标音符序列。
   * @param {Object} melody { degrees, eighths }
   * @param {Function} degreeToMidi 由 melody.js 提供（区分五声 / 大调）
   * @param {number} bpm
   */
  function buildTarget(melody, degreeToMidi, bpm) {
    var eighthMs = 60000 / bpm / 2;
    var notes = [];
    var cursor = 0;
    for (var i = 0; i < melody.degrees.length; i += 1) {
      var midi = degreeToMidi(melody.degrees[i]);
      notes.push({
        targetIdx: i,
        midi: midi,
        hz: Pitch.midiToHz(midi),
        onsetMs: cursor,
        startMs: cursor,
        durationMs: melody.eighths[i] * eighthMs
      });
      cursor += melody.eighths[i] * eighthMs;
    }
    return notes;
  }

  // ---------------------------------------------------------------- 打分主流程

  function scoreAttempt(target, actual) {
    // 先估计整体移调，再带着补偿做对齐（对齐回答"哪个音对应哪个音"）
    var transpose = estimateTranspose(target, actual);
    var pairs = align(target, actual, transpose);
    var tr = computeTransposition(target, actual, pairs);

    var contour = scoreContour(
      target.map(function (x) { return x.midi; }),
      actual.map(function (x) { return x.midi; })
    );
    var pitch = scorePitch(target, actual, pairs, tr.offset);
    var rhythm = scoreRhythm(target, actual, pairs);
    var completeness = scoreCompleteness(target, actual, pairs);

    var total = 100 * (
      CFG.W_CONTOUR * contour +
      CFG.W_PITCH * pitch +
      CFG.W_RHYTHM * rhythm +
      CFG.W_COMPLETENESS * completeness
    );

    return { score: Math.round(total) };
  }

  /**
   * 内部诊断接口——**仅供离线验证与开发工具使用**
   * （tools/test-score.mjs / tools/test-hum.mjs / game/js/lab/）。
   * 绝不在 window.Siren 上暴露（见 index.js）。
   */
  function _scoreAttemptVerbose(target, actual) {
    var transpose = estimateTranspose(target, actual);
    var pairs = align(target, actual, transpose);
    var tr = computeTransposition(target, actual, pairs);
    var contour = scoreContour(
      target.map(function (x) { return x.midi; }),
      actual.map(function (x) { return x.midi; })
    );
    var pitch = scorePitch(target, actual, pairs, tr.offset);
    var rhythm = scoreRhythm(target, actual, pairs);
    var completeness = scoreCompleteness(target, actual, pairs);
    return {
      score: scoreAttempt(target, actual).score,
      dims: { contour: contour, pitch: pitch, rhythm: rhythm, completeness: completeness },
      transposition: tr,
      estimate: transpose,
      pairs: pairs
    };
  }

  /** 兜底模式：只用 Rhythm 算法，权重 100%（D10） */
  function scoreRhythmOnly(target, actual) {
    var transpose = estimateTranspose(target, actual);
    var pairs = align(target, actual, transpose);
    return { score: Math.round(100 * scoreRhythm(target, actual, pairs)) };
  }

  // ---------------------------------------------------------------- v1.1.0 逐音档位

  /**
   * 逐音档位阈值（PRD §7.5.1.1 / 契约 C5）。
   *
   * ⚠️ 刻意复用打分器的容差参数，让"档位"与"最终分数"同源：
   *    perfect 用 CENTS_TOLERANT（满分线）、miss 用 CENTS_ZERO（零分线）、
   *    great / good 取两者之间的分档。
   *    否则会出现"四个音全 perfect 但总分很低"的矛盾，玩家会觉得系统在骗人。
   */
  var NOTE_TIERS = [
    { name: 'perfect', cents: 50, onsetMs: 150 },
    { name: 'great', cents: 100, onsetMs: 220 },
    { name: 'good', cents: 200, onsetMs: 400 }
  ];

  /**
   * 把一条目标音与其对应的实际音，转成档位判定。
   * @returns {{targetMidi:number, actualMidi:number|null, accuracy:number, tier:string}}
   */
  function tierOf(targetMidi, actualMidi, cents, onsetDiff) {
    if (actualMidi === null) {
      return { targetMidi: targetMidi, actualMidi: null, accuracy: 0, tier: 'miss' };
    }
    var absCents = Math.abs(cents);
    var absOnset = Math.abs(onsetDiff);
    var tier = 'miss';
    for (var i = 0; i < NOTE_TIERS.length; i += 1) {
      if (absCents <= NOTE_TIERS[i].cents && absOnset <= NOTE_TIERS[i].onsetMs) {
        tier = NOTE_TIERS[i].name;
        break;
      }
    }
    // 连续相似度：两个维度各自线性衰减后取较小者
    var aCents = linearScore(cents, CFG.CENTS_TOLERANT, CFG.CENTS_ZERO);
    var aOnset = linearScore(onsetDiff, CFG.RHYTHM_TOL_MS, CFG.RHYTHM_ZERO_MS);
    return {
      targetMidi: targetMidi,
      actualMidi: actualMidi,
      accuracy: Math.min(aCents, aOnset),
      tier: tier
    };
  }

  /**
   * 逐音判定（供 `attempt:note` 事件使用）。
   *
   * @param {Array} target    目标音符序列（`_buildTarget` 的产物）
   * @param {Array} actual    实际切分出的音符
   * @param {Object} [opts]
   *   opts.onlyIndex  只判这一个目标音（演唱过程中逐音推进时用）
   *   opts.offset     补偿的移调半音（通常传 `_estimateTranspose` 的结果）
   *   opts.maxCents   配对上限：音分差超过此值视为没唱（默认用 CENTS_ZERO）
   * @returns {Array<{index, targetMidi, actualMidi, accuracy, tier, t}>}
   */
  function judgeNotes(target, actual, opts) {
    opts = opts || {};
    var offset = opts.offset || 0;
    var maxCents = opts.maxCents || CFG.CENTS_ZERO;
    var out = [];
    var lo = opts.onlyIndex === undefined ? 0 : opts.onlyIndex;
    var hi = opts.onlyIndex === undefined ? target.length - 1 : opts.onlyIndex;

    for (var i = lo; i <= hi; i += 1) {
      if (i < 0 || i >= target.length) continue;
      var tn = target[i];
      var tStart = onsetOf(tn);
      var tEnd = tStart + (tn.durationMs || 0);
      var expectHz = Pitch.midiToHz(tn.midi + offset);

      // 在目标音的窗口（含少量容差）里找代价最小的实际音
      var best = null;
      var bestCost = Infinity;
      for (var j = 0; j < actual.length; j += 1) {
        var an = actual[j];
        var aStart = onsetOf(an);
        var aEnd = aStart + (an.durationMs || 0);
        // 时间重叠判据
        if (aEnd < tStart - CFG.RHYTHM_ZERO_MS || aStart > tEnd + CFG.RHYTHM_ZERO_MS) continue;
        // 音高用八度折叠后的音分差（低八度演唱不该判 miss）
        var folded = foldCents(Pitch.centsBetween(an.hz, expectHz));
        if (folded > maxCents) continue;
        var cost = folded + Math.abs(aStart - tStart) * 0.35;
        if (cost < bestCost) { bestCost = cost; best = an; }
      }

      if (best) {
        var cf = foldCents(Pitch.centsBetween(best.hz, expectHz));
        var tr = tierOf(tn.midi, best.midi, cf, onsetOf(best) - tStart);
        tr.index = i;
        tr.t = tStart + (tn.durationMs || 0);   // 判定时刻 = 该音结束时刻
        out.push(tr);
      } else {
        var miss = tierOf(tn.midi, null, Infinity, Infinity);
        miss.index = i;
        miss.t = tStart + (tn.durationMs || 0);
        out.push(miss);
      }
    }
    return out;
  }

  Siren.Score = {
    _scoreAttempt: scoreAttempt,
    _scoreAttemptVerbose: _scoreAttemptVerbose,
    _scoreRhythmOnly: scoreRhythmOnly,
    _align: align,
    _computeTransposition: computeTransposition,
    _estimateTranspose: estimateTranspose,
    _buildTarget: buildTarget,
    _judgeNotes: judgeNotes,
    _tiers: function () { return JSON.parse(JSON.stringify(NOTE_TIERS)); },
    _config: function () { return JSON.parse(JSON.stringify(CFG)); }
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
