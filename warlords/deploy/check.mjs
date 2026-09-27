#!/usr/bin/env node
// 三国杀·枪火乱世 — end-to-end check of a running game server, as a friend would reach it:
//   GET <url>/sgwl.json   answers {"app":"sanguo-warlords",…} (the game server, not something else)
//   WS  <url>/ws          the relay accepts a WebSocket upgrade (http→ws, https→wss)
//   POST <url>/api/rooms  when /sgwl.json says headless:true: a server-hosted room starts, and a
//                         relay guest can join it ({op:'join'} → {op:'joined'}); the test room
//                         nobody plays in ends by itself after a few minutes. A problem here is a
//                         ⚠ line, not a failure: players then host rooms in their browser as before.
//
//   node deploy/check.mjs https://mac-mini.tail1234.ts.net/ [--public-dns] [--no-headless] [--timeout=8000]
//
// --public-dns resolves the name through public DNS (DNS-over-HTTPS at Cloudflare / Google,
// then 1.1.1.1 / 8.8.8.8 directly) instead of this machine's resolver. On the hosting machine
// itself Tailscale's MagicDNS answers with the tailnet address, which proves nothing about
// Funnel; the public answer goes the way friends' browsers go.
//
// Used by deploy/home-host.sh (install / update / status). Exit 0 = the page and the relay answer.
// Tests: tests/unit/deploy/home-host.test.ts (pure parts), tests/unit/deploy/check.test.ts (a live server)
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Base URL → the two endpoints to check; null when it is not an http(s) URL. */
export function endpoints(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const ws = base.replace(/^http/, 'ws');
  return { host: u.hostname, info: `${base}/sgwl.json`, relay: `${ws}/ws`, rooms: `${base}/api/rooms` };
}

/** IPv4 addresses from a DNS-over-HTTPS JSON answer ({"Answer":[{"type":1,"data":"1.2.3.4"},…]}). */
export function parseDohAnswer(json) {
  const answers = Array.isArray(json?.Answer) ? json.Answer : [];
  return answers.filter((a) => a && a.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(a.data))).map((a) => String(a.data));
}

const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

/** The host's IPv4 addresses as the public internet sees them. */
export async function publicResolve(host, timeoutMs = 8000) {
  for (const doh of DOH) {
    try {
      const res = await fetch(`${doh}?name=${encodeURIComponent(host)}&type=A`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const ips = parseDohAnswer(await res.json());
      if (ips.length) return ips;
    } catch {
      // next resolver
    }
  }
  const resolver = new dns.promises.Resolver({ timeout: Math.min(timeoutMs, 5000), tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  try {
    const ips = await resolver.resolve4(host);
    if (ips.length) return ips;
  } catch {
    // no public answer
  }
  return [];
}

/** A `lookup` for http/https/ws that always answers `ip` (TLS still checks the real host name). */
function fixedLookup(ip) {
  return (_host, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (opts && typeof opts === 'object' && opts.all) callback(null, [{ address: ip, family: 4 }]);
    else callback(null, ip, 4);
  };
}

function getJson(url, { lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { lookup, timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 65536) req.destroy(new Error('answer too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('not JSON (another program answers on this address?)'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

/** POST a JSON body; resolves to {status, body} (body: the parsed JSON answer, {} when not JSON). */
function postJson(url, payload, { lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const data = JSON.stringify(payload);
    const req = mod.request(
      url,
      { method: 'POST', lookup, timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > 65536) req.destroy(new Error('answer too large'));
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body) ?? {};
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(data);
  });
}

/** Join room `code` as a relay guest: resolves on {op:'joined'}, rejects on an error / timeout. */
async function joinRoom(url, code, { lookup, timeoutMs }) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { lookup, handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no answer from the room in ${timeoutMs} ms`));
    }, timeoutMs);
    const done = (err) => {
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    };
    ws.on('open', () => ws.send(JSON.stringify({ op: 'join', v: 1, code })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.op === 'joined') done();
      else if (msg?.op === 'error') done(new Error(`relay: ${msg.code ?? 'error'}`));
    });
    ws.on('unexpected-response', (_req, res) => done(new Error(`HTTP ${res.statusCode} instead of a WebSocket upgrade`)));
    ws.on('error', (err) => done(err));
  });
}

/**
 * The server-hosted match check: a room starts and a relay guest joins it. → one line, and
 * `ok: false` only when the room did not start or could not be joined (full / rate-limited
 * servers are busy, not broken).
 */
export async function checkHeadless(ep, { lookup, timeoutMs }) {
  const OK = '✓ 服务器托管对局 ✓ / Server-hosted matches ✓';
  const FALLBACK = '玩家会改为在浏览器里开房 / players host rooms in their browser meanwhile';
  let res;
  try {
    res = await postJson(ep.rooms, { name: 'check', lang: 'zh' }, { lookup, timeoutMs: Math.max(timeoutMs, 16000) });
  } catch (err) {
    return { ok: false, line: `⚠ 服务器托管对局：${ep.rooms} 无响应 / Server-hosted matches: no answer (${err?.message ?? err}) — ${FALLBACK}` };
  }
  const error = typeof res.body?.error === 'string' ? res.body.error : '';
  if (res.status === 429 || error === 'rooms-full') {
    return { ok: true, line: `⚠ 服务器托管对局：现在房间已满或请求太频繁，稍后再查 / Server-hosted matches: busy right now (${error || res.status}) — check again later` };
  }
  if (res.status !== 201 || typeof res.body?.code !== 'string') {
    return { ok: false, line: `⚠ 服务器托管对局没有启动 / Server-hosted matches did not start (HTTP ${res.status}${error ? ` ${error}` : ''}) — ${FALLBACK}` };
  }
  try {
    await joinRoom(ep.relay, res.body.code, { lookup, timeoutMs });
  } catch (err) {
    return { ok: false, line: `⚠ 服务器托管对局：房间 ${res.body.code} 进不去 / Server-hosted matches: room ${res.body.code} could not be joined (${err?.message ?? err})` };
  }
  return { ok: true, line: `${OK} (room ${res.body.code})` };
}

async function openWs(url, { lookup, timeoutMs }) {
  const { default: WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { lookup, handshakeTimeout: timeoutMs });
    ws.on('open', () => {
      ws.close();
      resolve();
    });
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode} instead of a WebSocket upgrade`));
      ws.terminate();
    });
    ws.on('error', reject);
  });
}

