#!/usr/bin/env node
/**
 * 本地预览服务器：只服务 game/ 目录，方便在浏览器里调试同一份产物。
 * 仅开发用，不参与打包。
 *
 * 用法：node tools/serve.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'game');
const PORT = Number(process.argv[2] || 5599);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath.endsWith('/')) urlPath += 'index.html';

  const target = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`预览地址：http://127.0.0.1:${PORT}/`);
  console.log(`源目录：${ROOT}`);
  console.log('改完 game/ 里的文件刷新页面即可；打包请运行 node tools/pack.mjs');
console.log('');
console.log('  /                     完整游戏：主视觉、哼唱/点拍、终局与分享卡');
console.log('  /js/probe/probe.html  M0 探针：验证麦克风 / 音高 / 性能 / 延迟');
console.log('');
console.log('注：探针页必须走 http（file:// 下浏览器会拒绝 getUserMedia）。');
});
