/* 塞壬的小把戏 —— 后端入口：index.js
 *
 * 依据：03-接口契约 C1。这是前后端唯一的交界。
 *
 * ⚠️ 唯一对外暴露的只有契约列出的方法：
 *      init / start / replayPhrase / abort / on / off / getState / version
 *    绝不在 window.Siren 上挂 _scoreAttempt 等内部函数——
 *    契约 D7.1/P4 要求"只有一个数字：船数"，暴露维度拆解等于把 P4 承诺作废。
 *    各模块的内部接口都带下划线前缀（Siren.Score._xxx），供离线验证使用，不属于前端契约。
 *
 * 加载顺序（D2，不可乱）：
 *   data/melodies.js → store → pitch → segment → score → audio → melody → fleet → game → index
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};
  var Game = Siren.Game;

  if (!Game) {
    // 加载顺序错了：给出明确的技术错误，不静默失败
    if (global.console && global.console.error) {
      global.console.error('[Siren] game.js 未加载，请检查 index.html 的脚本顺序（D2）');
    }
    return;
  }

  var VERSION = '1.0.0';   // 契约 C1 规定的版本号

  // 契约 C1 的 8 个成员
  Siren.init = Game.init;
  Siren.start = Game.start;
  Siren.replayPhrase = Game.replayPhrase;
  Siren.abort = Game.abort;
  Siren.on = Game.on;
  Siren.off = Game.off;
  Siren.getState = Game.getState;
  Siren.version = VERSION;

  // 只读常量与能力自检（供前端判断环境，不属于状态机）
  Siren.capabilities = {
    audioContext: !!(global.AudioContext || global.webkitAudioContext),
    getUserMedia: !!(global.navigator && global.navigator.mediaDevices &&
      typeof global.navigator.mediaDevices.getUserMedia === 'function'),
    localStorage: Siren.Store ? Siren.Store.available : false
  };
})(typeof window !== 'undefined' ? window : globalThis);
