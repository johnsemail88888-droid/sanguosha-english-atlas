// MP2-9: with ?debug=1 an online host must not hand out its session internals — the
// HostSession holds the dealt roles, the sim and the guests' seat tokens. __sgwl gives
// narrow stand-ins instead (the GameSession API, the host player's own view); local
// single-player sessions and guests keep the full objects (cheats, e2e helpers).
import { afterEach, describe, expect, it } from 'vitest';
import { DebugHooks, type SgwlDebug } from '../../../src/game/debug';
import type { GameSession } from '../../../src/game/session';
import { addClient, cleanupHarness, makeHost, runToPlaying } from './harness';

afterEach(() => {
  cleanupHarness();
  delete (globalThis as { __sgwl?: SgwlDebug }).__sgwl;
});

/** Every object reachable from `root` through properties and getters (not through closures, which script cannot read). */
function reachable(root: unknown, depth = 7): Set<object> {
  const seen = new Set<object>();
  const walk = (v: unknown, d: number): void => {
    if (d < 0 || v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v as object)) return;
    seen.add(v as object);
    let o: object | null = v as object;
    while (o && o !== Object.prototype && o !== Function.prototype) {
      for (const k of Reflect.ownKeys(o)) {
        if (k === 'constructor' || k === 'caller' || k === 'callee' || k === 'arguments') continue;
        let x: unknown;
        try {
          x = Reflect.get(o, k, v);
        } catch {
          continue;
        }
        walk(x, d - 1);
      }
      o = Object.getPrototypeOf(o);
    }
  };
  walk(root, depth);
  return seen;
}

describe('debug hooks on an online host (MP2-9)', () => {
  it('__sgwl never reaches the HostSession, its sim or its deal — the public API and the own view still work', async () => {
    const h = makeHost({ seed: 71 });
    const a = await addClient(h, 'A');
    const hooks = new DebugHooks('test', () => null);
    hooks.trackSession(h.host as GameSession, 'host');
    await runToPlaying(h);
    const renderer = { stats: () => ({ calls: 1 }), view: h.host.view };
    hooks.attachGame({ view: h.host.view!, session: h.host, handle: { renderer }, gameHandle: { view: h.host.view } });
    const g = (globalThis as { __sgwl?: SgwlDebug }).__sgwl!;

    const s = g.session!;
    expect(s).not.toBe(h.host);
    expect(s.phase).toBe('playing');
    expect(s.myId).toBe(h.host.myId);
    expect(s.lobby?.seats.length).toBe(h.host.lobby.seats.length);
    expect((s as unknown as Record<string, unknown>).dealtRoles).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).simHost).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).deal).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).transport).toBeUndefined();
    expect(g.handle).toBeNull();
    expect(g.gameHandle).toBeNull();
    expect(g.stats()).toEqual({ calls: 1 }); // (read through the hooks, not handed out)
    // the host player's own view
    expect(g.view!.players()).toEqual(h.host.view!.players());
    expect(g.players().length).toBe(h.host.lobby.seats.length);
    expect(g.localId()).toBe(h.host.view!.localId());
    const statuses: string[] = [];
    const off = s.on('status', (st) => statuses.push(st.en));
    expect(typeof off).toBe('function');

    // nothing reachable from window.__sgwl is the host session, the sim, the deal, the real view or the transport
    const secrets: object[] = [h.host, h.sims[0], h.host.dealtRoles!, h.host.view!, h.net as object];
    expect(reachable(h.host).has(h.sims[0])).toBe(true); // (the walk does find what a real reference exposes)
    expect(reachable({ view: h.host.view }).has(h.sims[0])).toBe(true);
    const all = reachable(g);
    for (const x of secrets) expect(all.has(x)).toBe(false);
    // … nor any guest's seat token
    const text = JSON.stringify([...all].filter((x) => typeof x === 'object').map((x) => Object.entries(x as object).filter(([, v]) => typeof v === 'string')));
    expect(text).not.toContain(a.session.seatToken!);
  });

  it('local single player and guests keep the full objects (cheats and e2e helpers)', async () => {
    const h = makeHost({ seed: 72 });
    const a = await addClient(h, 'A');
    const hooks = new DebugHooks('test', () => null);
    const g = () => (globalThis as { __sgwl?: SgwlDebug }).__sgwl!;
    hooks.trackSession(a.session as GameSession, 'guest');
    expect(g().session).toBe(a.session);
    hooks.trackSession(h.host as GameSession, 'local');
    expect(g().session).toBe(h.host);
  });
});
