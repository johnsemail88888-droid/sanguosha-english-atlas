import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { PrivateHeroView, ViewEntity } from '../../../src/core/types';
import { SFX } from '../../../src/audio/catalog';
import type { SfxName } from '../../../src/audio/catalog';
import { fakeView } from '../../../src/audio/render';
import { EventRouter } from '../../../src/audio/router';
import type { SoundSink } from '../../../src/audio/router';
import type { PlayOpts } from '../../../src/audio/sfx';
import { THROTTLE_RULES, VoicePool } from '../../../src/audio/voices';
import type { VoiceRecord } from '../../../src/audio/voices';

function rec(pool: VoicePool, group: string, priority: number, start: number, dur = 1): VoiceRecord & { killed: number | null; disposed: boolean } {
  const r = {
    id: pool.allocId(),
    group,
    priority,
    start,
    end: start + dur,
    killed: null as number | null,
    disposed: false,
    kill(at: number) {
      r.killed = at;
    },
    dispose() {
      r.disposed = true;
    },
  };
  return r;
}

function start(pool: VoicePool, group: string, priority: number, t: number, dur = 1) {
  const adm = pool.admit(group, priority, t, t);
  if (!adm.ok) return null;
  for (const s of adm.steal) pool.stop(s, t);
  const r = rec(pool, group, priority, t, dur);
  pool.add(r);
  return { r, adm };
}

describe('VoicePool', () => {
  it('enforces the minimum gap per group', () => {
    const pool = new VoicePool(32, { a: { minGap: 0.05, maxConcurrent: 10 } });
    expect(start(pool, 'a', 1, 0)).not.toBeNull();
    expect(start(pool, 'a', 1, 0.01)).toBeNull();
    expect(start(pool, 'a', 1, 0.06)).not.toBeNull();
    // other groups are independent
    expect(start(pool, 'b', 1, 0.061)).not.toBeNull();
  });

  it('caps concurrency per group by replacing the oldest voice', () => {
    const pool = new VoicePool(32, { s: { minGap: 0, maxConcurrent: 3 } });
    const a = start(pool, 's', 1, 0)!;
    start(pool, 's', 1, 0.01);
    start(pool, 's', 1, 0.02);
    expect(pool.countGroup('s')).toBe(3);
    const d = start(pool, 's', 1, 0.03);
    expect(d).not.toBeNull();
    expect(a.r.killed).toBe(0.03);
    expect(pool.countGroup('s')).toBe(3);
  });

  it('never exceeds capacity and steals lowest priority first', () => {
    const pool = new VoicePool(4, {}, { minGap: 0, maxConcurrent: 99 });
    const low = start(pool, 'x', 0, 0)!;
    start(pool, 'x', 2, 0.01);
    start(pool, 'x', 2, 0.02);
    start(pool, 'x', 2, 0.03);
    expect(pool.size).toBe(4);
    const hi = start(pool, 'x', 3, 0.04);
    expect(hi).not.toBeNull();
    expect(low.r.killed).not.toBeNull();
    expect(pool.size).toBe(4);
    // a lower-priority newcomer cannot steal
    expect(start(pool, 'x', 0, 0.05)).toBeNull();
    expect(pool.size).toBe(4);
  });

  it('eight simultaneous shotguns are throttled and gain-compensated', () => {
    const pool = new VoicePool(32, THROTTLE_RULES);
    let admitted = 0;
    let minComp = 1;
    for (let i = 0; i < 8; i++) {
      const res = start(pool, 'gun:shotgun', 2, 1 + i * 0.001, 1.5);
      if (res) {
        admitted++;
        minComp = Math.min(minComp, res.adm.gainComp);
      }
    }
    expect(admitted).toBeLessThanOrEqual(THROTTLE_RULES['gun:shotgun'].maxConcurrent);
    expect(admitted).toBeGreaterThanOrEqual(1);
    // staggered shots are admitted, stacked ones compensated below unity
    for (let i = 0; i < 4; i++) {
      const res = start(pool, 'gun:shotgun', 2, 2 + i * 0.05, 1.5);
      if (res) minComp = Math.min(minComp, res.adm.gainComp);
    }
    expect(minComp).toBeLessThan(1);
    expect(pool.countGroup('gun:shotgun')).toBeLessThanOrEqual(THROTTLE_RULES['gun:shotgun'].maxConcurrent);
  });

  it('a scheduled shotgun reload script (5 shells + pump) plays every part', () => {
    const pool = new VoicePool(32, THROTTLE_RULES);
    const now = 5;
    const T = 2.5;
    const parts: ReturnType<typeof rec>[] = [];
    // as EventRouter.startReload schedules them: all admitted at `now`, starting later
    for (const f of [0.12, 0.252, 0.384, 0.516, 0.648, 0.88]) {
      const t = now + f * T;
      const adm = pool.admit('reload', 1, t, now);
      expect(adm.ok).toBe(true);
      expect(adm.steal).toHaveLength(0);
      const r = rec(pool, 'reload', 1, t, 0.3);
      pool.add(r);
      parts.push(r);
    }
    expect(parts.every((p) => p.killed === null)).toBe(true);
    // a dry-fire click meanwhile has its own group and steals nothing
    const dry = pool.admit('dry', 4, now + 0.1, now + 0.1);
    expect(dry.ok).toBe(true);
    expect(dry.steal).toHaveLength(0);
  });

  it('never steals a voice that has not started yet', () => {
    const pool = new VoicePool(2, {}, { minGap: 0, maxConcurrent: 99 });
    // two voices scheduled 1 s ahead, overlapping the newcomer's start
    for (const t of [1, 1.01]) pool.add(rec(pool, 'x', 0, t, 2));
    const adm = pool.admit('x', 3, 1.02, 0);
    expect(adm.ok).toBe(false);
    // but a voice starting now is free to play: the scheduled ones are not sounding yet
    const now = pool.admit('x', 3, 0, 0);
    expect(now.ok).toBe(true);
    expect(now.steal).toHaveLength(0);
  });

  it('group caps count voices sounding at the start time, not ones that ended', () => {
    const pool = new VoicePool(32, { s: { minGap: 0, maxConcurrent: 2 } });
    start(pool, 's', 1, 0, 0.2);
    start(pool, 's', 1, 0.05, 0.2);
    // both still sounding at 0.1 -> the oldest is replaced
    const a = pool.admit('s', 1, 0.1, 0.1);
    expect(a.ok).toBe(true);
    expect(a.steal).toHaveLength(1);
    // scheduled for after both have ended -> no stealing needed
    const b = pool.admit('s', 1, 0.5, 0.1);
    expect(b.ok).toBe(true);
    expect(b.steal).toHaveLength(0);
  });

  it('sweeps finished voices and disposes stolen ones after their fade', () => {
    const pool = new VoicePool(8, {}, { minGap: 0, maxConcurrent: 99 });
    const a = start(pool, 'x', 1, 0, 0.5)!;
    const b = start(pool, 'x', 1, 0, 5)!;
    pool.sweep(1);
    expect(a.r.disposed).toBe(true);
    expect(pool.size).toBe(1);
    pool.stop(b.r, 1);
    expect(b.r.killed).toBe(1);
    expect(b.r.disposed).toBe(false);
    pool.sweep(2);
    expect(b.r.disposed).toBe(true);
  });

  it('setCapacity shrinks the pool for low quality', () => {
    const pool = new VoicePool(32, {}, { minGap: 0, maxConcurrent: 99 });
    pool.setCapacity(2);
    start(pool, 'x', 1, 0);
    start(pool, 'x', 1, 0.1);
    start(pool, 'x', 1, 0.2);
    expect(pool.size).toBe(2);
  });
});

