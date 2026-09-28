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
//      HEADLESS=0 disables server-hosted rooms, HEADLESS_MAX_ROOMS (4) at once,
//      HEADLESS_ROOMS_PER_IP (2) of them per client address,
//      RELAY_KEY: the access key (unset / empty: open, as on a LAN) — /ws needs ?k=<key>, POST
//        /api/rooms ?k=<key> or the header X-SGWL-Key, /peerjs likewise (else 401); the page,
//        /sgwl.json ({keyRequired}) and the game files stay public,
//      MAX_ROOMS (1000) relay rooms at once, HOST_GRACE_MS (120000) a dropped host's room waits,
//      MAX_SOCKETS_PER_IP (8) relay sockets per client address (loopback exempt),
//      SGWL_GIT_SHA the commit this build is (else ../.sgwl-sha, written by deploy/install.sh).
// Static files: precompressed .br / .gz next to a file (scripts/precompress.mjs, run by
// deploy/install.sh after the build) are served to browsers that accept them; text files without
// one are compressed on the fly (cached); weak ETags + 304; hashed assets/* cache for a year,
// index.html revalidates, the rest caches a day (stale-while-revalidate a week).
// Logs: ISO timestamps, a line per relay connect / close (rate-limited), a stats line a minute.
// Embeddable: `import { startServer } from './server/server.mjs'` (Electron).
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { isLoopbackHost, lanAddressesFrom } from './lan.mjs';
import { createRelay, MAX_PLAYERS, ROOM_SLACK } from './relay.mjs';
import { createHeadlessRooms, createLineLimiter } from './rooms.mjs';

export { rankLanAddresses } from './lan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(HERE, '..', 'dist');
const PEER_MOUNT = '/peerjs';
const DEFAULT_WORKER = path.resolve(HERE, '..', 'dist-headless', 'room-worker.mjs');
/** Largest POST /api/rooms body accepted (bytes). */
const ROOMS_BODY_LIMIT = 2048;
/** Players a room seats at most (src/net/hostSession.ts MAX_PLAYERS). */
const ROOM_SEATS = MAX_PLAYERS;
/** HTTP keep-alive: longer than tailscaled's idle connections to us (90 s), so it never reuses one we just closed. */
export const KEEP_ALIVE_MS = 95_000;
export const HEADERS_TIMEOUT_MS = 96_000;
/** The stats line: every STATS_MS while anything happens, else once an hour. */
export const STATS_MS = 60_000;
const STATS_IDLE_MS = 60 * 60_000;
/**
 * A server-hosted room nobody joined closes after this long (ms). Its creator joins about a
 * second after the 201; a room only created to hold a slot gives it back soon.
 */
const EMPTY_LOBBY_MS = 45_000;

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
  'Access-Control-Allow-Headers': 'Content-Type, X-SGWL-Key',
  'Access-Control-Max-Age': '600',
};

/**
 * The access key check (RELAY_KEY). `check(provided)` → null when the key is right (or none is
 * set), else 'key-required' (none given) / 'bad-key'. Constant time: both sides are hashed to
 * equal-length digests first, then compared with crypto.timingSafeEqual.
 * @param {string} key
 */
export function createKeyCheck(key) {
  const want = key ? crypto.createHash('sha256').update(key, 'utf8').digest() : null;
  return {
    required: want !== null,
    /** @param {unknown} provided */
    check(provided) {
      if (!want) return null;
      if (typeof provided !== 'string' || !provided) return 'key-required';
      const got = crypto.createHash('sha256').update(provided, 'utf8').digest();
      return crypto.timingSafeEqual(got, want) ? null : 'bad-key';
    },
  };
}

