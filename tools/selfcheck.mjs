#!/usr/bin/env node
/**
 * 静态自检（zip-artifact-spec §6「改写正确性」+ 后端规格书 D13 结构类用例）
 *
 * 扫描 game/ 下全部 html / js / css：
 *   1. HTML 引用的本地资源是否都存在（含相对路径解析）
 *   2. HTML 里的内联 <script> / 行内事件 / javascript: / 外部引用 / base / iframe
 *   3. JS 中引用的 DOM id 是否在该页 HTML 中存在
 *   4. HTML 用到的 class 是否在 CSS 里有定义
 *   5. 脚本加载顺序：依赖的命名空间文件必须先于使用者
 *   6. 后端 core/ 目录不得出现 DOM 渲染调用（D0 硬规则 1）
 *   7. D13 清单：诊断话术关键词零命中（D7.4 强制删除）
 *
 * 用法：node tools/selfcheck.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAME = path.join(ROOT, 'game');

const problems = [];
const infos = [];
const bad = (m) => { problems.push(m); console.log(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => { infos.push(m); console.log(`  ℹ ${m}`); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

const allFiles = walk(GAME);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 去掉注释，只保留代码（含字符串字面量）。所有静态扫描都应基于它，避免注释造成假阳性。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // 行注释（避开 http:// 这类）
}
const htmlFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.html'));
const jsFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.js'));
const cssFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.css'));

console.log('静态自检');
console.log(`  扫描：${htmlFiles.length} 个 html / ${jsFiles.length} 个 js / ${cssFiles.length} 个 css`);
console.log('');

// ---------------------------------------------------------------- 1 + 2. HTML

console.log('【1】HTML 资源引用与合规');
const HTML_RULES = [
  { name: '内联 <script>', re: /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, strip: true },
  { name: '行内事件 on*=', re: /\son[a-z]+\s*=\s*["']/gi },
  { name: 'javascript: URI', re: /javascript:/gi },
  { name: '外部 http(s) 引用', re: /(?:src|href)\s*=\s*["'](?:https?:)?\/\//gi },
  { name: '<base>', re: /<base\b/gi },
  { name: '<iframe>', re: /<iframe\b/gi },
  { name: '<object> / <embed>', re: /<object\b|<embed\b/gi },
  { name: 'target="_blank"', re: /target\s*=\s*["']_blank["']/gi },
  { name: 'a[download]', re: /<a\b[^>]*\sdownload(?:\s|=|>)/gi },
];

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  for (const rule of HTML_RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(html);
    if (!m) continue;
    const body = rule.strip ? (m[1] || '').trim() : m[0];
    if (rule.strip && body.length === 0) continue;   // 空的 <script src></script>
    bad(`${rel(f)} 命中「${rule.name}」：${(body || m[0]).slice(0, 60)}`);
  }
  // 资源存在性
  const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let mm;
  let refCount = 0;
  while ((mm = refRe.exec(html)) !== null) {
    const url = mm[1].trim();
    if (!url || url.startsWith('#') || /^(?:data:|blob:|https?:|\/\/)/i.test(url)) continue;
    refCount += 1;
    const target = path.resolve(path.dirname(f), url.split('?')[0].split('#')[0]);
    if (!fs.existsSync(target)) bad(`${rel(f)} 引用的资源不存在：${url}`);
  }
  ok(`${rel(f)}：合规，${refCount} 个本地引用全部存在`);
}

// ---------------------------------------------------------------- 3. DOM id 引用

console.log('');
console.log('【2】DOM 引用完整性（每个 html 单独校验）');
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));

  // 该页加载的脚本
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  const wanted = new Set();
  for (const s of scripts) {
    const p = path.resolve(path.dirname(f), s);
    if (!fs.existsSync(p)) continue;
    const js = fs.readFileSync(p, 'utf8');
    for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) wanted.add(m[1]);
    for (const m of js.matchAll(/\bel\(\s*['"]([^'"]+)['"]\s*\)/g)) wanted.add(m[1]);
  }
  const missing = [...wanted].filter((id) => !htmlIds.has(id));
  if (missing.length) bad(`${rel(f)}：JS 引用了页面中不存在的 id → ${missing.join(', ')}`);
  else ok(`${rel(f)}：${wanted.size} 个 id 引用全部命中（页面共 ${htmlIds.size} 个 id）`);

  const unused = [...htmlIds].filter((id) => !wanted.has(id));
  if (unused.length) info(`${rel(f)} 中未被 JS 引用的 id：${unused.join(', ')}`);
}

// ---------------------------------------------------------------- 4. CSS class

console.log('');
console.log('【3】样式覆盖');
// 内联 <style> 也算样式定义（探针页用它；zip 规范允许内联样式）
const inlineStyles = htmlFiles
  .map((f) => [...fs.readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'))
  .join('\n');
const allCss = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n') + '\n' + inlineStyles;
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const classes = new Set();
  for (const m of html.matchAll(/\bclass\s*=\s*"([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  const missing = [...classes].filter((c) => !allCss.includes('.' + c));
  if (missing.length) info(`${rel(f)} 用到但 CSS 未定义的 class（修饰类可忽略）：${missing.join(', ')}`);
  else ok(`${rel(f)}：${classes.size} 个 class 均有样式定义`);
}

// ---------------------------------------------------------------- 5. 脚本顺序

console.log('');
console.log('【4】脚本加载顺序（被依赖的命名空间必须先加载）');
const NAMESPACE_OWNERS = [
  { file: 'js/core/pitch.js', provides: ['Siren.Pitch'] },
  { file: 'js/core/store.js', provides: ['Siren.Store'] },
  { file: 'js/core/segment.js', provides: ['Siren.Segment'] },
  { file: 'js/core/score.js', provides: ['Siren.Score'] },
  { file: 'js/core/audio.js', provides: ['Siren.Audio'] },
  { file: 'data/melodies.js', provides: ['Siren.MELODIES'] },
  { file: 'js/core/melody.js', provides: ['Siren.Melody'] },
  { file: 'js/core/fleet.js', provides: ['Siren.Fleet'] },
  { file: 'js/core/game.js', provides: ['Siren.Game'] },
  { file: 'js/core/index.js', provides: ['Siren'] },
];

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const order = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)]
    .map((m) => path.relative(GAME, path.resolve(path.dirname(f), m[1])).split(path.sep).join('/'));

  let violation = 0;
  for (let i = 0; i < order.length; i += 1) {
    const jsPath = path.join(GAME, order[i]);
    if (!fs.existsSync(jsPath)) continue;
    const js = fs.readFileSync(jsPath, 'utf8');
    // 该文件使用了哪些命名空间
    for (const owner of NAMESPACE_OWNERS) {
      if (owner.file === order[i]) continue;
      for (const ns of owner.provides) {
        // 只检查"使用"（出现 Siren.X. 调用或 window.Siren.X），排除自身定义
        const uses = new RegExp('Siren\\.' + ns.split('.').pop() + '\\s*[.(]').test(js);
        if (!uses) continue;
        const providerIdx = order.indexOf(owner.file);
        if (providerIdx === -1) {
          bad(`${rel(f)}：${order[i]} 使用了 ${ns}，但没有加载 ${owner.file}`);
          violation += 1;
        } else if (providerIdx > i) {
          bad(`${rel(f)}：${order[i]} 使用了 ${ns}，但 ${owner.file} 排在它后面`);
          violation += 1;
        }
      }
    }
  }
  if (!violation) ok(`${rel(f)}：${order.length} 个脚本的顺序与依赖一致`);
}

// ---------------------------------------------------------------- 6. 后端不得碰 DOM

console.log('');
console.log('【5】后端 core/ 不得出现 DOM 渲染调用（D0 硬规则 1）');
// D0 原文：「后端代码中不得出现任何 document / window 渲染相关调用」——
// 禁的是**渲染**。读取用户输入（兜底模式的打拍监听）不属于渲染，明确放行。
//
// ⚠️ 扫描前必须去掉注释：注释里解释"不要叫 getContext"这类文字会造成假阳性
//    （本项目已踩过一次）。所有静态扫描都应对代码部分进行，而不是全文。
const DOM_FORBIDDEN = [
  /\bdocument\s*\.\s*(?:createElement|createTextNode|querySelector|querySelectorAll|getElementsBy\w+|write|body|head|documentElement)\b/g,
  /\bappendChild\s*\(/g,
  /\binsertBefore\s*\(/g,
  /\bremoveChild\s*\(/g,
  /\binnerHTML\b/g,
  /\btextContent\s*=/g,
  /\bsetAttribute\s*\(/g,
  /\bclassList\b/g,
  /\bgetContext\s*\(/g,
  /\b\.style\s*\.\s*\w+\s*=/g,
  /\brequestAnimationFrame\b/g,
];
// 允许：document.addEventListener / removeEventListener（用户输入，非渲染）
const coreFiles = jsFiles.filter((f) => /[\\/]core[\\/]/.test(f));
for (const f of coreFiles) {
  const js = stripComments(fs.readFileSync(f, 'utf8'));
  const hits = [];
  for (const re of DOM_FORBIDDEN) {
    re.lastIndex = 0;
    const m = re.exec(js);
    if (m) hits.push(m[0].trim());
  }
  if (hits.length) bad(`${rel(f)} 出现 DOM 渲染调用：${hits.join(' , ')}`);
  else ok(`${rel(f)} 无 DOM 渲染调用`);
}

// 明确记录被放行的输入监听，避免"看起来漏检"
for (const f of coreFiles) {
  const js = fs.readFileSync(f, 'utf8');
  if (/document\s*\.\s*(?:add|remove)EventListener/.test(js)) {
    const n = (js.match(/document\s*\.\s*(?:add|remove)EventListener/g) || []).length;
    info(`${rel(f)} 使用 document 事件监听 ${n} 处（用户输入，D0 仅禁渲染，已放行）`);
  }
}

// ---------------------------------------------------------------- 7. 诊断话术

console.log('');
console.log('【6】D13 诊断话术关键词零命中（D7.4 强制删除）');
// D7.4 禁的是**返回给前端的话术**（后端不得返回任何中文文案）。
// 因此只扫字符串字面量所在的代码部分，不扫注释——注释里出现"跑了"这类词是正常说明文字。
const DIAG_WORDS = ['低了', '高了', '早了', '晚了', '少唱', '多唱', '跑了', '别害羞', '再大声', '重唱'];

let diagHits = 0;
for (const f of jsFiles) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  for (const w of DIAG_WORDS) {
    if (code.includes(w)) {
      bad(`${rel(f)} 命中诊断话术「${w}」（后端不得返回任何中文文案）`);
      diagHits += 1;
    }
  }
}
if (!diagHits) ok('全部 js 文件的代码部分零命中（注释不计）');

// ---------------------------------------------------------------- 8. 容器兼容基线

console.log('');
console.log('【7】Chrome 61 兼容基线（小工具容器最低要求）');
// 官方能力清单原文：
//   「小工具最低兼容 Android 8.1 出厂 Chrome / WebView 61」
//   「最终交付代码须编译到 ES2017 / Chrome 61；更高版本语法由构建工具转译」
//   「使用 Chrome 61 基线外的高级 Web API 或 CSS 能力前，必须先检测是否支持」
// 本项目不做构建转译（手写 ES5 风格），所以用静态扫描把这条钉死。
const ES_FORBIDDEN = [
  { re: /\?\.[a-zA-Z_$\[(]/, name: '可选链 ?.（ES2020）', fix: '改写为逐级判空：a && a.b && a.b.c' },
  { re: /\?\?/, name: '空值合并 ??（ES2020）', fix: '改写为 a != null ? a : b' },
  { re: /\|\|=|&&=|\?\?=/, name: '逻辑赋值（ES2021）', fix: '改写为显式赋值' },
  { re: /\bglobalThis\b/, name: 'globalThis（ES2020）', fix: "用 typeof self !== 'undefined' ? self : {} 兜底" },
  { re: /\bBigInt\b|\d+n\b/, name: 'BigInt（ES2020）', fix: '移除' },
  { re: /Object\.fromEntries/, name: 'Object.fromEntries（ES2019）', fix: '手写 reduce' },
  { re: /\.flat\(|\.flatMap\(/, name: 'Array.flat/flatMap（ES2019）', fix: '手写 reduce/concat' },
  { re: /Promise\.allSettled/, name: 'Promise.allSettled（ES2020）', fix: '用 Promise.all + catch' },
  { re: /\.replaceAll\(/, name: 'String.replaceAll（ES2021）', fix: '用 replace + 全局正则' },
  { re: /catch\s*\{/, name: 'catch 省略绑定（ES2019）', fix: '写成 catch (e)' },
  { re: /#\w+\s*[=;(]/, name: 'class 私有字段（ES2022）', fix: '用闭包变量替代' },
  { re: /\bstatic\s*\{/, name: 'class 静态初始化块（ES2022）', fix: '移除' },
];
let baselineHits = 0;
for (const f of jsFiles) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  for (const rule of ES_FORBIDDEN) {
    if (rule.re.test(code)) {
      bad(`${rel(f)} 含 ${rule.name} —— Chrome 61 不支持。${rule.fix}`);
      baselineHits += 1;
    }
  }
}
if (!baselineHits) ok(`${jsFiles.length} 个 js 文件均不含 ES2018+ 语法`);
info('这条只覆盖本仓库的 js；前端若用新语法需自行转译或做能力检测');

// ---------------------------------------------------------------- 汇总

console.log('');
console.log(`扫描完成：${problems.length} 个问题，${infos.length} 条提示`);
if (problems.length) {
  console.log('');
  console.log('问题清单：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(2);
}
console.log('静态自检通过');
