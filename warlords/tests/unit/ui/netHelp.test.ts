// When P2P fails, say why and offer the fix (src/ui/netHelp.ts), the reasons the PeerJS
// transport attaches to its errors, and the 联机检测 probes + their result rows.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type NetServerConfig } from '../../../src/game/settings';
import { NetError } from '../../../src/net/errors';
import { probeIce, probeRelay, probeSignalling, signallingIdUrl, type ProbeResult } from '../../../src/net/netCheck';
import { mapPeerError, preOpenFailure } from '../../../src/net/peerTransport';
import { checkVerdict, classifyP2pFailure, formatCheck, formatProbe, p2pFailureText, p2pFix } from '../../../src/ui/netHelp';

const net = (over: Partial<NetServerConfig> = {}): NetServerConfig => ({ ...DEFAULT_SETTINGS.net, ...over });

describe('why a P2P attempt failed', () => {
  it('the PeerJS transport tags signalling vs NAT failures', () => {
    for (const t of ['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable']) expect(mapPeerError(t).reason, t).toBe('signal');
    expect(mapPeerError('webrtc').reason).toBe('ice');
    expect(mapPeerError('peer-unavailable').code).toBe('roomNotFound');
    expect(preOpenFailure({ type: 'negotiation-failed' }).reason).toBe('ice');
    expect(preOpenFailure(null).reason).toBe('ice');
    // the code (and so every existing check on it) is unchanged
    expect(mapPeerError('network').code).toBe('networkRestricted');
  });

  it('classifies (a) signalling unreachable, (b) peer connection failed, (c) room not found', () => {
    expect(classifyP2pFailure(new NetError('networkRestricted', 'signalling timeout', 'signal'))).toBe('signal');
    expect(classifyP2pFailure(mapPeerError('server-error'))).toBe('signal');
    expect(classifyP2pFailure(new NetError('networkRestricted', 'ICE failed', 'ice'))).toBe('ice');
    expect(classifyP2pFailure(new NetError('timeout', 'no answer from the host', 'ice'))).toBe('ice');
    expect(classifyP2pFailure(new NetError('roomNotFound'))).toBe('notFound');
    // session error payloads ({code, zh, en}) and errors without a reason: the detail text decides
    expect(classifyP2pFailure({ code: 'networkRestricted', zh: '', en: 'Network restricted (signalling timeout)' })).toBe('signal');
    expect(classifyP2pFailure({ code: 'networkRestricted', en: 'Network restricted (network)' })).toBe('signal');
    expect(classifyP2pFailure({ code: 'networkRestricted', en: 'Network restricted (ICE checking)' })).toBe('ice');
    expect(classifyP2pFailure({ code: 'networkRestricted', en: 'Network restricted' })).toBe('ice');
    // not a connectivity problem: no P2P advice
    for (const code of ['versionMismatch', 'roomFull', 'kicked', 'inProgress', 'unsupported']) expect(classifyP2pFailure(new NetError(code as never)), code).toBeNull();
    expect(classifyP2pFailure(new NetError('timeout'))).toBeNull();
    expect(classifyP2pFailure(null)).toBeNull();
    expect(classifyP2pFailure('boom')).toBeNull();
  });

  it('plain words for each, in both languages', () => {
    for (const k of ['signal', 'ice', 'notFound'] as const) {
      const txt = p2pFailureText(k);
      expect(txt.zh.length).toBeGreaterThan(10);
      expect(txt.en.length).toBeGreaterThan(10);
    }
    expect(p2pFailureText('signal').zh).toContain('0.peerjs.com');
    expect(p2pFailureText('ice').zh).toContain('NAT');
    expect(p2pFailureText('notFound').en).toMatch(/not found/i);
  });

  it('the fix: 改用官方服务器重试 when there is an official server, else 改用服务器模式 + a hint', () => {
    const host = p2pFix('signal', { official: true, host: true });
    expect(host.action).toBe('official');
    expect(host.label.zh).toBe('改用官方服务器重试');
    // a guest cannot move a P2P room: the host has to re-create it there
    expect(p2pFix('ice', { official: true, host: false }).hint.zh).toContain('房主');
    const none = p2pFix('ice', { official: false, host: true });
    expect(none.action).toBe('ws');
    expect(none.label.zh).toBe('改用服务器模式');
    expect(none.hint.zh).toContain('npm run server');
    expect(none.hint.en).toContain('npm run server');
  });
});