describe('VoicePool behind the event router (SfxEngine admission policy)', () => {
  /** a sink that admits voices exactly like SfxEngine.play (group, start, steal) */
  function poolSink(pool: VoicePool) {
    const played: { name: SfxName; variant: string; r: ReturnType<typeof rec> }[] = [];
    const lis: Vec3 = { x: 0, y: 1.6, z: 0 };
    let t = 1;
    const sink: SoundSink = {
      now: () => t,
      listener: () => lis,
      play(name: SfxName, o: PlayOpts = {}) {
        const d = SFX[name];
        const start = t + 0.004 + Math.max(0, o.delay ?? 0);
        const variant = o.variant ?? '';
        const group = o.group ?? (d.groupByVariant ? `${d.group}:${variant}` : d.group);
        const priority = o.priority ?? d.priority;
        const adm = pool.admit(group, priority, start, t);
        if (!adm.ok) return null;
        for (const v of adm.steal) pool.stop(v, start);
        const r = rec(pool, group, priority, start, 0.35);
        pool.add(r);
        played.push({ name, variant, r });
        return { end: r.end, stop: () => pool.stop(r, t) };
      },
      loop: () => undefined,
      music: () => undefined,
      dipMusic: () => undefined,
      autoDowned: () => undefined,
      downedUrgency: () => undefined,
    };
    return { sink, played, advance: (dt: number) => (t += dt) };
  }

  it('a local shotgun reload plays all its shells and the pump, even with pump clicks and dry fire around', () => {
    const pool = new VoicePool(32, THROTTLE_RULES);
    const { sink, played, advance } = poolSink(pool);
    const router = new EventRouter(sink);
    const me: ViewEntity = { id: 1, kind: 'hero', sub: 'zhangfei', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, weapon: 'zhangba' };
    const local = { weapons: [{ id: 'zhangba', mag: 2, reserve: 30 }, null], activeSlot: 0, reloading: 0, downed: false, dead: false, downedRemaining: 0, shield: 0 };
    const view = { ...fakeView([me], 1), local: () => local as unknown as PrivateHeroView };
    router.handle([], view);
    router.localFire('zhangba');
    advance(0.05);
    local.reloading = 2.5;
    router.handle([], view);
    router.dryFire();
    for (let i = 0; i < 90; i++) {
      advance(1 / 30);
      local.reloading = Math.max(0.01, local.reloading - 1 / 30);
      router.handle([], view);
    }
    const reload = played.filter((p) => p.name === 'reload' && p.r.group === 'reload');
    expect(reload.map((p) => p.variant)).toEqual(['shell', 'shell', 'shell', 'shell', 'shell', 'pump']);
    expect(reload.every((p) => p.r.killed === null)).toBe(true);
  });
});
