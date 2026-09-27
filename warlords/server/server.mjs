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
//   POST /api/rooms  a server-hosted ("headless") room: its match runs in a worker_thread here,
//                    not in a player's browser (rooms.mjs) — when dist-headless/room-worker.mjs
//                    exists (`npm run build:headless`); else 503 and the client hosts in its browser
//
// Env: PORT (8787), HOST (0.0.0.0), DIST_DIR (../dist), NO_PEER=1 disables /peerjs,
//      HEADLESS=0 disables server-hosted rooms, HEADLESS_MAX_ROOMS (4) at once.
// Embeddable: `import { startServer } from './server/server.mjs'` (Electron).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost, lanAddressesFrom } from './lan.mjs';
import { createRelay } from './relay.mjs';
import { createHeadlessRooms } from './rooms.mjs';

export { rankLanAddresses } from './lan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(HERE, '..', 'dist');
const PEER_MOUNT = '/peerjs';
const DEFAULT_WORKER = path.resolve(HERE, '..', 'dist-headless', 'room-worker.mjs');
/** Largest POST /api/rooms body accepted (bytes). */
const ROOMS_BODY_LIMIT = 2048;
/** Players a room seats at most (src/net/hostSession.ts MAX_PLAYERS). */
const ROOM_SEATS = 8;

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

/**
 * Non-internal IPv4 addresses of this machine, best first: typical Wi-Fi /
 * Ethernet 192.168.x / 10.x adapters before virtual / host-only ones
 * (VirtualBox, Hyper-V / WSL vEthernet, Docker, VPN tunnels — see lan.mjs).
 */
export function lanAddresses() {
  return lanAddressesFrom(os.networkInterfaces());
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

/** `::ffff:1.2.3.4` → `1.2.3.4` */
const plainIp = (ip) => String(ip ?? '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');

/**
 * The client's address for rate limits: the socket's peer — unless that is this machine (a local
 * reverse proxy: Tailscale Funnel / Caddy), then the first X-Forwarded-For entry the proxy wrote.
 */
export function clientIp(req) {
  const peer = plainIp(req.socket?.remoteAddress);
  if (isLoopbackHost(peer)) {
    const xff = req.headers?.['x-forwarded-for'];
    const first = plainIp((Array.isArray(xff) ? xff[0] : (xff ?? '')).split(',')[0]);
    if (first) return first.slice(0, 64);
  }
  return peer || 'unknown';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS,
    ...extra,
  });
  res.end(body);
}

/** Read a request body of at most `limit` bytes: the text, or null when it is larger. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * POST /api/rooms {name?, lang?} → 201 {code, ownerKey} | 400 | 413 | 429 | 503 | 500 (see rooms.mjs).
 * JSON or text/plain bodies (text/plain: a page on another origin — GitHub Pages — posts without a
 * CORS preflight); every answer carries Access-Control-Allow-Origin: *.
 */