/**
 * Check a running server. Resolves to { ok, lines, headless } — one line per check, ✓ / ✗ / ⚠.
 * `ok`: the page and the relay answer. `headless`: 'ok' | 'off' | 'busy' | 'failed' | 'skipped'
 * (server-hosted matches; never part of `ok`).
 * @param {string} baseUrl
 * @param {{ publicDns?: boolean, timeoutMs?: number, headless?: boolean }} [opts]
 *   headless: false skips the server-hosted match check (no test room)
 */
export async function checkServer(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const ep = endpoints(baseUrl);
  if (!ep) return { ok: false, lines: [`✗ 不是网址 / not a URL: ${baseUrl}`] };
  const lines = [];
  let lookup;
  if (opts.publicDns) {
    const ips = await publicResolve(ep.host, timeoutMs);
    if (!ips.length) return { ok: false, lines: [`✗ 公网 DNS 还查不到 ${ep.host} / public DNS has no address for ${ep.host} yet`] };
    lines.push(`✓ 公网 DNS / public DNS: ${ep.host} → ${ips[0]}`);
    lookup = fixedLookup(ips[0]);
  }
  let ok = true;
  let info = null;
  try {
    info = await getJson(ep.info, { lookup, timeoutMs });
    if (info?.app !== 'sanguo-warlords') throw new Error('not the game server (another program answers on this address)');
    lines.push(`✓ ${ep.info} (${info.rooms ?? 0} rooms, ${info.players ?? 0} players)`);
  } catch (err) {
    ok = false;
    info = null;
    lines.push(`✗ ${ep.info}: ${err?.message ?? err}`);
  }
  try {
    await openWs(ep.relay, { lookup, timeoutMs });
    lines.push(`✓ ${ep.relay} (WebSocket)`);
  } catch (err) {
    ok = false;
    lines.push(`✗ ${ep.relay}: ${err?.message ?? err}`);
  }
  let headless = 'skipped';
  if (ok && opts.headless !== false) {
    if (info?.headless === true) {
      const h = await checkHeadless(ep, { lookup, timeoutMs });
      lines.push(h.line);
      headless = !h.ok ? 'failed' : h.line.startsWith('✓') ? 'ok' : 'busy';
    } else {
      headless = 'off';
      lines.push(
        '⚠ 服务器托管对局：未开启（房间由房主的浏览器运行；需要 npm run build:headless，或设了 HEADLESS=0，或连续启动失败后暂停中——见服务器日志）/ Server-hosted matches: off (rooms run in the host player\'s browser; needs npm run build:headless, or HEADLESS=0 is set, or paused after failed starts — see the server log)',
      );
    }
  }
  return { ok, lines, headless };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const t = args.find((a) => a.startsWith('--timeout='));
  if (!url) {
    console.error('usage: node deploy/check.mjs <https://host/> [--public-dns] [--no-headless] [--timeout=ms]');
    process.exit(2);
  }
  const { ok, lines } = await checkServer(url, {
    publicDns: args.includes('--public-dns'),
    headless: !args.includes('--no-headless'),
    timeoutMs: t ? Number(t.slice(10)) || 8000 : 8000,
  });
  for (const l of lines) console.log(`    ${l}`);
  process.exit(ok ? 0 : 1);
}
