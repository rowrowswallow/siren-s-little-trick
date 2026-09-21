#!/usr/bin/env node
/**
 * 小红书小工具：合规校验 + 打包器（零依赖）
 *
 * 依据 minitool-zip-builder 1.2.0 的三份规范实现：
 *   - references/zip-artifact-spec.md  目录结构 / 文件类型 / CSP / 路径 / 打包自检
 *   - references/device-capabilities.md 禁用 API 扫描清单
 *   - references/cross-platform-h5.md   跨端适配要点
 *
 * 用法：
 *   node tools/pack.mjs                 校验 + 打包到 dist/<name>.zip
 *   node tools/pack.mjs --check-only    只校验，不打包
 *   node tools/pack.mjs --src=game      指定源目录（默认 game）
 *   node tools/pack.mjs --out=dist/x.zip 指定输出文件
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------- 参数解析

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const SRC_DIR = path.resolve(PROJECT_ROOT, String(getArg('src', 'game')));
const CHECK_ONLY = Boolean(getArg('check-only', false));
const OUT_ZIP = path.resolve(
  PROJECT_ROOT,
  String(getArg('out', path.join('dist', 'haixiao-minitool.zip'))),
);

// ---------------------------------------------------------------- 规范常量

/** zip 内允许出现的扩展名（zip-artifact-spec §2） */
const ALLOWED_EXT = new Set([
  '.html', '.css', '.js',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.woff', '.woff2',
  '.json',
]);

/** 明确禁止出现在包内的文件 / 目录（zip-artifact-spec §1） */
const FORBIDDEN_BASENAME = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitignore', '.gitattributes',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);
const FORBIDDEN_DIRNAME = new Set(['node_modules', '.git', '__MACOSX', '.vscode', '.idea']);
const FORBIDDEN_EXT = new Set(['.map', '.ts', '.tsx', '.md', '.zip', '.psd', '.ai', '.bak', '.log']);

/**
 * 体积上限。
 * 三份文档曾给出三个数：官方规范推荐 2MB / PRD 说 10MB 硬顶建议 ≤2MB / 规格书 D1 写 < 500KB。
 * **决策（2026-09）：按 2MB 执行**——留给前端像素图足够空间，同时不碰 PRD 的硬顶。
 * 需要临时收紧时用 --max-size-kb=500。
 */
const TOTAL_SIZE_LIMIT = Number(getArg('max-size-kb', 2048)) * 1024;
const SINGLE_IMAGE_LIMIT = 500 * 1024;    // 单图 < 500KB

/**
 * 默认排除的开发工具目录（不属于小工具产物）。
 * probe = M0 探针（麦克风/性能/采样率），lab = 试唱台（音色试听 + 打分验证）。
 * 随包上传会让容器看到多个 html，也浪费体积。
 * 但它们在源码里保留，仍受 tools/selfcheck.mjs 的全量检查。
 */
const DEFAULT_EXCLUDE = ['js/probe', 'js/lab'];
const EXCLUDES = String(getArg('exclude', DEFAULT_EXCLUDE.join(',')))
  .split(',')
  .map((s) => s.trim().replace(/^[./\\]+/, ''))
  .filter(Boolean);

const excluded = [];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ---------------------------------------------------------------- 两版构建

/** `--no-camera`：产出**不含摄像头**的过审版（PRD §7.5.1.3 / 契约 C7.7） */
const NO_CAMERA = Boolean(getArg('no-camera', false));

/**
 * 摄像头**专有**标识。`--no-camera` 构建用它做残留校验：
 * 产物里只要出现任何一个，就说明切割没切干净，**直接拦下打包**。
 *
 * ⚠️ 刻意**不收**裸 `getUserMedia`：麦克风也用同一个 API
 *    （`getUserMedia({ audio: ... })` 是本作核心，v1.1.0 必须有）。
 *    若把裸 getUserMedia 当摄像头痕迹，麦克风代码会被误报 —— 实测踩过。
 *    摄像头调用一定伴随 `video:` 约束或 `facingMode`，用这两条覆盖即可。
 */
