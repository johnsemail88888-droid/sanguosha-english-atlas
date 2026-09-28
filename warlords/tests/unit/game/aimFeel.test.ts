// The local aim (game/aimFeel.ts): the sights come up at each class's pace, a sniper scope covers
// the screen once up and has two zoom steps, the scope sways and Shift holds the breath for a while.
import { describe, expect, it } from 'vitest';
import { HOLD_BREATH_MAX, AIM_PROFILES } from '../../../src/data/weaponFeel';
import { WEAPON_BY_ID } from '../../../src/data';
import { AimFeel, SCOPE_AT, type AimInput, type AimSnapshot } from '../../../src/game/aimFeel';

const DT = 1 / 60;
const base: AimInput = { weaponId: 'qilin', ads: false, blocked: false, hold: false, moving: false, airborne: false };

function run(f: AimFeel, secs: number, o: Partial<AimInput>): AimSnapshot {
  let s = f.update(0, { ...base, ...o });
  for (let t = 0; t < secs - 1e-9; t += DT) s = f.update(DT, { ...base, ...o });
  return s;
}

/** Largest sway (radians) seen over `secs`. */
function maxSway(f: AimFeel, secs: number, o: Partial<AimInput>): number {
  let m = 0;
  for (let t = 0; t < secs - 1e-9; t += DT) {
    const s = f.update(DT, { ...base, ...o });
    m = Math.max(m, Math.hypot(s.swayYaw, s.swayPitch));
  }
  return m;
}

describe('AimFeel', () => {
  it('raises the sights over the class ADS time; a sniper scope covers the screen once up', () => {
    const f = new AimFeel();
    // on the way up: no magnified world behind the gun — the zoom waits for the eye to reach the scope
    let s = run(f, 0.1, { ads: true });
    expect(s.progress).toBeGreaterThan(0.25);
    expect(s.progress).toBeLessThan(SCOPE_AT);
    expect(s.scoped).toBe(false);
    expect(s.zoom).toBe(1);
    s = run(f, 0.05, { ads: true });
    expect(s.progress).toBeGreaterThan(SCOPE_AT);
    expect(s.progress).toBeLessThan(0.6);
    expect(s.scoped).toBe(true);
    expect(s.zoom).toBeGreaterThan(1);
    expect(s.zoom).toBeLessThan(1.5);
    s = run(f, 0.2, { ads: true });
    expect(s.progress).toBe(1);
    expect(s.progress).toBeGreaterThanOrEqual(SCOPE_AT);
    expect(s.scoped).toBe(true);
    expect(s.sight).toBe('scope');
    expect(s.zoom).toBeCloseTo(4, 6);
    // let go: the scope drops out quicker than it came up
    s = run(f, AIM_PROFILES.sniper.adsTime * 0.6 + 0.02, { ads: false });
    expect(s.progress).toBe(0);
    expect(s.zoom).toBe(1);
    expect(s.scoped).toBe(false);
  });

  it('an LMG shoulders slower than an SMG; rifles never get a lens overlay', () => {
    const lmg = run(new AimFeel(), 0.15, { weaponId: 'huben', ads: true });
    const smg = run(new AimFeel(), 0.15, { weaponId: 'smg', ads: true });
    expect(smg.progress).toBe(1);
    expect(lmg.progress).toBeLessThan(0.6);
    const rifle = run(new AimFeel(), 1, { weaponId: 'carbine', ads: true });
    expect(rifle.scoped).toBe(false);
    expect(rifle.sight).toBe('holo');
    expect(rifle.zoom).toBeCloseTo(1.5, 6);
  });

  it('reloading / being knocked down lowers the sights; another weapon starts from the hip', () => {
    const f = new AimFeel();
    run(f, 1, { ads: true });
    expect(run(f, 0.5, { ads: true, blocked: true }).progress).toBe(0);
    run(f, 1, { ads: true });
    const s = f.update(DT, { ...base, ads: true, weaponId: 'carbine' });
    expect(s.progress).toBeLessThan(0.1);
    expect(s.zoom).toBeLessThan(1.05);
  });

  it('the wheel switches a sniper scope 4× ↔ 8× (only while aimed, only on a sniper)', () => {
    const f = new AimFeel();
    expect(f.cycleZoom(1)).toBe(false); // not aimed yet
    run(f, 1, { ads: true });
    expect(f.cycleZoom(1)).toBe(true);
    const s = run(f, 0.6, { ads: true });
    expect(s.zoomIndex).toBe(1);
    expect(s.zoom).toBeCloseTo(8, 2);
    expect(f.cycleZoom(1)).toBe(true);
    expect(run(f, 0.6, { ads: true }).zoom).toBeCloseTo(4, 2);
    const r = new AimFeel();
    run(r, 1, { weaponId: 'carbine', ads: true });
    expect(r.cycleZoom(1)).toBe(false);
  });

  it('a scope sways; Shift holds the breath (steady) until it runs out, then you are winded', () => {
    const f = new AimFeel();
    run(f, 1, { ads: true });
    const free = maxSway(f, 3, { ads: true });
    expect(free).toBeGreaterThan(((AIM_PROFILES.sniper.sway * Math.PI) / 180) * 0.4);
    run(f, 0.6, { ads: true, hold: true });
    const held = maxSway(f, 1.5, { ads: true, hold: true });
    expect(held).toBeLessThan(free * 0.25);
    let s = f.snapshot;
    expect(s.holding).toBe(true);
    expect(s.breath).toBeLessThan(0.6);
    // keep holding: the breath runs out → winded, sway worse than normal, Shift must be released first
    s = run(f, s.breath * HOLD_BREATH_MAX + 0.1, { ads: true, hold: true });
    expect(s.holding).toBe(false);
    expect(s.winded).toBe(true);
    const winded = maxSway(f, 1, { ads: true, hold: true });
    expect(winded).toBeGreaterThan(free);
    s = run(f, 3, { ads: true, hold: true });
    expect(s.holding).toBe(false);
    run(f, 0.1, { ads: true });
    s = run(f, 0.2, { ads: true, hold: true });
    expect(s.holding).toBe(true);
  });

  it('a rifle barely sways, a pistol not at all; moving makes a scope sway more', () => {
    const p = new AimFeel();
    run(p, 1, { weaponId: 'pistol', ads: true });
    expect(maxSway(p, 2, { weaponId: 'pistol', ads: true })).toBe(0);
    const still = new AimFeel();
    run(still, 1, { ads: true });
    const moving = new AimFeel();
    run(moving, 1, { ads: true, moving: true });
    expect(maxSway(moving, 3, { ads: true, moving: true })).toBeGreaterThan(maxSway(still, 3, { ads: true }) * 1.4);
    // no sway at all at the hip
    const hip = new AimFeel();
    expect(maxSway(hip, 2, {})).toBe(0);
  });

  it('a bow held at full draw starts to shake', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'xiaoji', ads: true });
    const fresh = maxSway(f, 1, { weaponId: 'xiaoji', ads: true });
    run(f, 2, { weaponId: 'xiaoji', ads: true });
    const tired = maxSway(f, 1, { weaponId: 'xiaoji', ads: true });
    expect(f.snapshot.drawHeld).toBeGreaterThan(AIM_PROFILES.bow.fatigueAfter);
    expect(tired).toBeGreaterThan(fresh * 2);
  });

  it('黄忠\'s 烈弓 looks through a scope: 2.5× then 5× on the wheel, the arm still tires', () => {
    const f = new AimFeel();
    let s = run(f, 1, { weaponId: 'liegong', ads: true });
    expect(s.scoped).toBe(true);
    expect(s.sight).toBe('scope');
    expect(s.zoom).toBeCloseTo(2.5, 6);
    expect(f.cycleZoom(1)).toBe(true);
    s = run(f, 0.6, { weaponId: 'liegong', ads: true });
    expect(s.zoom).toBeCloseTo(5, 2);
    const fresh = maxSway(f, 1, { weaponId: 'liegong', ads: true });
    run(f, 2, { weaponId: 'liegong', ads: true });
    expect(maxSway(f, 1, { weaponId: 'liegong', ads: true })).toBeGreaterThan(fresh * 1.4);
  });
});

