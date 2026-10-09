#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
// Tiny zero-dependency static server for the viewer (replaces `python -m http.server`).
//   node bin/serve.mjs [port]        (default 8777)
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8777);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(
      /^(\.\.[/\\])+/,
      ''
    );
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(file);
    res
      .writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      })
      .end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`apm-trace-viewer → http://localhost:${PORT}/`);
});