/** The key a request presents: `?k=` (WebSockets can only do this), else the X-SGWL-Key header when `header`. */
function keyOf(req, url, header) {
  const q = url.searchParams.get('k');
  if (q) return q;
  if (!header) return '';
  const h = req.headers['x-sgwl-key'];
  return Array.isArray(h) ? (h[0] ?? '') : (h ?? '');
}

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
 * POST /api/rooms {name?, lang?, build?, probe?} → 201 {code, ownerKey} | 400 | 409 | 413 | 429 | 503 | 500
 * (see rooms.mjs; 409 {error:'version-mismatch'}: the page is another build of the game than the
 * room worker — the page hosts its room itself).
 * JSON or text/plain bodies (text/plain: a page on another origin — GitHub Pages — posts without a
 * CORS preflight); every answer carries Access-Control-Allow-Origin: *.
 */
async function handleRoomsApi(req, res, rooms, keyError) {
  if (req.method === 'OPTIONS') {
    // (the CORS preflight stays open: it carries no key)
    const pna = req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {};
    res.writeHead(204, { ...CORS, ...pna });
    res.end();
    return;
  }
  if (keyError) {
    sendJson(res, 401, { error: keyError });
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
    const room = await rooms.create(clientIp(req), { name: body.name, lang: body.lang, build: body.build, probe: body.probe });
    sendJson(res, 201, { code: room.code, ownerKey: room.ownerKey });
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : 500;
    sendJson(res, status, { error: typeof err?.code === 'string' ? err.code : 'worker-failed' });
  }
}

