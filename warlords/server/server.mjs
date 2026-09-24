#!/usr/bin/env node
// 三国杀·枪火乱世 — LAN / self-host server (`npm run server`).
//
// One port serves everything:
//   GET  /*          the built game (../dist), SPA fallback, correct MIME types
//   WS   /ws         room relay for WebSocket mode (see relay.mjs)
//   HTTP+WS /peerjs  PeerJS signalling server (package `peer`), so players whose
//                    network blocks the public PeerJS cloud can use this host:
//                    Settings → peerHost=<this ip>, peerPort=<port>, peerPath=/peerjs, secure=off
//   GET  /sgwl.json  server info (used by the client to detect "served by our server")
//
// Env: PORT (8787), HOST (0.0.0.0), DIST_DIR (../dist), NO_PEER=1 disables /peerjs.
// Embeddable: `import { startServer } from './server/server.mjs'` (Electron).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(HERE, '..', 'dist');
const PEER_MOUNT = '/peerjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** Non-internal IPv4 addresses of this machine. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const NO_BUILD_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>三国杀·枪火乱世 服务器</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1410;color:#f3e6c8;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6}code{background:#2c2219;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>三国杀·枪火乱世 · 服务器运行中</h1>
<p>未找到游戏文件（dist/）。请先在 <code>warlords/</code> 目录运行 <code>npm run build</code>，然后重启服务器。</p>
<p>Game files (dist/) not found. Run <code>npm run build</code> in <code>warlords/</code> first, then restart the server.</p>
<p>联机中继 / relay: <code>/ws</code> · PeerJS 信令 / signalling: <code>/peerjs</code></p></body></html>`;

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
  res.end(body);
}

function createStaticHandler(distDir) {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');

  const statFile = (p) =>
    new Promise((resolve) => {
      fs.stat(p, (err, st) => resolve(err ? null : st));
    });

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (rel.includes('\0')) {
      sendText(res, 400, 'Bad request');
      return;
    }
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    let st = await statFile(file);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await statFile(file);
    }
    if (!st || !st.isFile()) {
      // SPA fallback for page routes; real 404 for missing assets
      const ext = path.extname(rel);
      const wantsHtml = !ext || ext === '.html';
      const indexStat = wantsHtml ? await statFile(indexFile) : null;
      if (indexStat?.isFile()) {
        file = indexFile;
        st = indexStat;
      } else if (wantsHtml && !(await statFile(root))) {
        sendText(res, 200, NO_BUILD_PAGE, 'text/html; charset=utf-8');
        return;
      } else {
        sendText(res, 404, 'Not found');
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    const isIndex = path.basename(file) === 'index.html';
    const hashedAsset = /[\\/]assets[\\/]/.test(file) && /[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isIndex ? 'no-cache' : hashedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}

/**
 * Mount the PeerJS signalling server (package `peer`, which needs express) under
 * /peerjs on our own http server. Its WebSocket endpoint is served through our
 * single 'upgrade' router. Returns null if the packages are unavailable.
 */
async function createPeerMount(server, log) {
  let ExpressPeerServer;
  let express;
  let WebSocketServer;
  try {
    ({ ExpressPeerServer } = await import('peer'));
    express = (await import('express')).default;
    ({ WebSocketServer } = await import('ws'));
  } catch (err) {
    log(`[peerjs] signalling disabled (packages "peer"/"express" not available): ${err?.message ?? err}`);
    return null;
  }
  let peerWss = null;
  const app = express();
  app.disable('x-powered-by');
  const peerApp = ExpressPeerServer(server, {
    path: '/',
    key: 'peerjs',
    allow_discovery: false,
    proxied: false,
    alive_timeout: 60000,
    expire_timeout: 5000,
    concurrent_limit: 5000,
    createWebSocketServer: (options) => {
      peerWss = new WebSocketServer({ noServer: true, path: options.path, perMessageDeflate: false });
      return peerWss;
    },
  });
  peerApp.on('error', (err) => log(`[peerjs] ${err?.message ?? err}`));
  app.use(PEER_MOUNT, peerApp); // 'mount' creates the websocket server via our factory
  return {
    handle: (req, res) => app(req, res),
    handleUpgrade(req, socket, head) {
      if (!peerWss) {
        socket.destroy();
        return;
      }
      peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req));
    },
    close() {
      if (!peerWss) return;
      for (const ws of peerWss.clients) ws.terminate();
      peerWss.close();
    },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start the server.
 * @param {{ port?: number, host?: string, distDir?: string, peer?: boolean, quiet?: boolean,
 *           log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ port: number, close(): Promise<void>, urls: string[], relay: ReturnType<typeof createRelay> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (Number(process.env.PORT) || 8787);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const distDir = opts.distDir ?? process.env.DIST_DIR ?? DEFAULT_DIST;
  const log = opts.quiet ? () => {} : (opts.log ?? ((m) => console.log(m)));
  const wantPeer = opts.peer ?? process.env.NO_PEER !== '1';

  const relay = createRelay({ log: opts.quiet ? undefined : log });
  const serveStatic = createStaticHandler(distDir);
  /** @type {Awaited<ReturnType<typeof createPeerMount>>} */
  let peerMount = null;

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (pathname === '/sgwl.json') {
      const body = JSON.stringify({
        app: 'sanguo-warlords',
        relay: '/ws',
        peer: peerMount ? PEER_MOUNT : null,
        ...relay.stats(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }
    if (peerMount && (pathname === PEER_MOUNT || pathname.startsWith(PEER_MOUNT + '/'))) {
      peerMount.handle(req, res);
      return;
    }
    serveStatic(req, res, pathname).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5000;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    if (pathname === '/ws' || pathname === '/ws/') relay.handleUpgrade(req, socket, head);
    else if (peerMount && pathname.startsWith(PEER_MOUNT + '/')) peerMount.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  if (wantPeer) peerMount = await createPeerMount(server, log);
  await listen(server, port, host);
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  const ips = host === '0.0.0.0' || host === '::' ? lanAddresses() : [host];
  const urls = [`http://localhost:${actualPort}`, ...ips.map((ip) => `http://${ip}:${actualPort}`)];
  const lines = [
    '',
    '  三国杀·枪火乱世 服务器已启动 / Sanguo Warlords server is running',
    '',
    `  本机访问 Local:        http://localhost:${actualPort}`,
    ...ips.map((ip) => `  局域网访问 LAN:        http://${ip}:${actualPort}`),
    '',
    `  联机中继 WS relay:     ${ips.length ? ips.map((ip) => `ws://${ip}:${actualPort}/ws`).join('  ') : `ws://localhost:${actualPort}/ws`}`,
    peerMount
      ? `  PeerJS 信令 signalling: host=${ips[0] ?? 'localhost'} port=${actualPort} path=${PEER_MOUNT} (secure=off)`
      : '  PeerJS 信令 signalling: 未启用 / disabled',
    fs.existsSync(distDir) ? `  游戏文件 Game files:    ${distDir}` : `  ⚠ 未找到游戏文件，请先运行 npm run build / dist not found — run npm run build first (${distDir})`,
    '',
    '  同一局域网的玩家用浏览器打开上面的局域网地址即可联机；',
    '  或在「设置 → 联机服务器」中填写以上地址。',
    '  Players on the same network open the LAN URL above, or enter these addresses in Settings → Server.',
    '',
  ];
  log(lines.join('\n'));

  let closing = null;
  return {
    port: actualPort,
    urls,
    relay,
    close() {
      if (closing) return closing;
      closing = (async () => {
        peerMount?.close();
        await relay.close();
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      })();
      return closing;
    },
  };
}

// CLI entry: `node server/server.mjs` / `npm run server`
const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  startServer()
    .then((srv) => {
      const shutdown = () => {
        srv.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err?.code === 'EADDRINUSE') {
        console.error(`端口已被占用 / Port already in use: ${err.port ?? ''}. 设置 PORT 环境变量换一个端口 / set PORT to use another port.`);
      } else {
        console.error('服务器启动失败 / Server failed to start:', err);
      }
      process.exit(1);
    });
}