const CAMERA_TOKENS = [
  { re: /\bfacingMode\b/, name: 'facingMode（前置/后置选择）' },
  { re: /\bMediaRecorder\b/, name: 'MediaRecorder（录像）' },
  { re: /\bcaptureStream\b/, name: 'captureStream（画布录制）' },
  { re: /\bvideo\s*:\s*(?:true|\{)/, name: 'getUserMedia 的 video 约束' },
  { re: /getUserMedia\s*\([^)]*\bvideo\b/, name: 'getUserMedia 请求视频轨' },
  { re: /createObjectURL/, name: 'createObjectURL（视频预览常用）' },
];

/**
 * 摄像头代码切割标记（**前端埋标记，打包器负责切除**）。
 *
 * 用法：标记各占一行，且是行注释：
 *
 *   // CAMERA:BEGIN
 *   ...只有带摄像头的版本才存在的代码...
 *   // CAMERA:END
 *
 * `--no-camera` 构建把两标记**连同其间内容**整段删除，并断言零残留。
 * 标记本身也会被删掉，因此产物里不会留下任何线索。
 */
const CAMERA_BEGIN = 'CAMERA:BEGIN';
const CAMERA_END = 'CAMERA:END';

/**
 * 按标记切除摄像头代码。
 * 标记不配对时报错（宁可拦下，也不要产出半截代码）。
 */
function stripCameraBlocks(code, fileRel) {
  const lines = code.split('\n');
  const out = [];
  let inside = false;
  let removed = 0;
  let beginLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inside && line.indexOf(CAMERA_BEGIN) !== -1) {
      inside = true;
      beginLine = i + 1;
      removed += 1;
      continue;
    }
    if (inside) {
      removed += 1;
      if (line.indexOf(CAMERA_END) !== -1) inside = false;
      continue;
    }
    out.push(line);
  }
  if (inside) {
    errors.push({
      file: fileRel,
      message: `CAMERA:BEGIN（第 ${beginLine} 行）没有对应的 CAMERA:END —— 切割标记不配对，` +
        '为避免产出半截代码，已终止打包',
    });
    return { code: code, removedLines: 0, unbalanced: true };
  }
  return { code: out.join('\n'), removedLines: removed, unbalanced: false };
}

/** 扫产物里是否还有摄像头痕迹（--no-camera 的门禁） */
function scanCameraTokens(text) {
  const hits = [];
  for (const t of CAMERA_TOKENS) {
    t.re.lastIndex = 0;
    if (t.re.test(text)) hits.push(t.name);
  }
  return hits;
}

// ---------------------------------------------------------------- 校验规则

/**
 * HTML 规则：{ re, message, allow? }
 * allow(line) 返回 true 表示该行命中属于规范允许的用法，跳过。
 */
