/* 塞壬的小把戏 —— 后端：store.js（localStorage 封装）
 *
 * 依据：02-后端开发规格书 D1「存储：localStorage，键名前缀 siren.」
 *
 * 规格书 D1 只要求"前缀 siren."，具体键名未指定，这里集中定义以便前端查阅。
 * 所有读写都做异常兜底（隐私模式 / 配额满 / 平台禁用 都不能让游戏崩）。
 *
 * 本文件不触碰 document / window 渲染（D0 硬规则 1）；localStorage 是 D0 明确豁免项。
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};

  var PREFIX = 'siren.';

  var KEYS = {
    BEST_WRECKED: PREFIX + 'best.wrecked',     // 单局最高触礁船数（0..100）
    BEST_SCORE: PREFIX + 'best.score',         // 单局最高共鸣度
    PLAYS: PREFIX + 'plays',                   // 累计局数
    SEED: PREFIX + 'seed',                     // 上次使用的种子，便于复现
    MIC_OK: PREFIX + 'mic.ok',                 // 上次麦克风是否可用（'1' / '0'）
    MUTED: PREFIX + 'muted',                   // 音效是否静音
    TUTORIAL_DONE: PREFIX + 'tutorialDone'     // 是否已走过新手引导关（v1.1.0）
  };

  /** 探测 localStorage 是否真的可用（Safari 隐私模式下 getItem 就会抛） */
  var available = (function () {
    try {
      var probe = PREFIX + '__probe';
      global.localStorage.setItem(probe, '1');
      var ok = global.localStorage.getItem(probe) === '1';
      global.localStorage.removeItem(probe);
      return ok;
    } catch (e) {
      return false;
    }
  })();

  function get(key, fallback) {
    if (!available) return fallback;
    try {
      var raw = global.localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    if (!available) return false;
    try {
      global.localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      return false;   // 配额满或被禁，静默降级（规格书：数据持久化失败不影响单局）
    }
  }

  function getNumber(key, fallback) {
    var raw = get(key, null);
    if (raw === null) return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  function getBool(key, fallback) {
    var raw = get(key, null);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  }

  function setBool(key, value) {
    return set(key, value ? '1' : '0');
  }

  function remove(key) {
    if (!available) return;
    try { global.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function clearAll() {
    if (!available) return;
    try {
      for (var k in KEYS) {
        if (Object.prototype.hasOwnProperty.call(KEYS, k)) global.localStorage.removeItem(KEYS[k]);
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 一次性读取本机战绩 */
  function stats() {
    return {
      bestWrecked: getNumber(KEYS.BEST_WRECKED, 0),
      bestScore: getNumber(KEYS.BEST_SCORE, 0),
      plays: getNumber(KEYS.PLAYS, 0),
      muted: getBool(KEYS.MUTED, false)
    };
  }

  /** 一局结束后写入战绩，返回是否刷新了记录 */
  function commitRun(wreckedTotal, scoreTotal) {
    var best = getNumber(KEYS.BEST_WRECKED, 0);
    var isRecord = wreckedTotal > best;
    if (isRecord) {
      set(KEYS.BEST_WRECKED, wreckedTotal);
      set(KEYS.BEST_SCORE, scoreTotal);
    }
    set(KEYS.PLAYS, getNumber(KEYS.PLAYS, 0) + 1);
    return isRecord;
  }

  Siren.Store = {
    KEYS: KEYS,
    available: available,
    get: get,
    set: set,
    getNumber: getNumber,
    getBool: getBool,
    setBool: setBool,
    remove: remove,
    clearAll: clearAll,
    stats: stats,
    commitRun: commitRun
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
