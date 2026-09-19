#!/usr/bin/env node
/**
 * 冒烟测试：确认 game.js 能在浏览器语义下启动并连续渲染不崩。
 *
 * 刻意保持"笨"：只用 properties 而非 assertions，几乎不可能误报。
 * 覆盖的是一类真实硬伤——引用不存在的 DOM 元素、字符串拼接写错、
 * 渲染里调用了 undefined 的方法。这些一跑就崩。
 *
 * 玩法手感请在浏览器里看（node tools/serve.mjs）。
 *
 * 用法：node tools/smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'game');

const source = fs.readFileSync(path.join(ROOT, 'assets', 'game.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ids = [...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------- DOM 存根

const gradient = { addColorStop() {} };
const noop = () => {};

function stub2d() {
  return {
    canvas: null,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '',
    setTransform: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop, ellipse: noop, rect: noop,
    fill: noop, stroke: noop, fillRect: noop, clearRect: noop, strokeRect: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 10 }),
    createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    createPattern: () => null, drawImage: noop, clip: noop, setLineDash: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
  };
}

function stubElement(id) {
  const listeners = {};
  const self = {
    id,
    textContent: '',
    value: '',
    hidden: false,
    style: {},
    clientWidth: 390,
    clientHeight: 760,
    width: 780,
    height: 1520,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    fire(type, extra = {}) {
      for (const fn of listeners[type] || []) fn({ type, preventDefault() {}, ...extra });
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 760, right: 390, bottom: 760 }),
    getContext: () => self._ctx,
    setPointerCapture: noop,
    releasePointerCapture: noop,
    focus: noop,
  };
  self._ctx = stub2d();
  self._ctx.canvas = self;
  return self;
}

const els = new Map(ids.map((id) => [id, stubElement(id)]));

const documentStub = {
  readyState: 'complete',
  getElementById: (id) => els.get(id) || null,
  body: stubElement('body'),
  documentElement: stubElement('html'),
  scripts: [{ src: './assets/game.js' }],
  addEventListener: noop,
  createElement: (tag) => stubElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
};

const store = new Map();
const windowStub = {
  document: documentStub,
  navigator: { userAgent: 'smoke', vibrate: noop },
  devicePixelRatio: 2,
  innerWidth: 390,
  innerHeight: 760,
  requestAnimationFrame: noop,     // 手动驱动，不用真定时器
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  clearTimeout: (id) => clearTimeout(id),
  addEventListener: noop,
  removeEventListener: noop,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
};

// ---------------------------------------------------------------- 执行

console.log('冒烟测试（最小 DOM 存根）');
console.log('');

const problems = [];

try {
  const run = new Function(
    'window', 'document', 'requestAnimationFrame', 'navigator', 'localStorage', 'globalThis',
    source,
  );
  run(windowStub, documentStub, windowStub.requestAnimationFrame, windowStub.navigator,
    windowStub.localStorage, windowStub);
  console.log('  ✓ 脚本执行完毕（boot 未抛错）');
} catch (e) {
  problems.push('boot 抛错：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
}

// 手动驱动帧：rAF 回调执行后再排队一次，模拟连续渲染
let clock = 0;
let frameCount = 0;
let loopFn = null;
windowStub.requestAnimationFrame = (fn) => { loopFn = fn; return 1; };

const tick = (n, label) => {
  for (let i = 0; i < n; i += 1) {
    if (!loopFn) return false;
    const fn = loopFn;
    loopFn = null;
    clock += 16.7;
    frameCount += 1;
    try { fn(clock); } catch (e) {
      problems.push(`${label} 第 ${i + 1} 帧抛错：` + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e));
      return false;
    }
  }
  return true;
};

try {
  const run2 = new Function(
    'window', 'document', 'requestAnimationFrame', 'navigator', 'localStorage', 'globalThis',
    source,
  );
  run2(windowStub, documentStub, windowStub.requestAnimationFrame, windowStub.navigator,
    windowStub.localStorage, windowStub);
  if (!loopFn) problems.push('没有注册 requestAnimationFrame 回调，游戏不会动');
  else console.log('  ✓ 渲染循环已注册');
} catch (e) {
  problems.push('二次执行抛错：' + (e && e.message));
}

const canvas = els.get('sea');
const startButton = els.get('startButton');

if (tick(120, '待机')) console.log('  ✓ 待机渲染 120 帧无异常');

try {
  startButton.fire('click');
  console.log('  ✓ 点击「下潜」未抛错');
} catch (e) {
  problems.push('点击开始抛错：' + e.message);
}

// 游玩 40 秒：覆盖生成、下落、回收、连击计时、难度爬升
try {
  canvas.fire('pointerdown', { clientX: 100, clientY: 400, pointerId: 1, pointerType: 'touch', buttons: 1, cancelable: true });
  for (let i = 0; i < 2400; i += 1) {
    canvas.fire('pointermove', {
      clientX: 195 + Math.sin(i / 30) * 150,
      clientY: 380 + Math.cos(i / 45) * 250,
      pointerId: 1, pointerType: 'touch', buttons: 1, cancelable: true,
    });
    if (!tick(1, '游玩')) break;
  }
  canvas.fire('pointerup', { clientX: 195, clientY: 380, pointerId: 1, pointerType: 'touch' });
  console.log('  ✓ 游玩 2400 帧（约 40 秒）无异常');
} catch (e) {
  problems.push('游玩过程抛错：' + e.message);
}

try {
  canvas.fire('pointerleave', { pointerId: 1, pointerType: 'touch' });
  tick(180, '松手');
  console.log('  ✓ 松手漂移 180 帧无异常');
} catch (e) {
  problems.push('松手阶段抛错：' + e.message);
}

try {
  els.get('againButton').fire('click');
  els.get('shareButton').fire('click');
  tick(60, '结算页');
  console.log('  ✓ 结算页按钮（再来一次 / 生成战报）未抛错');
  if (!els.get('shareText').value) problems.push('战报文案为空');
  else console.log(`  ✓ 战报文案已生成：${els.get('shareText').value.slice(0, 32)}…`);
} catch (e) {
  problems.push('结算页交互抛错：' + e.message);
}

console.log('');
console.log(`  累计渲染 ${frameCount} 帧`);
console.log('');
if (problems.length) {
  console.log(`发现问题 ${problems.length} 条：`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(2);
}
console.log('冒烟测试通过：启动、连续渲染、输入、结算、战报均未抛错');