/** Text types worth compressing on the fly when no precompressed .br / .gz sits next to the file. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest', '.wasm']);
/** On-the-fly compression: files up to this size, results cached up to DYN_CACHE_BYTES (LRU). */
const DYN_MAX_FILE = 8 * 1024 * 1024;
const DYN_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Cache-Control for a file of the build (`rel`: its path in dist/, '/'-separated):
 * Vite's content-hashed bundles right in assets/ (`assets/index-BXUdnHQG.js`) never change —
 * a year, immutable; pages revalidate every time (a new build's page must arrive at once);
 * everything else (public/ art under assets/<dir>/, favicon, art-index.json — same name, new
 * content after an update) caches a day and may be used stale for a week while it revalidates.
 */
export function cacheControlFor(rel) {
  const p = String(rel).replace(/^\/+/, '');
  if (/\.html?$/i.test(p) || p === '') return 'no-cache';
  if (/^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(p)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=86400, stale-while-revalidate=604800';
}

/**
 * The encodings a request accepts, best first ('br' before 'gzip' when both are): from
 * Accept-Encoding with its q-values (q=0 refuses one).
 * @param {string | string[] | undefined} header
 * @returns {('br' | 'gzip')[]}
 */
export function acceptedEncodings(header) {
  const text = Array.isArray(header) ? header.join(',') : String(header ?? '');
  const q = new Map();
  for (const part of text.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    q.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const star = q.get('*');
  const w = (enc) => q.get(enc) ?? (star !== undefined ? star : 0);
  return /** @type {('br' | 'gzip')[]} */ (['br', 'gzip'].filter((e) => w(e) > 0).sort((a, b) => w(b) - w(a)));
}

/** A weak ETag for a file (size + mtime) and the encoding served. */
export function etagFor(st, enc = '') {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${enc ? `-${enc}` : ''}"`;
}

/** If-None-Match names this ETag (weak comparison) or '*'. */
export function matchesEtag(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, '');
  return String(header)
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || t.replace(/^W\//, '') === bare);
}

function createStaticHandler(distDir) {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, 'index.html');
  /** requests answered and body bytes sent (the stats line) */
  const counters = { requests: 0, bytes: 0, notModified: 0 };
  /** on-the-fly compressed files: key → Buffer (Map order = LRU) */
  const dynCache = new Map();
  const dynPending = new Map();
  let dynBytes = 0;

  const statFile = (p) =>
    new Promise((resolve) => {
      fs.stat(p, (err, st) => resolve(err ? null : st));
    });

  /** `file` compressed with `enc` (quality for speed: once per file and build, then cached). */
  const compressOnTheFly = (file, st, enc) => {
    const key = `${file}\0${st.size}\0${st.mtimeMs}\0${enc}`;
    const hit = dynCache.get(key);
    if (hit) {
      dynCache.delete(key);
      dynCache.set(key, hit);
      return Promise.resolve(hit);
    }
    const running = dynPending.get(key);
    if (running) return running;
    const job = fs.promises
      .readFile(file)
      .then(
        (buf) =>
          new Promise((resolve, reject) => {
            const done = (err, out) => (err ? reject(err) : resolve(out));
            if (enc === 'br') zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, done);
            else zlib.gzip(buf, { level: 6 }, done);
          }),
      )
      .then((out) => {
        dynCache.set(key, out);
        dynBytes += out.length;
        for (const [k, v] of dynCache) {
          if (dynBytes <= DYN_CACHE_BYTES) break;
          dynCache.delete(k);
          dynBytes -= v.length;
        }
        return out;
      })
      .finally(() => dynPending.delete(key));
    dynPending.set(key, job);
    return job;
  };

  const serveStatic = async function serveStatic(req, res, pathname) {
    counters.requests++;
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
    const relPath = path.relative(root, file).split(path.sep).join('/');
    /** @type {Record<string, string | number>} */
    const headers = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControlFor(relPath),
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    };
    // the encoding: a precompressed sibling (.br / .gz, as fresh as the file), else on the fly for text
    const accepted = acceptedEncodings(req.headers['accept-encoding']);
    let enc = '';
    let variant = null;
    let variantSt = null;
    for (const e of accepted) {
      const p = `${file}.${e === 'br' ? 'br' : 'gz'}`;
      const vs = await statFile(p);
      if (vs?.isFile() && vs.size > 0 && vs.mtimeMs + 2000 >= st.mtimeMs) {
        enc = e;
        variant = p;
        variantSt = vs;
        break;
      }
    }
    const dynamic = !enc && COMPRESSIBLE.has(ext) && st.size >= 1024 && st.size <= DYN_MAX_FILE && accepted.length > 0;
    if (dynamic) enc = accepted[0];
    if (enc || COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
    headers.ETag = etagFor(st, enc);
    if (matchesEtag(req.headers['if-none-match'], String(headers.ETag))) {
      counters.notModified++;
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (variant && variantSt) {
      res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': variantSt.size });
      if (req.method !== 'HEAD') counters.bytes += variantSt.size;
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(variant);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    if (dynamic) {
      let body = null;
      try {
        body = await compressOnTheFly(file, st, enc);
      } catch {
        body = null;
      }
      if (body) {
        res.writeHead(200, { ...headers, 'Content-Encoding': enc, 'Content-Length': body.length });
        if (req.method !== 'HEAD') counters.bytes += body.length;
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      headers.ETag = etagFor(st);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    counters.bytes += st.size;
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
  serveStatic.counters = counters;
  return serveStatic;
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
 * interface (or on loopback), else the one address it listens on — with the access key.
 */
function selfRelayUrl(server, key = '') {
  const addr = server?.address();
  const k = key ? `?k=${encodeURIComponent(key)}` : '';
  if (!addr || typeof addr !== 'object') return `ws://127.0.0.1/ws${k}`;
  const a = addr.address;
  const host = a === '0.0.0.0' || a === '::' || /^(::ffff:)?127\./.test(a) ? '127.0.0.1' : a.includes(':') ? `[${a}]` : a;
  return `ws://${host}:${addr.port}/ws${k}`;
}

/** `2026-09-28T02:03:04.567Z message` */
export const stamp = (m) => `${new Date().toISOString()} ${m}`;

/** A non-negative integer from the environment, else undefined. */
function envInt(name) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The commit this build is: SGWL_GIT_SHA, else ../.sgwl-sha (deploy/install.sh writes it after a build). */
function gitSha() {
  const fromEnv = String(process.env.SGWL_GIT_SHA ?? '').trim();
  if (/^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv;
  try {
    const s = fs.readFileSync(path.resolve(HERE, '..', '.sgwl-sha'), 'utf8').trim();
    return /^[0-9a-f]{7,40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * The stats line: current rooms / sockets, what changed since the last line (bytes in / out,
 * drops, refusals), memory, server-hosted rooms. `prev`: the relay counters at the last line.
 */
export function statsLine(now, prev, relayStats, headless, rss) {
  const d = (k) => (now[k] ?? 0) - (prev?.[k] ?? 0);
  const parts = [
    `rooms ${relayStats.rooms} (+${d('roomsCreated')} −${d('roomsClosed')})`,
    `sockets ${now.sockets} (+${d('socketsOpened')} −${d('socketsClosed')})`,
    `in ${mb(d('bytesIn'))}`,
    `out ${mb(d('bytesOut'))}`,
    `dropped ${d('droppedUnreliable')}`,
  ];
  const trouble = d('terminatedBacklog') + d('rateLimited') + d('refusedSockets') + d('refusedCreates') + d('reapedIdle') + d('reapedOld') + (now.refusedKeys ?? 0) - (prev?.refusedKeys ?? 0);
  if (trouble > 0) {
    parts.push(
      `terminated ${d('terminatedBacklog')} · rate-limited ${d('rateLimited')} · refused sockets ${d('refusedSockets')} / rooms ${d('refusedCreates')} / keys ${(now.refusedKeys ?? 0) - (prev?.refusedKeys ?? 0)} · reaped ${d('reapedIdle')} idle / ${d('reapedOld')} old`,
    );
  }
  if (now.httpRequests !== undefined) parts.push(`http ${d('httpRequests')} requests, ${mb(d('httpBytes'))} sent`);
  parts.push(`rss ${mb(rss)}`);
  parts.push(`headless ${headless.headlessRooms} rooms, ${headless.headlessHumans} humans, ${headless.headlessPlaying} playing`);
  return `[stats] ${parts.join(' · ')}`;
}

/**
 * Start the server.
 * @param {{ port?: number, host?: string, distDir?: string, peer?: boolean, quiet?: boolean,
 *           log?: (msg: string) => void, workerPath?: string, relayKey?: string,
 *           relay?: Record<string, unknown>, statsMs?: number,
 *           headless?: boolean | { maxRooms?: number, perIpPerMin?: number, perIpRooms?: number,
 *                                  readyTimeoutMs?: number, emptyLobbyMs?: number, noHumansMs?: number,
 *                                  probeLobbyMs?: number, pauseAfterFailures?: number, pauseMs?: number } }} [opts]
 *   workerPath: the server-hosted room bundle (default ../dist-headless/room-worker.mjs);
 *   headless: false turns server-hosted rooms off (default: on unless HEADLESS=0 — and only
 *   while the bundle exists); an object tunes them.
 *   relayKey: the access key (default RELAY_KEY; '' = open); relay: createRelay options over the
 *   environment's (MAX_ROOMS, HOST_GRACE_MS, MAX_SOCKETS_PER_IP); statsMs: the stats line period.
 * @returns {Promise<{ port: number, close(): Promise<void>, urls: string[], relay: ReturnType<typeof createRelay>,
 *                     rooms: ReturnType<typeof createHeadlessRooms> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (Number(process.env.PORT) || 8787);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const distDir = opts.distDir ?? process.env.DIST_DIR ?? DEFAULT_DIST;
  const log = opts.quiet ? () => {} : (opts.log ?? ((m) => console.log(stamp(m))));
  const errorLog = opts.quiet ? () => {} : (m) => console.error(stamp(m));
  const wantPeer = opts.peer ?? process.env.NO_PEER !== '1';
  const relayKey = String(opts.relayKey ?? process.env.RELAY_KEY ?? '').trim();
  const keys = createKeyCheck(relayKey);
  const startedAt = Date.now();
  const sha = gitSha();

  const relayOpts = {
    maxRooms: envInt('MAX_ROOMS'),
    hostGraceMs: envInt('HOST_GRACE_MS'),
    maxSocketsPerIp: envInt('MAX_SOCKETS_PER_IP') || undefined,
    ...(opts.relay ?? {}),
  };
  for (const k of Object.keys(relayOpts)) if (relayOpts[k] === undefined) delete relayOpts[k];
  const relay = createRelay({ ...relayOpts, log: opts.quiet ? undefined : log });
  const serveStatic = createStaticHandler(distDir);
  const headlessOpts = typeof opts.headless === 'object' && opts.headless ? opts.headless : {};
  const workerPath = opts.workerPath ?? process.env.HEADLESS_WORKER ?? DEFAULT_WORKER;
  const envMax = Number.parseInt(process.env.HEADLESS_MAX_ROOMS ?? '', 10);
  const maxRooms = headlessOpts.maxRooms ?? (Number.isFinite(envMax) && envMax >= 0 ? envMax : 4);
  const envPerIp = Number.parseInt(process.env.HEADLESS_ROOMS_PER_IP ?? '', 10);
  const perIpRooms = headlessOpts.perIpRooms ?? (Number.isFinite(envPerIp) && envPerIp >= 1 ? envPerIp : undefined);
  /** @type {http.Server | undefined} */
  let server;
  const rooms = createHeadlessRooms({
    workerPath,
    // (the workers are relay clients like any other: they present the key too)
    relayUrl: () => selfRelayUrl(server, relayKey),
    enabled: opts.headless === undefined ? process.env.HEADLESS !== '0' : opts.headless !== false,
    maxRooms,
    perIpPerMin: headlessOpts.perIpPerMin,
    perIpRooms,
    readyTimeoutMs: headlessOpts.readyTimeoutMs,
    emptyLobbyMs: headlessOpts.emptyLobbyMs ?? EMPTY_LOBBY_MS,
    probeLobbyMs: headlessOpts.probeLobbyMs,
    noHumansMs: headlessOpts.noHumansMs,
    pauseAfterFailures: headlessOpts.pauseAfterFailures,
    pauseMs: headlessOpts.pauseMs,
    workerLog: !opts.quiet,
    log,
    errorLog,
    // the room's host is this server, not a player: one more socket so it seats ROOM_SEATS humans
    // (plus the relay's slack for guests rejoining on a new socket)
    onReady: (code) => {
      relay.setRoomLimit(code, ROOM_SEATS + 1 + ROOM_SLACK);
      relay.markServerHosted(code);
    },
    // a worker gone for good: its guests hear so now, not after the relay's host grace
    onExit: (code) => {
      if (code) relay.endRoom(code);
    },
  });
  /** @type {Awaited<ReturnType<typeof createPeerMount>>} */
  let peerMount = null;
  // requests refused for want of the key: counted (stats line), logged at a bounded rate
  let refusedKeys = 0;
  const authLog = createLineLimiter(log, 30, 60_000);
  const refusedKey = (req, what, why) => {
    refusedKeys++;
    authLog.line(`[auth] ${clientIp(req)} ${what}: ${why}`);
  };

  server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    const pathname = url.pathname;
    if (pathname === '/sgwl.json') {
      const body = JSON.stringify({
        app: 'sanguo-warlords',
        relay: '/ws',
        peer: peerMount ? PEER_MOUNT : null,
        // (whether the relay wants ?k= — never the key itself)
        keyRequired: keys.required,
        ...relay.stats(),
        ...rooms.stats(),
        build: { compat: rooms.build(), sha },
        uptime: Math.round((Date.now() - startedAt) / 1000),
        rss: process.memoryUsage.rss(),
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
      const keyError = req.method === 'OPTIONS' ? null : keys.check(keyOf(req, url, true));
      if (keyError) refusedKey(req, 'POST /api/rooms', keyError);
      handleRoomsApi(req, res, rooms, keyError).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'worker-failed' });
        else res.destroy();
      });
      return;
    }
    if (peerMount && (pathname === PEER_MOUNT || pathname.startsWith(PEER_MOUNT + '/'))) {
      const keyError = req.method === 'OPTIONS' ? null : keys.check(keyOf(req, url, true));
      if (keyError) {
        refusedKey(req, PEER_MOUNT, keyError);
        sendJson(res, 401, { error: keyError });
        return;
      }
      peerMount.handle(req, res);
      return;
    }
    serveStatic(req, res, pathname).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.destroy();
    });
  });
  // longer than tailscaled's idle connections to us (90 s): it must never reuse a connection we
  // just closed (a request lost in between); headers must arrive within a second more
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const pathname = url.pathname;
    socket.on('error', () => socket.destroy());
    const isRelay = pathname === '/ws' || pathname === '/ws/';
    const isPeer = !!peerMount && pathname.startsWith(PEER_MOUNT + '/');
    if (!isRelay && !isPeer) {
      socket.destroy();
      return;
    }
    // the key: only as ?k= (a browser's WebSocket cannot send headers); refused before upgrading
    const keyError = keys.check(keyOf(req, url, false));
    if (keyError) {
      refusedKey(req, pathname, keyError);
      const body = JSON.stringify({ error: keyError });
      try {
        socket.end(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    if (isRelay) relay.handleUpgrade(req, socket, head, clientIp(req));
    else peerMount?.handleUpgrade(req, socket, head);
  });

  if (wantPeer) peerMount = await createPeerMount(server, log);
  await listen(server, port, host);
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  // one line a minute while anything happens (else one an hour): what the relay carried, memory
  let lastCounters = { ...relay.counters(), refusedKeys, httpRequests: 0, httpBytes: 0 };
  let lastStatsAt = Date.now();
  const statsTimer = setInterval(() => {
    const now = { ...relay.counters(), refusedKeys, httpRequests: serveStatic.counters.requests, httpBytes: serveStatic.counters.bytes };
    const rs = relay.stats();
    const hs = rooms.stats();
    const busy =
      rs.rooms > 0 ||
      now.sockets > 0 ||
      hs.headlessRooms > 0 ||
      now.socketsOpened !== lastCounters.socketsOpened ||
      now.bytesIn !== lastCounters.bytesIn ||
      now.refusedKeys !== lastCounters.refusedKeys ||
      now.httpRequests !== lastCounters.httpRequests ||
      now.refusedSockets !== lastCounters.refusedSockets;
    if (!busy && Date.now() - lastStatsAt < STATS_IDLE_MS) return;
    log(statsLine(now, lastCounters, rs, hs, process.memoryUsage.rss()));
    lastCounters = now;
    lastStatsAt = Date.now();
  }, Math.max(10, opts.statsMs ?? STATS_MS));
  statsTimer.unref?.();

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
    keys.required
      ? '  访问密钥 Access key:   开启 on — 玩家要用带 k= 的邀请链接 / players need an invite link with k='
      : '  访问密钥 Access key:   未设置 off (RELAY_KEY) — 谁都能连 / anyone who reaches this server can play',
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
        clearInterval(statsTimer);
        authLog.flush();
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
  // a bug must not leave a half-working server behind: log it and exit — launchd / systemd
  // (KeepAlive / Restart=always) start a fresh one within seconds
  const fatal = (what) => (err) => {
    try {
      console.error(stamp(`${what}: ${err?.stack ?? err}`));
    } finally {
      process.exit(1);
    }
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));
  startServer()
    .then((srv) => {
      // launchd / systemd stop or update the service with SIGTERM: server-hosted rooms tell their
      // players first (≤ 3 s), then everything closes; a second signal ends it at once
      let stopping = false;
      const shutdown = (sig) => {
        if (stopping) process.exit(0);
        stopping = true;
        console.log(stamp(`${sig}: 正在关闭 / shutting down`));
        srv.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 6000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err?.code === 'EADDRINUSE') {
        console.error(stamp(`端口已被占用 / Port already in use: ${err.port ?? ''}. 设置 PORT 环境变量换一个端口 / set PORT to use another port.`));
      } else {
        console.error(stamp(`服务器启动失败 / Server failed to start: ${err?.stack ?? err}`));
      }
      process.exit(1);
    });
}