const HTML_RULES = [
  {
    re: /<script\b[^>]*>(?!\s*<\/script>)/gi,
    message: '内联 <script> 被容器 CSP 禁止，请外置为 .js 并用 <script src="./..."> 引入',
  },
  {
    re: /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//gi,
    message: '禁止外部域名脚本，脚本必须打包在 zip 内并用相对路径引用',
  },
  {
    re: /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//gi,
    message: '禁止外部域名样式表，样式表必须打包在 zip 内',
  },
  {
    re: /\son[a-z]+\s*=\s*["']/gi,
    message: '禁止行内事件（onclick 等），请用 addEventListener 绑定',
  },
  {
    re: /\b(?:href|src|action|poster)\s*=\s*["']javascript:/gi,
    message: '禁止 javascript: URI',
  },
  { re: /<base\b/gi, message: '禁止使用 <base href>（会破坏真机路径）' },
  { re: /<iframe\b/gi, message: '禁止 <iframe>（容器不支持内嵌框架）' },
  {
    re: /<object\b|<embed\b/gi,
    message: '禁止 <object> / <embed>（容器不支持插件内容）',
  },
  {
    re: /<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy/gi,
    message: '禁止自建 CSP meta（安全策略由容器统一管理）',
  },
  {
    re: /\btarget\s*=\s*["']_blank["']/gi,
    message: '禁止打开新窗口 / 外链（target="_blank"）',
  },
  {
    re: /<a\b[^>]*\sdownload(?:\s|=|>)/gi,
    message: '禁止文件下载（a[download]）',
  },
  {
    re: /<form\b/gi,
    message: '禁止 <form> 跳转提交；输入请用页内组件 + JS 处理',
  },
  {
    re: /(?:src|href)\s*=\s*["']\/[^"']*/gi,
    message: '资源必须用相对路径（./ 开头），绝对路径 / 在离线 zip 中会 404',
  },
  {
    re: /\burl\(\s*["']?(?:https?:)?\/\//gi,
    message: '禁止外部域名资源',
  },
];

/** JS / CSS 规则 */
const CODE_RULES = [
  { re: /\bfetch\s*\(/g, message: '禁止网络请求 fetch()' },
  { re: /\bXMLHttpRequest\b/g, message: '禁止 XMLHttpRequest（不联网）' },
  { re: /\bnavigator\s*\.\s*sendBeacon\b/g, message: '禁止 sendBeacon（不联网）' },
  { re: /\bnew\s+WebSocket\b/g, message: '禁止 WebSocket（不联网）' },
  { re: /\bnew\s+EventSource\b/g, message: '禁止 EventSource（不联网）' },
  { re: /\bnew\s+RTCPeerConnection\b/g, message: '禁止 WebRTC' },
  { re: /\bnew\s+Worker\s*\(/g, message: '禁止 Web Worker，逻辑需放主线程' },
  { re: /\bnew\s+SharedWorker\s*\(/g, message: '禁止 SharedWorker' },
  { re: /\bnavigator\s*\.\s*serviceWorker\b/g, message: '禁止 Service Worker' },
  { re: /\bnavigator\s*\.\s*geolocation\b/g, message: '禁止定位能力' },
  { re: /\bnavigator\s*\.\s*clipboard\b/g, message: '禁止剪贴板 API，改为可选中文本让用户长按复制' },
  { re: /\bdocument\s*\.\s*execCommand\s*\(\s*["'](?:copy|cut|paste)["']/g, message: '禁止 execCommand 剪贴板操作' },
  { re: /\bnavigator\s*\.\s*(?:bluetooth|usb|hid|serial)\b/g, message: '禁止硬件连接能力' },
  { re: /\bnew\s+(?:Accelerometer|Gyroscope|Magnetometer)\s*\(/g, message: '禁止传感器 API，改用指针 / 触摸手势' },
  { re: /\bDevice(?:Motion|Orientation)Event\b/g, message: '禁止设备姿态事件（摇一摇类玩法不可用）' },
  { re: /\bdevicemotion\b|\bdeviceorientation\b/g, message: '禁止设备姿态事件监听' },
  { re: /\bnavigator\s*\.\s*getBattery\b/g, message: '禁止设备信息 API（getBattery）' },
  { re: /\bnavigator\s*\.\s*connection\b/g, message: '禁止设备信息 API（connection）' },
  { re: /\bnavigator\s*\.\s*credentials\b/g, message: '禁止凭据 API（WebAuthn）' },
  { re: /\bnavigator\s*\.\s*locks\b/g, message: '禁止 Web Locks API' },
  { re: /\bnavigator\s*\.\s*storage\s*\.\s*persist\b/g, message: '禁止存储持久化申请' },
  { re: /\bnavigator\s*\.\s*mediaDevices\s*\.\s*enumerateDevices\b/g, message: '禁止设备枚举' },
  { re: /\bnavigator\s*\.\s*mediaDevices\s*\.\s*getDisplayMedia\b/g, message: '禁止屏幕共享' },
  { re: /\.\s*requestFullscreen\b/g, message: '禁止全屏 API，视觉全屏请用 CSS 布局实现' },
  { re: /\beval\s*\(/g, message: '禁止 eval()' },
  { re: /\bnew\s+Function\s*\(/g, message: '禁止 new Function() 动态执行代码' },
  { re: /\bWebAssembly\b/g, message: '禁止 WebAssembly' },
  { re: /\bwindow\s*\.\s*open\s*\(/g, message: '禁止 window.open 打开新窗口' },
  { re: /\bwindow\s*\.\s*prompt\s*\(/g, message: '禁止 window.prompt，输入请用页内 Modal' },
  { re: /\blocation\s*\.\s*(?:href\s*=|assign\s*\(|replace\s*\()/g, message: '禁止跳转站外 URL' },
  { re: /\bhttps?:\/\//g, message: '出现 http(s):// 链接，外部资源一律加载不到' },
];

const CONTEXT_WINDOW = 3;

// ---------------------------------------------------------------- 工具函数

const rel = (abs) => path.relative(PROJECT_ROOT, abs).split(path.sep).join('/');
const kb = (n) => `${(n / 1024).toFixed(n < 1024 * 100 ? 1 : 0)}KB`;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/') });
  }
  return out;
}

function findLine(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

// ---------------------------------------------------------------- 校验

const errors = [];
const warnings = [];
const notes = [];

const fail = (file, message, line, snippet) =>
  errors.push({ file, message, line, snippet: (snippet || '').trim().slice(0, 120) });
const warn = (file, message, line) => warnings.push({ file, message, line });

function scanText(fileRel, text, rules) {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex += 1; continue; }
      const line = findLine(text, m.index);
      const lines = text.split('\n');
      const context = lines.slice(Math.max(0, line - 1 - CONTEXT_WINDOW), line + CONTEXT_WINDOW).join('\n');
      if (rule.allow && rule.allow(context, m[0])) continue;
      fail(fileRel, rule.message, line, lines[line - 1]);
    }
  }
}

function validateStructure(files) {
  const entry = files.find((f) => f.rel === 'index.html');
  if (!entry) {
    fail('zip', 'index.html 必须存在于源目录根（容器唯一入口，不可改名 / 不可放子目录）');
  }

  const htmlCount = files.filter((f) => f.rel.toLowerCase().endsWith('.html')).length;
  if (htmlCount > 1) {
    warn('zip', `包内有 ${htmlCount} 个 html 文件；规范要求单页应用，视图切换请用 JS 操作 DOM`);
  }

  for (const f of files) {
    const segs = f.rel.split('/');
    const base = segs[segs.length - 1];
    const ext = path.extname(base).toLowerCase();
    const dirs = segs.slice(0, -1);

    if (dirs.some((d) => FORBIDDEN_DIRNAME.has(d))) {
      fail(f.rel, `禁止目录 ${dirs.find((d) => FORBIDDEN_DIRNAME.has(d))}/ 出现在 zip 内`);
    } else if (FORBIDDEN_BASENAME.has(base)) {
      fail(f.rel, `禁止文件 ${base} 出现在 zip 内`);
    } else if (FORBIDDEN_EXT.has(ext)) {
      fail(f.rel, `禁止的文件类型 ${ext}（见 zip-artifact-spec §2 支持列表）`);
    } else if (!ALLOWED_EXT.has(ext)) {
      fail(f.rel, `不支持的文件类型 ${ext || '(无扩展名)'}`);
    }

    if (base !== base.normalize('NFC')) warn(f.rel, '文件名含非 NFC 规范化字符，部分环境下可能路径不匹配');
    if (/[^\x20-\x7E]/.test(f.rel) === false && /[\u4e00-\u9fa5]/.test(f.rel)) {
      warn(f.rel, '路径含中文；建议改用 ASCII 路径以规避跨端编码差异');
    }
    if (f.rel.includes(' ')) warn(f.rel, '路径含空格，建议改为连字符');
  }

  const total = files.reduce((s, f) => s + f.size, 0);
  const limitKb = TOTAL_SIZE_LIMIT / 1024;
  const limitText = limitKb >= 1024 ? (limitKb / 1024) + 'MB' : limitKb + 'KB';
  if (total > TOTAL_SIZE_LIMIT) {
    fail('zip', `总包体积 ${kb(total)} 超过上限 ${limitText}`);
  } else {
    notes.push(`包内总体积 ${kb(total)}（上限 ${limitText}，2026-09 决策，见 docs/规格问题清单.md B5）`);
  }

  for (const f of files) {
    if (IMAGE_EXT.has(path.extname(f.rel).toLowerCase()) && f.size > SINGLE_IMAGE_LIMIT) {
      warn(f.rel, `单图 ${kb(f.size)} 超过建议上限 500KB`);
    }
  }
}

/** 页面引用的本地资源必须真实存在（html 属性 / css url() / js 里的 assets 与 data 路径） */
function collectReferences(rel, text) {
  // html 与 css 的相对路径以自身所在目录为基准；js 里的路径由浏览器按文档基址解析，
  // 也就是包根目录 —— main.js 写 './assets/...' 指的是 assets/...，不是 js/assets/...。
  const found = [];
  const push = (raw, index, base) => {
    const url = (raw || '').trim();
    if (!url || url.startsWith('#') || /^(?:data:|blob:|https?:|\/\/)/i.test(url)) return;
    const clean = url.split('?')[0].split('#')[0].replace(/^\.\//, '');
    const target = base ? path.posix.normalize(path.posix.join(base, clean)) : path.posix.normalize(clean);
    found.push({ url, target, index });
  };
  const dir = rel.includes('/') ? path.posix.dirname(rel) : '';
  let m;
  if (/\.(?:html|css)$/i.test(rel)) {
    const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    while ((m = attrRe.exec(text)) !== null) push(m[1], m.index, dir);
    const cssRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi;
    while ((m = cssRe.exec(text)) !== null) push(m[1] || m[2] || m[3], m.index, dir);
  }
  if (/\.js$/i.test(rel)) {
    // 只认打包进来的资源目录，避免把普通字符串当成路径。
    const jsRe = /["'`]((?:\.{0,2}\/)?(?:assets|data)\/[^"'`]+)["'`]/gi;
    while ((m = jsRe.exec(text)) !== null) push(m[1], m.index, '');
  }
  return found;
}

function validateReferences(files) {
  const present = new Set(files.map((f) => f.rel));
  const referenced = new Set(['index.html']);

  for (const f of files) {
    if (!/\.(?:html|css|js)$/i.test(f.rel)) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }

    if (/^﻿/.test(text)) warn(f.rel, '文件含 BOM，建议去掉');

    for (const ref of collectReferences(f.rel, text)) {
      referenced.add(ref.target);
      if (!present.has(ref.target)) {
        fail(f.rel, `引用的资源不存在于包内：${ref.url}（期望 ./${ref.target}）`, findLine(text, ref.index));
      }
    }
  }

  // 反向检查：孤儿资源（不是错误，只提示）
  // 授权文本按 OFL 要求必须随包分发，本来就不会被页面引用，不当作冗余。
  const shipUnreferenced = /(?:^|\/)(?:license|licence|ofl)[^/]*\.(?:json|txt|md)$/i;
  for (const f of files) {
    if (referenced.has(f.rel) || shipUnreferenced.test(f.rel)) continue;
    warn(f.rel, '包内未被任何 html/css/js 引用的文件（可能是冗余资源）');
  }
}

/** 检查 index.html 的必需项 */
function validateEntry(files) {
  const entry = files.find((f) => f.rel === 'index.html');
  if (!entry) return;
  const text = fs.readFileSync(entry.abs, 'utf8');

  const must = [
    [/<!DOCTYPE html>/i, '缺少 <!DOCTYPE html>'],
    [/<html[^>]*\blang\s*=\s*["']zh-CN["']/i, '<html> 缺少 lang="zh-CN"'],
    [/<meta[^>]*charset\s*=\s*["']?UTF-8/i, '缺少 <meta charset="UTF-8">'],
    [/<meta[^>]*name\s*=\s*["']viewport["'][^>]*content\s*=\s*["'][^"']*width=device-width/i, 'viewport 缺少 width=device-width'],
    [/<meta[^>]*name\s*=\s*["']viewport["'][^>]*content\s*=\s*["'][^"']*initial-scale=1\.0/i, 'viewport 缺少 initial-scale=1.0'],
    [/<meta[^>]*name\s*=\s*["']viewport["'][^>]*content\s*=\s*["'][^"']*viewport-fit=cover/i, 'viewport 缺少 viewport-fit=cover（安全区）'],
    [/<title>[^<]+<\/title>/i, '缺少 <title>'],
  ];
  for (const [re, message] of must) if (!re.test(text)) fail('index.html', message);

  // 脚本必须外置
  const scriptTags = text.match(/<script\b[^>]*>/gi) || [];
  if (scriptTags.length === 0) warn('index.html', 'index.html 未引入任何脚本');
}

// ---------------------------------------------------------------- ZIP 写入器

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 手写 ZIP（deflate + UTF-8 文件名标志位），避免引入 node_modules */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const crc = crc32(raw);

    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x0800, 8);           // UTF-8 标志
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);  // external attrs: -rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------- 主流程

function main() {
  console.log('小红书小工具 · 合规校验与打包');
  console.log(`规范版本 minitool-zip-builder 1.2.0`);
  console.log(`源目录：${rel(SRC_DIR)}`);
  console.log('');

  if (!fs.existsSync(SRC_DIR)) {
    console.error(`源目录不存在：${SRC_DIR}`);
    process.exit(1);
  }

  const allFiles = walk(SRC_DIR).map((f) => ({ ...f, size: fs.statSync(f.abs).size }));
  if (allFiles.length === 0) {
    console.error('源目录为空');
    process.exit(1);
  }

  // 排除开发工具目录（默认 js/probe）
  const files = allFiles.filter((f) => {
    const hit = EXCLUDES.find((ex) => f.rel === ex || f.rel.startsWith(ex + '/'));
    if (hit) { excluded.push(f.rel); return false; }
    return true;
  });
  if (files.length === 0) {
    console.error('排除后源目录为空，请检查 --exclude 参数');
    process.exit(1);
  }

  // 1) 结构 / 体积 / 文件类型
  validateStructure(files);
  // 2) 入口模板必需项
  validateEntry(files);
  // 3) 资源引用完整性
  validateReferences(files);
  // 4) 禁用能力扫描
  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase();
    if (ext === '.html') scanText(f.rel, fs.readFileSync(f.abs, 'utf8'), HTML_RULES);
    else if (ext === '.js' || ext === '.css') scanText(f.rel, fs.readFileSync(f.abs, 'utf8'), CODE_RULES);
  }

  // ---- 输出报告
  console.log(`包内文件 ${files.length} 个：`);
  for (const f of files) console.log(`  · ${f.rel}  (${kb(f.size)})`);
  if (excluded.length) {
    console.log('');
    console.log(`已排除 ${excluded.length} 个开发工具文件（不进上传包）：`);
    for (const e of excluded) console.log(`  – ${e}`);
  }
  console.log('');
  for (const n of notes) console.log(`  ℹ ${n}`);

  if (warnings.length) {
    console.log('');
    console.log(`警告 ${warnings.length} 条：`);
    for (const w of warnings) console.log(`  ⚠ ${w.file}${w.line ? `:${w.line}` : ''} — ${w.message}`);
  }

  if (errors.length) {
    console.log('');
    console.log(`错误 ${errors.length} 条（必须修复，否则容器会部署失败）：`);
    for (const e of errors) {
      console.log(`  ✗ ${e.file}${e.line ? `:${e.line}` : ''} — ${e.message}`);
      if (e.snippet) console.log(`      > ${e.snippet}`);
    }
    console.log('');
    console.log('校验未通过，已终止打包。');
    process.exit(2);
  }

  console.log('');
  console.log('✓ 校验通过：结构 / 文件类型 / CSP / 端能力 / 引用完整性 全部符合规范');

  // ---------------- 两版构建：--no-camera 时按标记切除摄像头代码 ----------------
  const entries = files.map((f) => ({ name: f.rel, data: fs.readFileSync(f.abs) }));

  if (NO_CAMERA) {
    console.log('');
    console.log('【过审版构建】--no-camera：切除摄像头相关代码');
    let strippedTotal = 0;
    let strippedFiles = 0;
    for (const e of entries) {
      const isText = /\.(?:html|css|js|json)$/i.test(e.name);
      if (!isText) continue;
      const text = e.data.toString('utf8');
      if (text.indexOf(CAMERA_BEGIN) === -1) continue;
      const r = stripCameraBlocks(text, e.name);
      if (r.unbalanced) {
        console.log('');
        console.log('切割标记不配对，已终止打包。');
        process.exit(2);
      }
      e.data = Buffer.from(r.code, 'utf8');
      strippedTotal += r.removedLines;
      strippedFiles += 1;
      console.log(`  · ${e.name}：删除 ${r.removedLines} 行`);
    }
    if (!strippedFiles) {
      console.log('  ℹ 未发现任何 CAMERA:BEGIN 标记 —— 前端尚未引入摄像头代码，本版天然不含');
    } else {
      console.log(`  合计删除 ${strippedTotal} 行，涉及 ${strippedFiles} 个文件`);
    }

    // 残留门禁：切割后绝不能还有任何摄像头痕迹
    const leaks = [];
    for (const e of entries) {
      if (!/\.(?:html|css|js|json)$/i.test(e.name)) continue;
      const hits = scanCameraTokens(e.data.toString('utf8'));
      if (hits.length) leaks.push(`${e.name} → ${hits.join(', ')}`);
    }
    if (leaks.length) {
      console.log('');
      console.log('✗ 摄像头残留校验未通过（过审版必须零残留）：');
      for (const l of leaks) console.log('  ✗ ' + l);
      console.log('');
      console.log('请把摄像头代码包进 // CAMERA:BEGIN ... // CAMERA:END 标记里，再重新打包。');
      process.exit(2);
    }
    console.log('  ✓ 残留校验通过：产物中零摄像头痕迹（权限申请时不要勾摄像头）');
  }

  if (CHECK_ONLY) {
    console.log('');
    console.log('（--check-only：跳过打包）');
    return;
  }

  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(OUT_ZIP), { recursive: true });
  fs.writeFileSync(OUT_ZIP, zip);

  const sha = createHash('sha256').update(zip).digest('hex').slice(0, 12);
  console.log('');
  console.log(`✓ 已打包：${rel(OUT_ZIP)}  (${kb(zip.length)}, sha256:${sha})`);
  console.log(`  zip 根目录即入口：index.html 位于根，解压后顶层直接是文件`);
  if (NO_CAMERA) {
    console.log('  版本：**过审版（无摄像头）** —— 权限只勾麦克风 + 本地存储');
  } else {
    console.log('  版本：**完整版（含摄像头，若有标记）** —— 需额外勾选摄像头权限');
  }
  console.log('');
  console.log('下一步：把该 zip 上传到小红书「小工具」后台，选择版本号与所需权限后发布。');
}

main();
