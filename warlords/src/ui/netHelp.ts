// Plain-language help for online trouble (pure: unit-tested in tests/unit/ui/netHelp.test.ts):
//  - why a P2P create / join failed, and what fixes it (the official server, else server mode);
//  - the 联机检测 (connection check) result rows players can screenshot for us.
import type { ProbeId, ProbeResult } from '../net/netCheck';

export type { ProbeId, ProbeResult };

/** Why a public-P2P attempt failed. */
export type P2pFailure = 'signal' | 'ice' | 'notFound';

/**
 * Classify a P2P create / join rejection (a NetError-like {code, reason, en}):
 * 'signal' — the PeerJS signalling server (0.peerjs.com) could not be reached;
 * 'ice' — the room answered but no WebRTC path opened (NAT / firewall);
 * 'notFound' — no such room; null — anything else (version, full, kicked…).
 */
export function classifyP2pFailure(err: unknown): P2pFailure | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; reason?: unknown; en?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'roomNotFound') return 'notFound';
  if (code !== 'networkRestricted' && code !== 'timeout' && code !== 'serverUnreachable') return null;
  if (e.reason === 'signal' || e.reason === 'ice') return e.reason;
  // errors without a reason (a session error payload): the detail PeerJS gave — "Network restricted (<detail>)"
  const text = typeof e.en === 'string' ? e.en : typeof e.message === 'string' ? e.message : '';
  const detail = /\(([^()]*)\)\s*$/.exec(text)?.[1] ?? '';
  if (/signall?ing|^network$|server-error|socket-(error|closed)|ssl-unavailable/i.test(detail)) return 'signal';
  if (/\bICE\b|negotiation|data channel|webrtc/i.test(detail)) return 'ice';
  return code === 'networkRestricted' ? 'ice' : null;
}

export interface Bilingual {
  zh: string;
  en: string;
}

/** What went wrong, in words a player understands. */
export function p2pFailureText(kind: P2pFailure): Bilingual {
  switch (kind) {
    case 'signal':
      return {
        zh: '连不上 P2P 信令服务器（0.peerjs.com，位于海外）：你的网络屏蔽了它或访问很慢。',
        en: 'Could not reach the P2P signalling server (0.peerjs.com, abroad): your network blocks it or it is very slow from here.',
      };
    case 'ice':
      return {
        zh: '找到了房间，但无法和房主建立 P2P 直连（NAT / 防火墙限制，常见于校园网、公司网和手机流量）。',
        en: 'The room answered, but no direct P2P connection to the host could be opened (NAT / firewall — common on campus, office and mobile networks).',
      };
    case 'notFound':
      return {
        zh: '房间不存在：房间号有误、房主已关闭房间，或房主用的是另一种连接方式。',
        en: 'Room not found: a wrong code, the host closed the room, or the host uses another connection.',
      };
  }
}

/** The fix to offer: the one-click switch (official server, else server mode) and a short hint. */
export function p2pFix(kind: P2pFailure, o: { official: boolean; host: boolean }): { action: 'official' | 'ws'; label: Bilingual; hint: Bilingual } {
  if (o.official) {
    return {
      action: 'official',
      label: { zh: '改用官方服务器重试', en: 'Retry via the official server' },
      hint: o.host || kind === 'notFound'
        ? { zh: '官方服务器中转所有数据，不需要 P2P 直连。', en: 'The official server relays everything — no direct P2P connection needed.' }
        : {
            zh: '请房主也改用「官方服务器」重新创建房间，再把新的邀请链接发给你。',
            en: 'Ask the host to create the room again with “Official server” and send you the new invite link.',
          },
    };
  }
  return {
    action: 'ws',
    label: { zh: '改用服务器模式', en: 'Switch to server mode' },
    hint: {
      zh: '服务器模式需要一台中转服务器：局域网内任意电脑运行 npm run server，或按 README「官方联机服务器（一键部署）」租一台云服务器。',
      en: 'Server mode needs a relay server: run `npm run server` on any machine on your network, or rent a cloud server (README: “Official online server — one-command deploy”).',
    },
  };
}

// ── 联机检测 (connection check) ──────────────────────────────────────────────

const PROBE_NAMES: Record<ProbeId, Bilingual> = {
  signal: { zh: 'P2P 信令服务器', en: 'P2P signalling server' },
  ice: { zh: 'STUN/TURN 中继（P2P 穿透）', en: 'STUN/TURN relay (P2P traversal)' },
  relay: { zh: '官方服务器', en: 'Official server' },
};

const DETAIL_ZH: Record<string, string> = {
  timeout: '超时',
  unreachable: '无法连接',
  error: '连接出错',
  closed: '连接被关闭',
  'not configured': '未配置',
  unsupported: '浏览器不支持',
};

function detailZh(d: string): string {
  if (DETAIL_ZH[d]) return DETAIL_ZH[d];
  // "no relay candidate (host+srflx)" → 没有中继候选（host+srflx）
  const m = /^no relay candidate(?: \((.*)\))?$/.exec(d);
  if (m) return m[1] ? `没有中继候选（${m[1]}）` : '没有中继候选';
  return d;
}

/** One row of the check: "✓ P2P 信令服务器 (0.peerjs.com) · 182 ms". */
export function formatProbe(r: ProbeResult, lang: 'zh' | 'en'): string {
  const mark = r.ok === null ? '–' : r.ok ? '✓' : '✗';
  const name = PROBE_NAMES[r.id][lang];
  const target = r.target ? ` (${r.target})` : '';
  const ms = r.ms !== null && r.ok !== null ? ` · ${Math.round(r.ms)} ms` : '';
  const detail = r.detail ? ` · ${lang === 'zh' ? detailZh(r.detail) : r.detail}` : '';
  return `${mark} ${name}${target}${ms}${detail}`;
}

/** The whole check as text (the copy button): a header with the time, then one row per probe. */
export function formatCheck(results: readonly ProbeResult[], lang: 'zh' | 'en', at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const head = lang === 'zh' ? `联机检测 ${stamp}` : `Connection check ${stamp}`;
  return [head, ...results.map((r) => formatProbe(r, lang))].join('\n');
}

/** What the result means for the player (one line under the rows). */
export function checkVerdict(results: readonly ProbeResult[]): Bilingual {
  const get = (id: ProbeId): boolean | null => results.find((r) => r.id === id)?.ok ?? null;
  const relay = get('relay');
  const p2p = get('signal') === true && get('ice') === true;
  if (relay === true) return { zh: '官方服务器可用：选「官方服务器」联机最稳。', en: 'The official server is reachable: “Official server” is the most reliable choice.' };
  if (p2p) return { zh: 'P2P 条件良好：可以使用「公共P2P」。', en: 'P2P looks fine: “Public P2P” should work.' };
  if (get('signal') === false) return { zh: '连不上 P2P 信令服务器：P2P 在你的网络下不可用，请使用服务器模式。', en: 'The P2P signalling server is unreachable: P2P will not work on this network — use a server.' };
  return { zh: '没有中继候选：严格 NAT 下 P2P 可能失败，建议使用服务器模式。', en: 'No relay candidate: P2P may fail behind a strict NAT — a server is the safer choice.' };
}
