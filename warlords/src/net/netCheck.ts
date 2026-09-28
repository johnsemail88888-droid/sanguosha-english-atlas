// 联机检测 (connection check): three quick probes the online screen runs on demand.
//   signal — the PeerJS signalling server answers GET <server>/<key>/id (what PeerJS itself asks first)
//   ice    — ICE gathering with our STUN/TURN list yields a relay candidate (TURN reachable)
//   relay  — the official relay accepts a WebSocket (with this page's key for it, if any);
//            one that refuses it while the server says it requires a key: 'needs key' /
//            'key refused' (src/net/relayKey.ts)
// Loaded lazily (the button), never by single player. Rows: src/ui/netHelp.ts formatProbe().
import type { NetServerConfig } from '../game/settings';
import { iceServersFor, peerOptionsFor } from './peerTransport';
import { hasKeyParam, keyedRelayUrl, relayKeyRequired } from './relayKey';

export type ProbeId = 'signal' | 'ice' | 'relay';

export interface ProbeResult {
  id: ProbeId;
  /** null = not run (e.g. no official server configured) */
  ok: boolean | null;
  /** time to the answer / first relay candidate, or to giving up */
  ms: number | null;
  /** what was probed (host name) */
  target?: string;
  /** failure / extra detail: 'timeout', an error type, ICE candidate kinds seen */
  detail?: string;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The PeerJS server's id endpoint for these settings (the public cloud when none is set). */
export function signallingIdUrl(net: NetServerConfig): { url: string; host: string } {
  const o = peerOptionsFor(net);
  const host = o.host ?? '0.peerjs.com';
  const secure = o.secure ?? true;
  const port = o.port ?? 443;
  let path = o.path ?? '/';
  if (!path.endsWith('/')) path += '/';
  const key = o.key ?? 'peerjs';
  return { url: `${secure ? 'https' : 'http'}://${host}:${port}${path}${key}/id?ts=${Date.now()}`, host };
}

export async function probeSignalling(net: NetServerConfig, timeoutMs = 6000, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const { url, host } = signallingIdUrl(net);
  const t0 = now();
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { cache: 'no-store', signal: ctrl?.signal });
    const ms = now() - t0;
    return { id: 'signal', ok: r.ok, ms, target: host, detail: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    const ms = now() - t0;
    const aborted = ms >= timeoutMs - 50 || (e instanceof Error && e.name === 'AbortError');
    // fetch only says "Failed to fetch" / "NetworkError…": refused, DNS, TLS or CORS — the server is not reachable
    return { id: 'signal', ok: false, ms, target: host, detail: aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

type PcCtor = new (config: RTCConfiguration) => RTCPeerConnection;

export async function probeIce(net: NetServerConfig, timeoutMs = 7000, Pc: PcCtor | undefined = (globalThis as { RTCPeerConnection?: PcCtor }).RTCPeerConnection): Promise<ProbeResult> {
  if (!Pc) return { id: 'ice', ok: false, ms: null, detail: 'unsupported' };
  const t0 = now();
  let pc: RTCPeerConnection;
  try {
    pc = new Pc({ iceServers: iceServersFor(net) });
  } catch (e) {
    return { id: 'ice', ok: false, ms: null, detail: e instanceof Error ? e.message : 'unsupported' };
  }
  const kinds = new Set<string>();
  const result = await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seen = [...kinds].sort().join('+');
      resolve({ id: 'ice', ok, ms: now() - t0, detail: detail ?? (seen || undefined) });
    };
    const timer = setTimeout(() => finish(false, kinds.size ? `no relay candidate (${[...kinds].sort().join('+')})` : 'timeout'), timeoutMs);
    pc.onicecandidate = (ev) => {
      const c = ev.candidate;
      if (!c) {
        // gathering finished without a relay candidate
        finish(kinds.has('relay'), kinds.has('relay') ? undefined : `no relay candidate${kinds.size ? ` (${[...kinds].sort().join('+')})` : ''}`);
        return;
      }
      const kind = c.type ?? /\btyp (\w+)/.exec(c.candidate)?.[1];
      if (kind) kinds.add(kind);
      if (kind === 'relay') finish(true);
    };
    try {
      pc.createDataChannel('probe');
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch((e: unknown) => finish(false, e instanceof Error ? e.message : 'error'));
    } catch (e) {
      finish(false, e instanceof Error ? e.message : 'error');
    }
  });
  try {
    pc.close();
  } catch {
    /* ignore */
  }
  return result;
}

type WsCtor = new (url: string) => WebSocket;

/** probe detail: the relay refused the socket and its server requires a key the page does not have */
export const NEEDS_KEY = 'needs key';
/** probe detail: … and the page sent one (wrong, or replaced since: rotate-key) */
export const KEY_REFUSED = 'key refused';

/**
 * Probe the relay; a refused socket (not a timeout) is explained when the server says it
 * requires a key (`needsKey`: its /sgwl.json, see relayKeyRequired).
 */
export async function probeRelay(
  url: string | null,
  timeoutMs = 6000,
  Ws: WsCtor | undefined = (globalThis as { WebSocket?: WsCtor }).WebSocket,
  needsKey: (url: string) => Promise<boolean | null> = (u) => relayKeyRequired(u),
): Promise<ProbeResult> {
  const r = await probeSocket(url, timeoutMs, Ws);
  if (!url || r.ok !== false || (r.detail !== 'error' && r.detail !== 'closed')) return r;
  if ((await needsKey(url).catch(() => null)) !== true) return r;
  return { ...r, detail: hasKeyParam(url) ? KEY_REFUSED : NEEDS_KEY };
}

async function probeSocket(url: string | null, timeoutMs: number, Ws: WsCtor | undefined): Promise<ProbeResult> {
  if (!url) return { id: 'relay', ok: null, ms: null, detail: 'not configured' };
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw string */
  }
  if (!Ws) return { id: 'relay', ok: false, ms: null, target: host, detail: 'unsupported' };
  const t0 = now();
  return new Promise<ProbeResult>((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;
    const finish = (ok: boolean, detail?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve({ id: 'relay', ok, ms: now() - t0, target: host, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    try {
      ws = new Ws(url);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false, 'error');
      ws.onclose = () => finish(false, 'closed');
    } catch (e) {
      finish(false, e instanceof Error ? e.message : 'error');
    }
  });
}

/** All three probes at once (each has its own timeout); the relay with this page's key for it. */
export function runNetCheck(net: NetServerConfig, relayUrl: string | null): Promise<ProbeResult[]> {
  return Promise.all([probeSignalling(net), probeIce(net), probeRelay(relayUrl ? keyedRelayUrl(relayUrl, net.keys) : null)]);
}