describe('联机检测 rows', () => {
  const results: ProbeResult[] = [
    { id: 'signal', ok: true, ms: 182.4, target: '0.peerjs.com' },
    { id: 'ice', ok: false, ms: 7000, detail: 'no relay candidate (host+srflx)' },
    { id: 'relay', ok: true, ms: 45, target: '47-242-10-3.sslip.io' },
  ];

  it('✓/✗ with ms, per probe, zh and en', () => {
    expect(formatProbe(results[0], 'zh')).toBe('✓ P2P 信令服务器 (0.peerjs.com) · 182 ms');
    expect(formatProbe(results[0], 'en')).toBe('✓ P2P signalling server (0.peerjs.com) · 182 ms');
    expect(formatProbe(results[1], 'en')).toBe('✗ STUN/TURN relay (P2P traversal) · 7000 ms · no relay candidate (host+srflx)');
    expect(formatProbe({ id: 'signal', ok: false, ms: 6000, target: '0.peerjs.com', detail: 'timeout' }, 'zh')).toBe('✗ P2P 信令服务器 (0.peerjs.com) · 6000 ms · 超时');
    expect(formatProbe({ id: 'relay', ok: null, ms: null, detail: 'not configured' }, 'zh')).toBe('– 官方服务器 · 未配置');
    expect(formatProbe({ id: 'relay', ok: null, ms: null, detail: 'not configured' }, 'en')).toBe('– Official server · not configured');
  });

  it('the copied text: a dated header and one row per probe', () => {
    const text = formatCheck(results, 'zh', new Date(2026, 8, 27, 9, 5));
    expect(text.split('\n')).toEqual([
      '联机检测 2026-09-27 09:05',
      '✓ P2P 信令服务器 (0.peerjs.com) · 182 ms',
      '✗ STUN/TURN 中继（P2P 穿透） · 7000 ms · no relay candidate (host+srflx)',
      '✓ 官方服务器 (47-242-10-3.sslip.io) · 45 ms',
    ]);
  });

  it('a verdict line: which way to play', () => {
    expect(checkVerdict(results).zh).toContain('官方服务器');
    expect(checkVerdict([{ id: 'signal', ok: true, ms: 1 }, { id: 'ice', ok: true, ms: 1 }, { id: 'relay', ok: null, ms: null }]).en).toMatch(/should work/);
    expect(checkVerdict([{ id: 'signal', ok: false, ms: 1 }, { id: 'ice', ok: true, ms: 1 }, { id: 'relay', ok: null, ms: null }]).en).toMatch(/unreachable/);
    expect(checkVerdict([{ id: 'signal', ok: true, ms: 1 }, { id: 'ice', ok: false, ms: 1 }, { id: 'relay', ok: false, ms: 1 }]).en).toMatch(/No relay candidate/);
  });
});

describe('联机检测 probes (fakes)', () => {
  it('signalling: the PeerJS id endpoint of the configured server (the public cloud by default)', async () => {
    expect(signallingIdUrl(net()).url).toMatch(/^https:\/\/0\.peerjs\.com:443\/peerjs\/id\?ts=\d+$/);
    expect(signallingIdUrl(net({ peerHost: '192.168.1.5', peerPort: 8787, peerPath: '/peerjs', peerSecure: false })).url).toMatch(/^http:\/\/192\.168\.1\.5:8787\/peerjs\/peerjs\/id\?ts=/);
    const ok = await probeSignalling(net(), 1000, (async () => new Response('abc')) as typeof fetch);
    expect(ok).toMatchObject({ id: 'signal', ok: true, target: '0.peerjs.com' });
    const bad = await probeSignalling(net(), 1000, (async () => new Response('', { status: 502 })) as typeof fetch);
    expect(bad).toMatchObject({ ok: false, detail: 'HTTP 502' });
    const hang = await probeSignalling(net(), 60, ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch);
    expect(hang).toMatchObject({ ok: false, detail: 'timeout' });
  });

  class FakePc {
    onicecandidate: ((ev: { candidate: { type?: string; candidate: string } | null }) => void) | null = null;
    static script: ({ type?: string; candidate: string } | null)[] = [];
    createDataChannel(): void {}
    async createOffer(): Promise<object> {
      return {};
    }
    async setLocalDescription(): Promise<void> {
      for (const c of FakePc.script) setTimeout(() => this.onicecandidate?.({ candidate: c }), 1);
    }
    close(): void {}
  }

  it('ICE: ok once a relay candidate appears; the kinds seen when none does', async () => {
    FakePc.script = [{ candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host' }, { type: 'srflx', candidate: 'x' }, { type: 'relay', candidate: 'y' }];
    expect(await probeIce(net(), 1000, FakePc as never)).toMatchObject({ id: 'ice', ok: true });
    FakePc.script = [{ type: 'host', candidate: 'x' }, { type: 'srflx', candidate: 'y' }, null];
    expect(await probeIce(net(), 1000, FakePc as never)).toMatchObject({ ok: false, detail: 'no relay candidate (host+srflx)' });
    FakePc.script = [];
    expect(await probeIce(net(), 50, FakePc as never)).toMatchObject({ ok: false, detail: 'timeout' });
    expect(await probeIce(net(), 50, undefined)).toMatchObject({ ok: false, detail: 'unsupported' });
  });

  it('relay: a WebSocket that opens; not configured → not run', async () => {
    class OpenWs {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 1);
      }
      close(): void {}
    }
    class FailWs {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onerror?.(), 1);
      }
      close(): void {}
    }
    expect(await probeRelay('wss://47-242-10-3.sslip.io/ws', 1000, OpenWs as never)).toMatchObject({ id: 'relay', ok: true, target: '47-242-10-3.sslip.io' });
    expect(await probeRelay('wss://47-242-10-3.sslip.io/ws', 1000, FailWs as never)).toMatchObject({ ok: false, detail: 'error' });
    expect(await probeRelay(null)).toEqual({ id: 'relay', ok: null, ms: null, detail: 'not configured' });
  });
});
