/* 塞壬的小把戏 —— 后端：fleet.js（船队模拟）
 *
 * 依据：02-后端开发规格书 D9
 *   · 固定分母 100，每波 20 条，5 波 —— 这是"船数 = 分数"的前提
 *   · 种子 PRNG，不用 Math.random（D8/D9 都要求可复现）
 *
 * 判定模型（产品负责人决策，2026-09 替换 D9.2 原式；详见 CONFIG 处注释与
 * docs/规格问题清单.md B1/B2）：
 *   k ~ Uniform(0,1) 有界；触礁条件 k < score/100
 *   → 单条船触礁概率恰好等于 score/100，于是 D9.3「长期期望严格等于分数」精确成立
 *   → score=0 恒全逃、score=100 恒全触礁，两个端点由构造保证（不是"大概率"）
 *
 * 为什么替换掉 D9.2 的 `pull > THRESHOLD_T`：
 *   旧式下 score=100 仍有约 2.3% 的船逃掉（实测均值 97.7 条），满分拿不到 100 条，
 *   结局 A 几乎不可达；且 score < 53 分时中位船必然不触礁，低分段是死区。
 *   要让"满分必全触礁"，`pull > T` 形式在数学上不可能成立
 *   （k→0 时 pull→0，需 T ≤ 0；而 T=0 会让任何正分数都全触礁）。
 *
 * 本文件不触碰 document / window 渲染（D0 硬规则 1）。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  // ---------------------------------------------------------------- CONFIG（D9.1 唯一参数来源）

  var CONFIG = {
    // 流程
    PHRASES: 5,
    NOTES_PER_PHRASE: [3, 4, 5, 6, 7],
    BPM: 92,
    RECORD_MAX_MS: 6000,
    SILENCE_ABORT_MS: 3000,

    // 船队（船数 = 分数 的实现）
    FLEET_TOTAL: 100,          // 固定分母
    SHIPS_PER_PHRASE: 20,      // 5 波 × 20 = 100

    // ⚠️ 判定模型（2026-09 按产品负责人决策整体替换，见 docs/规格问题清单.md B1/B2）
    //
    //   旧模型：k ~ 截断正态(mean=1.0, sigma=0.24, 下界=0.35)，触礁条件 pull > THRESHOLD_T
    //           （pull = score/100 × LURE_GAIN × k），参数 THRESHOLD_T/LURE_GAIN/K_MEAN/
    //           K_SIGMA/K_MIN。该模型有两个无法修复的缺陷：
    //             · 低分段死区：中位船在 score < 53 分时必然不触礁（实算 20 分 → 0 条船）
    //             · 满分不满：score=100 时仍有约 2.3% 的船 k < 0.533 逃掉（实测均值 97.7，
    //               只有 9.8% 的局能拿到 100 条，导致结局 A 几乎不可达）
    //
    //   新模型：k ~ Uniform(0,1)（有界），触礁条件 k < score/100
    //            数学性质：单条船的触礁概率**恰好等于 score/100**
    //            端点由构造保证：score=0 → 恒不触礁；score=100 → 恒全触礁
    //            因此 D9.3「长期期望严格等于分数」真正成立，D13 三条用例全部满足
    //
    //   → 上面 5 个旧参数已全部作废并删除。调难度请改「触礁阈值曲线」，
    //     而不是再引入全局增益（那会重新打破"触礁率 = 分数"）。
    K_MIN: 0,                  // k 的取值下界（开区间，见 sampleK 的边界处理）
    K_MAX: 1,                  // k 的取值上界

    // 终局（D9.4）
    ENDING_A: 100,
    ENDING_B: 70,
    ENDING_C: 20
  };

  // ---------------------------------------------------------------- 种子 PRNG

  /**
   * mulberry32 统一由 pitch.js 提供（最先加载的模块），见那里的说明：
   * 规格书 D2 的加载顺序把 melody.js 排在 fleet.js 之前，
   * 而两者都需要种子 PRNG，放在 fleet 名下会造成顺序与依赖矛盾。
   */
  function mulberry32(seed) {
    if (Siren.Pitch && Siren.Pitch.mulberry32) return Siren.Pitch.mulberry32(seed);
    // 兜底：pitch.js 未加载时自行实现一份（保证 fleet 单独使用也不崩）
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- 抽样

  /**
   * 抽样一条船的"拉力敏感度" k。
   *
   * k 是有界的，落在开区间 (0, 1)：
   *   · 每个乐句、每条船独立抽取 → 每条船的抗性天然参差
   *     （PRD §7.1 括注要求："有些船受拉力影响比较大，有些比较小，得分的随机性会高一点点"）
   *   · rng() 理论上可能返回 0，而 k=0 会让 score=0 时出现"k < 0 不成立"之外的边界歧义；
   *     更关键的是 k=0 在物理上意味着"完全没有抗性"，与"逃脱"的语义冲突。
   *     所以把 0 夹到最小正数——保证 **0 分时一条船都不会触礁**（R2 的确定性保证）。
   *   · k 不会取到 1（rng() < 1），因此 **满分时每条船都满足 k < 1**（R3 的确定性保证）。
   */
  function sampleK(rng) {
    var k = rng();
    if (!(k > 0)) k = Number.MIN_VALUE;   // 夹开 0，保证 0 分必全逃
    if (k >= CONFIG.K_MAX) k = 1 - Number.EPSILON;
    return k;
  }

  // ---------------------------------------------------------------- 波次

  var _nextId = 1;

  function resetIds() { _nextId = 1; }

  /**
   * 生成一批新船（D9.2）
   * @returns {Array} 20 条船；lane/depth/side/entryDelayMs 供前端布局，后端不关心如何画
   */
  function spawnWave(rng, waveIndex) {
    var ships = [];
    for (var i = 0; i < CONFIG.SHIPS_PER_PHRASE; i += 1) {
      ships.push({
        id: _nextId++,
        wave: waveIndex,
        k: sampleK(rng),                 // 内部使用，不下发（契约 C3 标为可选）
        wrecked: false,
        pull: 0,
        lane: i % 5,                     // 0..4，5 条水平通道
        depth: rng(),                    // 0 = 近景，1 = 远景
        side: rng() < 0.5 ? 'left' : 'right',
        entryDelayMs: Math.floor(rng() * 600)
      });
    }
    return ships;
  }

  /**
   * 逐船判定（D9.2）：本乐句得分 → 本波触礁数
   *
   * 判定式：k < score / 100
   *   等价于"分数就是触礁率"——score=50 时每条船有 50% 概率被吸引。
   *   端点由构造保证：score=0 时 k < 0 恒不成立（全逃）；score=1 时 k < 1 恒成立（全触礁）。
   *
   * pull 仍保留在返回值里供 HUD / 诊断使用，但**它不再参与判定**：
   *   为了让 pull 保持"越大越容易被吸引"的直觉，这里定义为 1 - k 方向上的量，
   *   即 pull = score/100 / k 的单调替代——简单起见直接用 score/100 与 k 的比值：
   *   pull = (score/100) / k，k 越小 pull 越大（越容易被吸引），与旧语义一致。
   *
   * @returns {{wrecked:Array, docked:Array}} 触礁船与停泊船
   */
  function resolveWave(waveShips, score) {
    var ratio = Math.max(0, Math.min(100, score)) / 100;
    var wrecked = [];
    var docked = [];
    for (var i = 0; i < waveShips.length; i += 1) {
      var ship = waveShips[i];
      var k = ship.k;
      ship.pull = k > 0 ? ratio / k : Infinity;   // 仅供展示/诊断，不参与判定
      if (k < ratio) {
        ship.wrecked = true;
        wrecked.push(ship);
      } else {
        ship.wrecked = false;
        docked.push(ship);
      }
    }
    return { wrecked: wrecked, docked: docked };
  }

  /** 终局（D9.4）：N = 触礁总数 → 结局判定 */
  function decideEnding(wreckedTotal) {
    if (wreckedTotal >= CONFIG.ENDING_A) return 'A';
    if (wreckedTotal >= CONFIG.ENDING_B) return 'B';
    if (wreckedTotal >= CONFIG.ENDING_C) return 'C';
    return 'D';
  }

  /**
   * 期望触礁数（解析解）。
   *
   * 新模型下它就是一条直线：每条船触礁概率 = score/100，共 FLEET_TOTAL 条
   *   → 期望 = FLEET_TOTAL × score/100 = score
   * 这正是 D9.3「长期期望严格等于分数」的字面含义，现在**精确成立**（旧模型下不成立）。
   *
   * 单局实际值的波动服从二项分布 B(100, score/100)：
   *   标准差 σ = sqrt(100 × p × (1-p))，p=0.5 时 σ ≈ 5.0
   *   （D9.3 原文称"1σ ≈ ±4.4 条"，量级一致）
   */
  function expectedWrecked(score) {
    var s = Math.max(0, Math.min(100, score));
    return CONFIG.FLEET_TOTAL * s / 100;
  }

  /** 单局触礁数的理论标准差（二项分布），供调参判断随机性强度 */
  function wreckedStdDev(score) {
    var p = Math.max(0, Math.min(100, score)) / 100;
    return Math.sqrt(CONFIG.FLEET_TOTAL * p * (1 - p));
  }

  Siren.Fleet = {
    CONFIG: CONFIG,
    mulberry32: mulberry32,
    sampleK: sampleK,
    spawnWave: spawnWave,
    resolveWave: resolveWave,
    decideEnding: decideEnding,
    expectedWrecked: expectedWrecked,
    wreckedStdDev: wreckedStdDev,
    resetIds: resetIds
  };
})(typeof window !== 'undefined' ? window : globalThis);
