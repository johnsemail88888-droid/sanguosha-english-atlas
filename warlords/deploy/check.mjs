#!/usr/bin/env node
// 三国杀·枪火乱世 — end-to-end check of a running game server, as a friend would reach it:
//   GET <url>/sgwl.json   answers {"app":"sanguo-warlords",…} (the game server, not something else)
//   WS  <url>/ws          the relay accepts a WebSocket upgrade (http→ws, https→wss)
//
//   node deploy/check.mjs https://mac-mini.tail1234.ts.net/ [--public-dns] [--timeout=8000]
//
// --public-dns resolves the name through public DNS (DNS-over-HTTPS at Cloudflare / Google,
// then 1.1.1.1 / 8.8.8.8 directly) instead of this machine's resolver. On the hosting machine
// itself Tailscale's MagicDNS answers with the tailnet address, which proves nothing about
// Funnel; the public answer goes the way friends' browsers go.
//
// Used by deploy/home-host.sh (install / update / status). Exit 0 = both checks passed.
// Tests: tests/unit/deploy/check.test.ts
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
  return { host: u.hostname, info: `${base}/sgwl.json`, relay: `${ws}/ws` };
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
 * Check a running server. Resolves to { ok, lines } — one line per check, ✓ or ✗.
 * @param {string} baseUrl
 * @param {{ publicDns?: boolean, timeoutMs?: number }} [opts]
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
  try {
    const info = await getJson(ep.info, { lookup, timeoutMs });
    if (info?.app !== 'sanguo-warlords') throw new Error('not the game server (another program answers on this address)');
    lines.push(`✓ ${ep.info} (${info.rooms ?? 0} rooms, ${info.players ?? 0} players)`);
  } catch (err) {
    ok = false;
    lines.push(`✗ ${ep.info}: ${err?.message ?? err}`);
  }
  try {
    await openWs(ep.relay, { lookup, timeoutMs });
    lines.push(`✓ ${ep.relay} (WebSocket)`);
  } catch (err) {
    ok = false;
    lines.push(`✗ ${ep.relay}: ${err?.message ?? err}`);
  }
  return { ok, lines };
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
    console.error('usage: node deploy/check.mjs <https://host/> [--public-dns] [--timeout=ms]');
    process.exit(2);
  }
  const { ok, lines } = await checkServer(url, { publicDns: args.includes('--public-dns'), timeoutMs: t ? Number(t.slice(10)) || 8000 : 8000 });
  for (const l of lines) console.log(`    ${l}`);
  process.exit(ok ? 0 : 1);
}
