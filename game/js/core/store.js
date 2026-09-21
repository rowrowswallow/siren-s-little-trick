/* 塞壬的小把戏 —— 后端：store.js（本地存储）
 *
 * 依据：
 *   · 02-后端开发规格书 D1「存储：localStorage，键名前缀 siren.」
 *   · 小工具能力清单 §3.7：**推荐用 `window.xhs.miniTool.setStorage`**，
 *     并明确「不要把浏览器自带存储当作可靠的持久化方案」
 *   · PRD §7.5.1.3-C：改用 setStorage，低版本降级回 localStorage
 *
 * ⚠️ 本模块的核心设计难点：**异步持久层 + 同步读数**。
 *    `miniTool.setStorage / getStorage` 都是 Promise 的，而 `Store.get()` 被前端
 *    与 game.js 同步调用（无法改成 async，否则要动契约与前端代码）。
 *    解法：**内存缓存为主 + 异步写穿（write-through）**
 *      · 读：永远读内存缓存，同步、零延迟 → 调用方完全不用改
 *      · 写：同步更新缓存（立刻可读），再后台异步落盘到 miniTool
 *      · 启动：`init()` 异步把持久层的数据灌进缓存（一次性）
 *    没调 `init()` 也能工作——只是拿不到上次的数据，不会崩。
 *
 * 降级链：miniTool.setStorage（客户端 ≥ 9.46.0）→ localStorage → 纯内存
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

  /** Storage JS API 所需的最低客户端版本（官方文档 §3.7：客户端 9.46.0） */
  var STORAGE_MIN_CLIENT_VERSION = 9460;

  // ---------------------------------------------------------------- 可用性探测

  /** localStorage 是否真的可用（Safari 隐私模式下 getItem 就会抛） */
  var lsAvailable = (function () {
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

  /** 容器是否注入了端能力（普通浏览器里为 undefined） */
  function miniTool() {
    var xhs = global.xhs;
    return (xhs && xhs.miniTool) ? xhs.miniTool : null;
  }

  /**
   * 读客户端 buildVersion。
   * 官方文档 §3.6：末 3 位是编译序号必须忽略；同步值可能缺失，需逐级判空。
   */
  function readBuildVersion() {
    var xhs = global.xhs;
    var env = xhs && xhs.launchOptions && xhs.launchOptions.miniToolEnv;
    return Number(env && env.buildVersion) || 0;
  }

  function clientVersionAtLeast(min) {
    var bv = readBuildVersion();
    if (!bv) return false;
    return Math.floor(bv / 1000) >= min;
  }

  // ---------------------------------------------------------------- 内存缓存

  var cache = {};          // 全部读写都走它，同步
  var backend = 'memory';  // 'miniTool' | 'localStorage' | 'memory'（诊断用）
  var ready = false;       // init() 是否已完成

  /** 从 localStorage 灌入缓存（同步，作为基线） */
  function loadFromLocalStorage() {
    if (!lsAvailable) return;
    try {
      for (var k in KEYS) {
        if (!Object.prototype.hasOwnProperty.call(KEYS, k)) continue;
        var v = global.localStorage.getItem(KEYS[k]);
        if (v !== null) cache[KEYS[k]] = v;
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 写穿到 localStorage（同步，作为二级降级） */
  function writeToLocalStorage(key, value) {
    if (!lsAvailable) return;
    try { global.localStorage.setItem(key, value); } catch (e) { /* 配额满/被禁 */ }
  }

  /** 写穿到 miniTool（异步，失败不抛，只记诊断计数） */
  var persistFailures = 0;
  function writeToMiniTool(key, value) {
    var mt = miniTool();
    if (!mt || typeof mt.setStorage !== 'function') return;
    if (!clientVersionAtLeast(STORAGE_MIN_CLIENT_VERSION)) return;
    try {
      var p = mt.setStorage({ key: key, data: value });
      if (p && typeof p.catch === 'function') {
        p.catch(function () { persistFailures += 1; });
      }
    } catch (e) {
      persistFailures += 1;
    }
  }

  /**
   * 异步初始化：把持久层的数据灌进缓存。
   *
   * 必须在读任何业务数据之前调用一次（`game.js` 的 `init()` 里已 await）。
   * 未调用也能工作，但拿不到上次的数据——所以**不能省**。
   *
   * @returns {Promise<string>} 实际生效的后端名，便于诊断
   */
  function init() {
    if (ready) return Promise.resolve(backend);
    loadFromLocalStorage();   // 先拿 localStorage 作为基线

    var mt = miniTool();
    var canUseMt = mt && typeof mt.getStorage === 'function' &&
      clientVersionAtLeast(STORAGE_MIN_CLIENT_VERSION);

    if (!canUseMt) {
      backend = lsAvailable ? 'localStorage' : 'memory';
      ready = true;
      return Promise.resolve(backend);
    }

    backend = 'miniTool';
    var keys = [];
    for (var k in KEYS) {
      if (Object.prototype.hasOwnProperty.call(KEYS, k)) keys.push(KEYS[k]);
    }

    return Promise.all(keys.map(function (key) {
      return mt.getStorage({ key: key }).then(function (res) {
        // 官方：返回 { data }；data 可能是任意可 JSON 序列化值
        if (res && res.data !== undefined && res.data !== null) {
          cache[key] = String(res.data);
        }
      }).catch(function () { /* 该键不存在或读取失败，保留 localStorage 的值 */ });
    })).then(function () {
      ready = true;
      return backend;
    }).catch(function () {
      backend = lsAvailable ? 'localStorage' : 'memory';
      ready = true;
      return backend;
    });
  }

  // ---------------------------------------------------------------- 同步 API

  function get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    return fallback;
  }

  function set(key, value) {
    var s = String(value);
    cache[key] = s;                     // ① 同步生效，立刻可读
    writeToLocalStorage(key, s);        // ② 降级层同步写
    writeToMiniTool(key, s);            // ③ 首选层异步写穿（不阻塞）
    return true;
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
    delete cache[key];
    if (lsAvailable) {
      try { global.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
    }
    var mt = miniTool();
    if (mt && typeof mt.removeStorage === 'function' &&
        clientVersionAtLeast(STORAGE_MIN_CLIENT_VERSION)) {
      try {
        var p = mt.removeStorage({ key: key });
        if (p && typeof p.catch === 'function') p.catch(function () { persistFailures += 1; });
      } catch (e) { persistFailures += 1; }
    }
  }

  function clearAll() {
    for (var k in KEYS) {
      if (Object.prototype.hasOwnProperty.call(KEYS, k)) remove(KEYS[k]);
    }
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

  /**
   * 是否"至少有一个能存的层"。
   * ⚠️ 语义变化：以前表示 localStorage 可用；现在内存缓存恒可用，
   *    所以**恒为 true**。保留这个名字是为了不破坏已有调用点；
   *    想知道真实后端请用 `backend()`。
   */
  var available = true;

  Siren.Store = {
    KEYS: KEYS,
    init: init,
    available: available,
    backend: function () { return backend; },
    ready: function () { return ready; },
    persistFailures: function () { return persistFailures; },
    localStorageAvailable: lsAvailable,
    miniToolAvailable: function () { return !!miniTool(); },
    clientVersion: function () { return readBuildVersion(); },
    get: get,
    set: set,
    getNumber: getNumber,
    getBool: getBool,
    setBool: setBool,
    remove: remove,
    clearAll: clearAll,
    stats: stats,
    commitRun: commitRun,
    _resetForTest: function () { cache = {}; ready = false; persistFailures = 0; }
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
