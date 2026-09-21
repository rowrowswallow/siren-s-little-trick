/* 塞壬的小把戏 —— 后端：melody.js（旋律生成）
 *
 * 依据：02-后端开发规格书 D8
 *   · 五声音阶：PENTATONIC_OFFSETS = [0,2,4,7,9]（C D E G A）
 *   · 种子 PRNG（mulberry32），不用 Math.random
 *   · 相邻音级差 ≤ 4 度（Boss 乐句允许 5 度）
 *   · 不得连续 3 个同方向进行
 *   · 首音 degree ∈ {0, 2}；末音 degree % 5 === 0（主音收尾）
 *   · 熟曲选取：rng() < 0.5 && phraseIndex >= 1 && phraseIndex !== 4（Boss 乐句必用原创）
 *   · 歌名 title 仅在 V4 结算且 score ≥ 60 时广播
 *
 * 依赖：data/melodies.js 必须先加载（提供 Siren.MELODIES 与 Siren.MELODY_INDEX）
 * 本文件不触碰 document / window 渲染（D0 硬规则 1）。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  var PENTATONIC_OFFSETS = [0, 2, 4, 7, 9];          // C D E G A
  var MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11];         // C D E F G A B

  var BOSS_PHRASE_INDEX = 4;                           // 第 5 句 = Boss（D8/PRD §7.3）
  var FAMILIAR_PROBABILITY = 0.5;
  var TITLE_REVEAL_MIN_SCORE = 60;                     // D8：≥60 分才揭晓歌名

  // ---------------------------------------------------------------- 级数换算

  /** 五声音阶级数 → MIDI（原创旋律用） */
  function degreeToMidi(d) {
    return 60 + 12 * Math.floor(d / 5) + PENTATONIC_OFFSETS[((d % 5) + 5) % 5];
  }

  /** 自然大调级数 → MIDI（熟曲库用，见 data/melodies.js 的偏离说明） */
  function majorDegreeToMidi(d) {
    return 60 + 12 * Math.floor(d / 7) + MAJOR_OFFSETS[((d % 7) + 7) % 7];
  }

  /** 按音阶换算级数 */
  function toMidi(degree, scale) {
    return scale === 'major' ? majorDegreeToMidi(degree) : degreeToMidi(degree);
  }

  // ---------------------------------------------------------------- 原创生成

  /**
   * 单次尝试生成一个原创乐句；若违反任何 D8 约束则返回 null。
   *
   * ⚠️ 不能用"边生成边过滤候选"的写法：末音（degree % 5 === 0 的主音收尾）
   *    走的是独立分支，不受方向检查约束，连写两次就凑出 3 个同方向
   *    （实测样例：[2,-1,-2,-5] 全部下行）。改为整句生成 + 统一校验 + 拒绝重采样。
   */
  function tryGeneratePhrase(rng, noteCount, isBoss) {
    var maxStep = isBoss ? 5 : 4;
    var degrees = [];
    var eighths = [];

    // 首音：degree ∈ {0, 2}（D8）
    degrees.push(rng() < 0.5 ? 0 : 2);

    for (var i = 1; i < noteCount; i += 1) {
      var isLast = i === noteCount - 1;
      var prev = degrees[i - 1];
      var candidates = [];

      if (isLast) {
        // 末音 degree % 5 === 0（主音收尾）；候选含低八度主音，且必须与前音可比邻
        var lastPool = [0, 5, 10, -5];
        for (var a = 0; a < lastPool.length; a += 1) {
          if (Math.abs(lastPool[a] - prev) <= maxStep) candidates.push(lastPool[a]);
        }
        if (!candidates.length) return null;          // 无法收尾，交给重采样
      } else {
        for (var step = -maxStep; step <= maxStep; step += 1) {
          if (step === 0) continue;
          var cand = prev + step;
          if (cand < -2 || cand > 9) continue;        // 音域 C4–C5 附近（PRD §5.3）
          candidates.push(cand);
        }
        if (!candidates.length) return null;
      }

      degrees.push(candidates[Math.floor(rng() * candidates.length)]);
    }

    // 节奏：全部落在八分格上（D4.6）。末音拉长形成收束感。
    for (var k = 0; k < degrees.length; k += 1) {
      if (k === degrees.length - 1) eighths.push(4);
      else eighths.push(rng() < 0.75 ? 2 : 1);
    }

    if (!isValidOriginal(degrees, eighths, maxStep)) return null;
    return { degrees: degrees, eighths: eighths, scale: 'pentatonic', familiar: false, title: null };
  }

  /** D8 全部约束的统一校验（生成与验证共用同一份判据） */
  function isValidOriginal(degrees, eighths, maxStep) {
    if (!degrees.length) return false;
    // 首音 ∈ {0, 2}
    if (degrees[0] !== 0 && degrees[0] !== 2) return false;
    // 末音 % 5 === 0
    var last = degrees[degrees.length - 1];
    if (((last % 5) + 5) % 5 !== 0) return false;
    // 相邻级差 ≤ maxStep
    for (var i = 1; i < degrees.length; i += 1) {
      if (Math.abs(degrees[i] - degrees[i - 1]) > maxStep) return false;
    }
    // 不得连续 3 个同方向（级差为 0 的重音不改变方向，跨过它继续计数）
    var run = 0;
    var prevDir = 0;
    for (var k = 1; k < degrees.length; k += 1) {
      var dir = Math.sign(degrees[k] - degrees[k - 1]);
      if (dir === 0) continue;                        // 重音不改变方向
      if (dir === prevDir) run += 1; else run = 1;
      prevDir = dir;
      if (run >= 3) return false;
    }
    // 节奏必须是正整数八分格
    for (var e = 0; e < eighths.length; e += 1) {
      if (!isFinite(eighths[e]) || eighths[e] <= 0 || Math.floor(eighths[e]) !== eighths[e]) return false;
    }
    return true;
  }

  /** 保底旋律：一定合法（五声音阶上行后收主音） */
  function fallbackPhrase(noteCount) {
    var degrees = [0];
    var pattern = [1, 1, 1, 1, -1, -1, 1, 1, 1, 1];
    var idx = 0;
    while (degrees.length < noteCount - 1) {
      var next = degrees[degrees.length - 1] + pattern[idx % pattern.length];
      idx += 1;
      // 约束：不连续 3 个同方向
      var len = degrees.length;
      if (len >= 2) {
        var d1 = Math.sign(degrees[len - 1] - degrees[len - 2]);
        var d2 = Math.sign(next - degrees[len - 1]);
        if (d1 === d2 && len >= 3) {
          var d0 = Math.sign(degrees[len - 2] - degrees[len - 3]);
          if (d0 === d1) next = degrees[len - 1] - d2;   // 反向一次
        }
      }
      if (next < -1 || next > 8) next = degrees[degrees.length - 1] - 1;
      degrees.push(next);
    }
    // 末音收主音：找最近的 5 的倍数
    var lastDeg = degrees[degrees.length - 1];
    var target = Math.round(lastDeg / 5) * 5;
    degrees.push(target);

    var eighths = degrees.map(function (_, i) {
      return i === degrees.length - 1 ? 4 : 2;
    });

    if (!isValidOriginal(degrees, eighths, 5)) {
      // 极端兜底：只保证末音为主音且级差合法
      degrees = [0];
      for (var m = 1; m < noteCount - 1; m += 1) degrees.push(m % 2 === 0 ? 2 : 1);
      degrees.push(5);
      eighths = degrees.map(function (_, i) { return i === degrees.length - 1 ? 4 : 2; });
    }
    return { degrees: degrees, eighths: eighths, scale: 'pentatonic', familiar: false, title: null };
  }

  /** 生成原创乐句（拒绝重采样，最多 200 次；仍失败则用保底旋律） */
  function generatePhrase(rng, noteCount, isBoss) {
    var maxStep = isBoss ? 5 : 4;
    for (var attempt = 0; attempt < 200; attempt += 1) {
      var p = tryGeneratePhrase(rng, noteCount, isBoss);
      if (p) return p;
    }
    return fallbackPhrase(noteCount);
  }

  // ---------------------------------------------------------------- 熟曲抽取

  /**
   * 从熟曲库按音数抽取（D8：按音数分桶索引）
   * @returns {Object|null} 找不到对应音数的乐句时返回 null（调用方回退到原创）
   */
  function pickFamiliar(rng, noteCount) {
    var index = Siren.MELODY_INDEX;
    if (!index) return null;
    var bucket = index[noteCount];
    if (!bucket || !bucket.length) return null;
    var pick = bucket[Math.floor(rng() * bucket.length)];
    return {
      degrees: pick.degrees.slice(),
      eighths: pick.eighths.slice(),
      scale: pick.scale || 'major',
      familiar: true,
      title: pick.title,
      source: pick.source
    };
  }

  // ---------------------------------------------------------------- 对外

  /**
   * 生成本局的 5 个乐句。
   * @param {number} seed 种子（可复现）
   * @param {Array<number>} notesPerPhrase 每句音数，默认 [3,4,5,6,7]
   * @returns {{seed:number, phrases:Array}}
   */
  function buildPhrases(seed, notesPerPhrase) {
    var counts = notesPerPhrase || [3, 4, 5, 6, 7];
    // 种子 PRNG 来自 pitch.js（最先加载，见那里的说明：D2 的加载顺序要求
    // melody.js 在 fleet.js 之前，所以不能依赖 fleet 提供的 PRNG）
    var pitchMod = Siren.Pitch;
    if (!pitchMod || !pitchMod.mulberry32) {
      throw new Error('melody.js 依赖 Siren.Pitch.mulberry32，请检查 D2 规定的加载顺序');
    }
    var rng = pitchMod.mulberry32(seed);

    var phrases = [];
    for (var i = 0; i < counts.length; i += 1) {
      var noteCount = counts[i];
      var isBoss = i === BOSS_PHRASE_INDEX;
      var useFamiliar = !isBoss && i >= 1 && rng() < FAMILIAR_PROBABILITY;

      var phrase = null;
      if (useFamiliar) phrase = pickFamiliar(rng, noteCount);
      if (!phrase) phrase = generatePhrase(rng, noteCount, isBoss);

      phrase.phraseIndex = i;
      phrase.noteCount = phrase.degrees.length;
      phrases.push(phrase);
    }

    return { seed: seed, phrases: phrases };
  }

  /**
   * 把乐句转成契约 C3 规定的 notes[] 结构。
   * @returns {Array<{midi,startMs,durationMs,degree}>}
   */
  function toNotes(phrase, bpm) {
    var eighthMs = 60000 / (bpm || 92) / 2;
    var notes = [];
    var cursor = 0;
    for (var i = 0; i < phrase.degrees.length; i += 1) {
      var midi = toMidi(phrase.degrees[i], phrase.scale);
      var dur = phrase.eighths[i] * eighthMs;
      notes.push({
        midi: midi,
        startMs: cursor,
        durationMs: dur,
        degree: phrase.degrees[i]
      });
      cursor += dur;
    }
    return notes;
  }

  /** D8：歌名仅在 V4 结算且 score ≥ 60 时揭晓 */
  function shouldRevealTitle(phrase, score) {
    return !!(phrase && phrase.familiar && phrase.title && score >= TITLE_REVEAL_MIN_SCORE);
  }

  Siren.Melody = {
    buildPhrases: buildPhrases,
    toNotes: toNotes,
    degreeToMidi: degreeToMidi,
    majorDegreeToMidi: majorDegreeToMidi,
    toMidi: toMidi,
    shouldRevealTitle: shouldRevealTitle,
    PENTATONIC_OFFSETS: PENTATONIC_OFFSETS,
    MAJOR_OFFSETS: MAJOR_OFFSETS,
    TITLE_REVEAL_MIN_SCORE: TITLE_REVEAL_MIN_SCORE,
    BOSS_PHRASE_INDEX: BOSS_PHRASE_INDEX
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