describe('AimFeel recoil', () => {
  const DEG = Math.PI / 180;
  /** Fire `n` shots of the weapon at its own rate (trigger held), advancing the aim between them. */
  function spray(f: AimFeel, weaponId: string, n: number, o: Partial<AimInput> = {}): AimSnapshot {
    const gap = 1 / WEAPON_BY_ID[weaponId]!.fireRate;
    let s = f.snapshot as AimSnapshot;
    for (let i = 0; i < n; i++) {
      f.onShot(weaponId, 0.5);
      s = run(f, gap, { weaponId, ...o });
    }
    return s;
  }

  it('each shot kicks the view up (the look angles carry it: the next shots follow)', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'carbine', ads: true });
    f.onShot('carbine', 0.5);
    const s = f.update(DT, { ...base, weaponId: 'carbine', ads: true });
    expect(s.kickPitch).toBeGreaterThan(0.2 * DEG);
    expect(s.swayPitch).toBeCloseTo(s.kickPitch + 0, 3);
    expect(s.shotAge).toBeLessThan(0.05);
  });

  it('a held auto climbs; let go and the view settles back', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'carbine', ads: true });
    const s = spray(f, 'carbine', 10, { ads: true });
    expect(s.kickPitch).toBeGreaterThan(2 * DEG);
    const after = run(f, 1, { weaponId: 'carbine', ads: true });
    expect(after.kickPitch).toBeLessThan(0.05 * DEG);
  });

  it('the sniper jumps ~3° a shot and settles before the next round is chambered', () => {
    const f = new AimFeel();
    run(f, 1, { ads: true });
    f.onShot('qilin', 0.5);
    let s = f.update(DT, { ...base, ads: true });
    expect(s.kickPitch).toBeGreaterThan(2.5 * DEG);
    expect(s.cycle).toBeCloseTo(1 / WEAPON_BY_ID.qilin!.fireRate, 6);
    s = run(f, 1, { ads: true });
    expect(s.kickPitch).toBeLessThan(0.1 * DEG);
    expect(s.shotAge).toBeGreaterThan(0.9);
  });

  it('a braced LMG climbs less aimed than from the hip; another weapon drops the recoil', () => {
    const hip = new AimFeel();
    run(hip, 0.1, { weaponId: 'huben' });
    const h = spray(hip, 'huben', 8);
    const ads = new AimFeel();
    run(ads, 1, { weaponId: 'huben', ads: true });
    const a = spray(ads, 'huben', 8, { ads: true });
    expect(a.kickPitch).toBeLessThan(h.kickPitch * 0.7);
    const s = ads.update(DT, { ...base, weaponId: 'carbine' });
    expect(s.kickPitch).toBe(0);
    // a shot of a weapon no longer in hand does nothing
    ads.onShot('huben');
    expect(ads.update(DT, { ...base, weaponId: 'carbine' }).kickPitch).toBe(0);
  });
});