async function handleRoomsApi(req, res, rooms) {
  if (req.method === 'OPTIONS') {
    const pna = req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {};
    res.writeHead(204, { ...CORS, ...pna });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST, OPTIONS' });
    return;
  }
  if (!rooms.available()) {
    sendJson(res, 503, { error: 'headless-unavailable' });
    return;
  }
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json' && type !== 'text/plain') {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  let text;
  try {
    text = await readBody(req, ROOMS_BODY_LIMIT);
  } catch {
    if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  if (text === null) {
    sendJson(res, 413, { error: 'too-large' }, { Connection: 'close' });
    return;
  }
  let body = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  try {
    const room = await rooms.create(clientIp(req), { name: body.name, lang: body.lang });
    sendJson(res, 201, { code: room.code, ownerKey: room.ownerKey });
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : 500;
    sendJson(res, status, { error: typeof err?.code === 'string' ? err.code : 'worker-failed' });
  }
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
 * The relay address this server's room workers use: loopback when it listens on every
 * interface (or on loopback), else the one address it listens on.
 */
function selfRelayUrl(server) {
  const addr = server?.address();
  if (!addr || typeof addr !== 'object') return 'ws://127.0.0.1/ws';
  const a = addr.address;
  const host = a === '0.0.0.0' || a === '::' || /^(::ffff:)?127\./.test(a) ? '127.0.0.1' : a.includes(':') ? `[${a}]` : a;
  return `ws://${host}:${addr.port}/ws`;
}

/**
 * Start the server.
 * @param {{ port?: number, host?: string, distDir?: string, peer?: boolean, quiet?: boolean,
 *           log?: (msg: string) => void, workerPath?: string,
 *           headless?: boolean | { maxRooms?: number, perIpPerMin?: number, readyTimeoutMs?: number,
 *                                  emptyLobbyMs?: number, noHumansMs?: number, pauseAfterFailures?: number,
 *                                  pauseMs?: number } }} [opts]
 *   workerPath: the server-hosted room bundle (default ../dist-headless/room-worker.mjs);
 *   headless: false turns server-hosted rooms off (default: on unless HEADLESS=0 — and only
 *   while the bundle exists); an object tunes them.
 * @returns {Promise<{ port: number, close(): Promise<void>, urls: string[], relay: ReturnType<typeof createRelay>,
 *                     rooms: ReturnType<typeof createHeadlessRooms> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (Number(process.env.PORT) || 8787);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const distDir = opts.distDir ?? process.env.DIST_DIR ?? DEFAULT_DIST;
  const log = opts.quiet ? () => {} : (opts.log ?? ((m) => console.log(m)));
  const wantPeer = opts.peer ?? process.env.NO_PEER !== '1';

  const relay = createRelay({ log: opts.quiet ? undefined : log });
  const serveStatic = createStaticHandler(distDir);
  const headlessOpts = typeof opts.headless === 'object' && opts.headless ? opts.headless : {};
  const workerPath = opts.workerPath ?? process.env.HEADLESS_WORKER ?? DEFAULT_WORKER;
  const maxRooms = headlessOpts.maxRooms ?? (Number(process.env.HEADLESS_MAX_ROOMS) || 4);
  /** @type {http.Server | undefined} */
  let server;
  const rooms = createHeadlessRooms({
    workerPath,
    relayUrl: () => selfRelayUrl(server),
    enabled: opts.headless === undefined ? process.env.HEADLESS !== '0' : opts.headless !== false,
    maxRooms,
    perIpPerMin: headlessOpts.perIpPerMin,
    readyTimeoutMs: headlessOpts.readyTimeoutMs,
    emptyLobbyMs: headlessOpts.emptyLobbyMs,
    noHumansMs: headlessOpts.noHumansMs,
    pauseAfterFailures: headlessOpts.pauseAfterFailures,
    pauseMs: headlessOpts.pauseMs,
    workerLog: !opts.quiet,
    log,
    // the room's host is this server, not a player: one more socket so it seats ROOM_SEATS humans
    onReady: (code) => relay.setRoomLimit(code, ROOM_SEATS + 1),
    // a worker gone for good: its guests hear so now, not after the relay's host grace
    onExit: (code) => {
      if (code) relay.endRoom(code);
    },
  });
  /** @type {Awaited<ReturnType<typeof createPeerMount>>} */
  let peerMount = null;

  server = http.createServer((req, res) => {
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
        ...rooms.stats(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }
    if (pathname === '/api/rooms' || pathname === '/api/rooms/') {
      handleRoomsApi(req, res, rooms).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'worker-failed' });
        else res.destroy();
      });
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

  // bound to loopback (HOST=127.0.0.1): nobody else can connect — do not advertise a "LAN" address
  const lanOff = isLoopbackHost(host);
  const ips = lanOff ? [] : host === '0.0.0.0' || host === '::' ? lanAddresses() : [host];
  const urls = [`http://localhost:${actualPort}`, ...ips.map((ip) => `http://${ip}:${actualPort}`)];
  const lines = [
    '',
    '  三国杀·枪火乱世 服务器已启动 / Sanguo Warlords server is running',
    '',
    `  本机访问 Local:        http://localhost:${actualPort}`,
    ...(lanOff
      ? [`  局域网访问 LAN:        未开启（只监听 ${host}）。允许局域网访问请设置 HOST=0.0.0.0`, `                         off (listening on ${host} only) — set HOST=0.0.0.0 to let LAN players in`]
      : ips.length
        ? ips.map((ip, i) => `  局域网访问 LAN:        http://${ip}:${actualPort}${i === 0 && ips.length > 1 ? '   ← 推荐 / best guess' : ''}`)
        : ['  局域网访问 LAN:        未检测到局域网地址 / no LAN address found']),
    '',
    `  联机中继 WS relay:     ${ips.length ? ips.map((ip) => `ws://${ip}:${actualPort}/ws`).join('  ') : `ws://localhost:${actualPort}/ws`}`,
    peerMount
      ? `  PeerJS 信令 signalling: host=${ips[0] ?? 'localhost'} port=${actualPort} path=${PEER_MOUNT} (secure=off)`
      : '  PeerJS 信令 signalling: 未启用 / disabled',
    fs.existsSync(distDir) ? `  游戏文件 Game files:    ${distDir}` : `  ⚠ 未找到游戏文件，请先运行 npm run build / dist not found — run npm run build first (${distDir})`,
    rooms.available()
      ? `  服务器托管对局 Server-hosted matches: 开启 on (≤ ${maxRooms} rooms)`
      : `  服务器托管对局 Server-hosted matches: 关闭 off (${fs.existsSync(workerPath) ? 'HEADLESS=0' : '未构建 not built — npm run build:headless'})`,
    '',
    lanOff ? '  本机玩家用浏览器打开上面的本机地址即可；' : '  同一局域网的玩家用浏览器打开上面的局域网地址即可联机（选择「服务器」模式）；',
    '  使用其他网页版时，在「设置 → 网络 → 中转服务器地址」中填写上面的 WS relay 地址。',
    lanOff
      ? '  Open the local URL above in a browser on this machine.'
      : '  Players on the same network open the LAN URL above (choose Server mode).',
    '  From another copy of the game, enter the WS relay address in Settings → Network → Relay server URL.',
    '',
  ];
  log(lines.join('\n'));

  let closing = null;
  return {
    port: actualPort,
    urls,
    relay,
    rooms,
    close() {
      if (closing) return closing;
      closing = (async () => {
        // the server-hosted rooms first: they say goodbye to their players through the relay
        await rooms.shutdown();
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
      // launchd / systemd stop or update the service with SIGTERM: server-hosted rooms tell their
      // players first (≤ 3 s), then everything closes; a second signal ends it at once
      let stopping = false;
      const shutdown = (sig) => {
        if (stopping) process.exit(0);
        stopping = true;
        console.log(`${sig}: 正在关闭 / shutting down`);
        srv.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 6000).unref();
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
