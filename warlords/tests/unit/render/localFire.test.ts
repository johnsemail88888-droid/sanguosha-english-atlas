import { describe, expect, it } from 'vitest';
import { LocalFirePredictor, type LocalFireGate } from '../../../src/render/localFire';

type Def = Parameters<LocalFirePredictor['update']>[4];
const rifle = (fireRate = 10, magSize = 30, extra: Partial<NonNullable<Def>> = {}): NonNullable<Def> => ({
  auto: true,
  fireRate,
  magSize,
  special: 'none',
  specialParams: {},
  ...extra,
});
const open: LocalFireGate = { canShoot: true, reloading: false, noReload: false };

/**
 * Minimal host model: fires at `hostRate` while held (consuming `mag` unless
 * noReload); its shot events and magazine reach the client `latency` later.
 */
function simulate(opts: {
  def: NonNullable<Def>;
  seconds: number;
  mag: number;
  hostRate?: number;
  latency?: number;
  noReload?: boolean;
  weapon?: string;
  hostWeapon?: string;
}): { local: number; host: number; confirmed: number; predictor: LocalFirePredictor } {
  const p = new LocalFirePredictor();
  const dt = 1 / 60;
  const latency = opts.latency ?? 0.1;
  const hostRate = opts.hostRate ?? opts.def.fireRate;
  const weapon = opts.weapon ?? 'w';
  let hostMag = opts.mag;
  let hostNext = 0;
  const inflight: { at: number; mag: number; shot: boolean }[] = [];
  let seenMag = opts.mag;
  let local = 0;
  let host = 0;
  let confirmed = 0;
  for (let t = 0; t < opts.seconds; t += dt) {
    // host tick
    while (t >= hostNext && hostMag > 0) {
      if (!opts.noReload) hostMag--;
      host++;
      inflight.push({ at: t + latency, mag: hostMag, shot: true });
      hostNext = Math.max(hostNext, t - dt) + 1 / hostRate;
    }
    // deliveries
    while (inflight.length && inflight[0].at <= t) {
      const m = inflight.shift()!;
      seenMag = m.mag;
      if (m.shot && p.confirmHostShot(t, opts.hostWeapon ?? weapon)) confirmed++;
    }
    local += p.update(t, dt, true, { id: weapon, slot: 0, mag: seenMag }, opts.def, { ...open, noReload: !!opts.noReload });
  }
  return { local, host, confirmed, predictor: p };
}

describe('LocalFirePredictor', () => {
  it('predicts exactly the host shots of a plain automatic weapon', () => {
    const r = simulate({ def: rifle(10, 30), seconds: 2, mag: 30 });
    expect(r.host).toBe(20);
    expect(Math.abs(r.local - r.host)).toBeLessThanOrEqual(1);
    expect(r.confirmed).toBeGreaterThanOrEqual(r.host - 2);
  });

  it('never predicts phantom shots at the end of the magazine (RTT lag)', () => {
    const r = simulate({ def: rifle(12, 30), seconds: 4, mag: 8, latency: 0.25 });
    expect(r.host).toBe(8);
    expect(r.local).toBe(8);
  });

  it('keeps firing under noReload (magazine never changes)', () => {
    const r = simulate({ def: rifle(10, 30), seconds: 3, mag: 5, noReload: true });
    expect(r.host).toBe(30);
    expect(r.local).toBeGreaterThanOrEqual(28);
  });

  it('detects infinite ammo from confirmed shots that never drain the magazine', () => {
    // no noReload status (passive infiniteAmmo): the predictor learns it from the host
    const p = new LocalFirePredictor();
    const def = rifle(10, 30);
    let local = 0;
    for (let i = 0; i < 180; i++) {
      const t = i / 60;
      local += p.update(t, 1 / 60, true, { id: 'w', slot: 0, mag: 3 }, def, open);
      if (i % 6 === 0) p.confirmHostShot(t, 'w');
    }
    expect(local).toBeGreaterThan(20);
  });

  it('learns a faster host cadence (fireRateUp / passives)', () => {
    const r = simulate({ def: rifle(8, 200), seconds: 4, mag: 200, hostRate: 12 });
    expect(r.predictor.inferredRateMul).toBeGreaterThan(1.3);
    // most host shots were predicted locally (instant feedback)
    expect(r.confirmed / r.host).toBeGreaterThan(0.85);
  });

  it('follows the rapid-fire ramp (诸葛连弩)', () => {
    const def = rifle(8, 400, { special: 'rapid', specialParams: { rampTime: 1, rampMul: 2 } });
    const p = new LocalFirePredictor();
    let early = 0;
    let late = 0;
    for (let i = 0; i < 180; i++) {
      const t = i / 60;
      const n = p.update(t, 1 / 60, true, { id: 'w', slot: 0, mag: 400 }, def, open);
      if (t < 0.5) early += n;
      else if (t >= 2 && t < 2.5) late += n;
    }
    expect(late).toBeGreaterThan(early * 1.5);
  });

  it('does not fire while disarmed / stunned / reloading', () => {
    const p = new LocalFirePredictor();
    const w = { id: 'w', slot: 0, mag: 30 };
    for (let i = 0; i < 60; i++) {
      expect(p.update(i / 60, 1 / 60, true, w, rifle(), { ...open, canShoot: false })).toBe(0);
      expect(p.update(i / 60, 1 / 60, true, w, rifle(), { ...open, reloading: true })).toBe(0);
    }
  });

  it('semi-automatic weapons fire once per press', () => {
    const p = new LocalFirePredictor();
    const def = rifle(3, 10, { auto: false });
    const w = { id: 'w', slot: 0, mag: 10 };
    let n = 0;
    for (let i = 0; i < 60; i++) n += p.update(i / 60, 1 / 60, true, w, def, open);
    expect(n).toBe(1);
    n += p.update(1.1, 1 / 60, false, w, def, open);
    n += p.update(1.2, 1 / 60, true, w, def, open);
    expect(n).toBe(2);
  });

  it('host shots of another weapon / ability never consume a prediction', () => {
    const p = new LocalFirePredictor();
    p.update(0, 1 / 60, true, { id: 'w', slot: 0, mag: 30 }, rifle(), open);
    expect(p.outstanding('w')).toBe(1);
    expect(p.confirmHostShot(0.05, 'zhangjiao_leiji')).toBe(false);
    expect(p.outstanding('w')).toBe(1);
    expect(p.confirmHostShot(0.06, 'w')).toBe(true);
    expect(p.outstanding('w')).toBe(0);
    // unmatched host shots are drawn by the event path
    expect(p.confirmHostShot(0.07, 'w')).toBe(false);
  });

  it('drops predictions the host never confirmed', () => {
    const p = new LocalFirePredictor();
    p.update(0, 1 / 60, true, { id: 'w', slot: 0, mag: 30 }, rifle(), open);
    p.update(2, 1 / 60, false, { id: 'w', slot: 0, mag: 30 }, rifle(), open);
    expect(p.outstanding('w')).toBe(0);
  });
});
