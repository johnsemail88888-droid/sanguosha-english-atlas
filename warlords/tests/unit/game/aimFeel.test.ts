// The local aim (game/aimFeel.ts): the sights come up at each class's pace, a sniper scope covers
// the screen once up (fading in from 0.70, opaque at 0.85, then settling onto the aim point) and
// has two zoom steps, the scope sways (0.22° at 4×, 0.26° at 8×) and the breath key holds the breath
// for a while (less steady on the move). Recoil (spec C3): kicks ease in over 60 ms, autos settle
// back only recoverFrac of the climb, a pull-down first eats the climb (no overshoot), the LMG's
// first 8 shots jump, touch kicks 0.6×, the climb is capped at 9°.
import { describe, expect, it } from 'vitest';
import { AIMED_AT, AIM_PROFILES, HOLD_BREATH_MAX, RECOIL_MAX_DEG, shotKick } from '../../../src/data/weaponFeel';
import { WEAPON_BY_ID } from '../../../src/data';
import {
  AimFeel,
  HOLD_STEADY,
  KICK_EASE,
  SCOPE_AT,
  SCOPE_FADE,
  SETTLE_DEG,
  TOUCH_RECOIL,
  holdBreathSway,
  scopeSettleDeg,
  type AimInput,
  type AimSnapshot,
} from '../../../src/game/aimFeel';

const DT = 1 / 60;
const DEG = Math.PI / 180;
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
  it('raises the sights over the class ADS time; a sniper scope fades in from 0.70, opaque at 0.85', () => {
    expect(SCOPE_AT).toBe(0.7);
    expect(SCOPE_AT + SCOPE_FADE).toBeCloseTo(0.85, 9);
    const f = new AimFeel();
    // on the way up: no magnified world behind the gun — the zoom waits for the eye to reach the scope
    let s = run(f, 0.2, { ads: true });
    expect(s.progress).toBeGreaterThan(0.45);
    expect(s.progress).toBeLessThan(SCOPE_AT);
    expect(s.scoped).toBe(false);
    expect(s.zoom).toBe(1);
    s = run(f, 0.1, { ads: true });
    expect(s.progress).toBeGreaterThan(SCOPE_AT);
    expect(s.progress).toBeLessThan(0.85);
    expect(s.scoped).toBe(true);
    expect(s.zoom).toBeGreaterThan(1);
    expect(s.zoom).toBeLessThan(1.5);
    s = run(f, 0.2, { ads: true });
    expect(s.progress).toBe(1);
    expect(s.aimed).toBe(true);
    expect(s.scoped).toBe(true);
    expect(s.sight).toBe('scope');
    expect(s.zoom).toBeCloseTo(4, 6);
    // let go: the scope drops out quicker than it came up
    s = run(f, AIM_PROFILES.sniper.adsTime * 0.6 + 0.02, { ads: false });
    expect(s.progress).toBe(0);
    expect(s.zoom).toBe(1);
    expect(s.scoped).toBe(false);
  });

  it('a scope settles onto the aim point: 0.6° off once the lens is opaque, dead on at full aim', () => {
    expect(scopeSettleDeg(0.5)).toBe(0);
    expect(scopeSettleDeg(SCOPE_AT + SCOPE_FADE)).toBeCloseTo(SETTLE_DEG, 9);
    expect(scopeSettleDeg(0.92)).toBeGreaterThan(0);
    expect(scopeSettleDeg(0.92)).toBeLessThan(SETTLE_DEG);
    expect(scopeSettleDeg(1)).toBe(0);
    // it rides on the look angles (the host's ray follows the reticle): measured with no sway yet
    const f = new AimFeel();
    let s = f.update(0, { ...base, ads: true });
    for (let i = 0; i < 21; i++) s = f.update(DT, { ...base, ads: true }); // 0.35 s: progress 0.875
    expect(s.progress).toBeGreaterThan(0.85);
    const off = Math.hypot(s.swayYaw, s.swayPitch) / DEG;
    expect(off).toBeGreaterThan(0.4);
    expect(off).toBeLessThan(0.75);
    // a rifle's holo has no settle
    const r = new AimFeel();
    for (let i = 0; i < 12; i++) s = r.update(DT, { ...base, weaponId: 'carbine', ads: true });
    expect(Math.abs(s.swayPitch)).toBeLessThan(0.05 * DEG);
  });

  it('an LMG shoulders slower than an SMG; rifles and DMRs never get a lens overlay', () => {
    const lmg = run(new AimFeel(), 0.15, { weaponId: 'huben', ads: true });
    const smg = run(new AimFeel(), 0.15, { weaponId: 'smg', ads: true });
    expect(smg.progress).toBe(1);
    expect(lmg.progress).toBeLessThan(0.45);
    const rifle = run(new AimFeel(), 1, { weaponId: 'carbine', ads: true });
    expect(rifle.scoped).toBe(false);
    expect(rifle.sight).toBe('holo');
    expect(rifle.zoom).toBeCloseTo(WEAPON_BY_ID.carbine!.adsZoom, 6);
    // the DMR is a near sight: zooms with the aim, the gun stays in view
    const dmr = run(new AimFeel(), 1, { weaponId: 'qinggang', ads: true });
    expect(dmr.scoped).toBe(false);
    expect(dmr.sight).toBe('marksman');
    expect(dmr.zoom).toBeCloseTo(WEAPON_BY_ID.qinggang!.adsZoom, 6);
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

  it('a scope sways more at 8× than at 4×', () => {
    const f4 = new AimFeel();
    run(f4, 1, { ads: true });
    const s4 = maxSway(f4, 4, { ads: true });
    const f8 = new AimFeel();
    run(f8, 1, { ads: true });
    f8.cycleZoom(1);
    run(f8, 1, { ads: true });
    const s8 = maxSway(f8, 4, { ads: true });
    expect(s8).toBeGreaterThan(s4 * 1.08);
    // (yaw up to the amplitude, pitch up to 0.6 of it: the combined offset stays under 1.17 ×)
    expect(s4 / DEG).toBeLessThanOrEqual(0.22 * 1.17);
    expect(s4 / DEG).toBeGreaterThan(0.22 * 0.6);
  });

  it('a scope sways; the breath key holds the breath (steady) until it runs out, then you are winded', () => {
    const f = new AimFeel();
    run(f, 1, { ads: true });
    const free = maxSway(f, 4, { ads: true });
    expect(free).toBeGreaterThan(((AIM_PROFILES.sniper.sway * Math.PI) / 180) * 0.4);
    run(f, 0.6, { ads: true, hold: true });
    const held = maxSway(f, 1.5, { ads: true, hold: true });
    expect(held).toBeLessThan(free * 0.25);
    let s = f.snapshot;
    expect(s.holding).toBe(true);
    expect(s.breath).toBeLessThan(0.6);
    // keep holding: the breath runs out → winded, sway worse than normal, the key must be released first
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

  it('held breath steadies less on the move: sway × (0.08 + 0.42 · speed / 2.5)', () => {
    expect(holdBreathSway(0)).toBeCloseTo(HOLD_STEADY, 9);
    expect(holdBreathSway(1.25)).toBeCloseTo(0.08 + 0.21, 9);
    expect(holdBreathSway(2.5)).toBeCloseTo(0.5, 9);
    expect(holdBreathSway(6)).toBeCloseTo(0.5, 9);
    const still = new AimFeel();
    run(still, 1, { ads: true });
    run(still, 0.5, { ads: true, hold: true });
    const s0 = maxSway(still, 1.2, { ads: true, hold: true });
    const walk = new AimFeel();
    run(walk, 1, { ads: true, moving: true, speed: 2.5 });
    run(walk, 0.5, { ads: true, hold: true, moving: true, speed: 2.5 });
    const s1 = maxSway(walk, 1.2, { ads: true, hold: true, moving: true, speed: 2.5 });
    expect(walk.snapshot.holding).toBe(true);
    expect(s1).toBeGreaterThan(s0 * 4);
  });

  it('breath holds only once fully aimed (progress ≥ 0.92)', () => {
    expect(AIMED_AT).toBe(0.92);
    const f = new AimFeel();
    let s = f.update(0, { ...base, ads: true, hold: true });
    for (let i = 0; i < 21; i++) s = f.update(DT, { ...base, ads: true, hold: true }); // progress 0.875
    expect(s.aimed).toBe(false);
    expect(s.holding).toBe(false);
    for (let i = 0; i < 3; i++) s = f.update(DT, { ...base, ads: true, hold: true }); // 1.0
    expect(s.aimed).toBe(true);
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
    expect(maxSway(moving, 4, { ads: true, moving: true })).toBeGreaterThan(maxSway(still, 4, { ads: true }) * 1.4);
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

  it('each shot kicks the view up, eased in over 60 ms (the look angles carry it: the next shots follow)', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'carbine', ads: true });
    f.onShot('carbine', 0.5);
    const full = shotKick(WEAPON_BY_ID.carbine!, 1).pitch * DEG;
    let s = f.update(DT, { ...base, weaponId: 'carbine', ads: true });
    // one frame in: part of the kick, not all of it
    expect(s.kickPitch).toBeGreaterThan(full * 0.3);
    expect(s.kickPitch).toBeLessThan(full * 0.8);
    s = run(f, KICK_EASE, { weaponId: 'carbine', ads: true });
    expect(s.kickPitch).toBeCloseTo(full, 6);
    expect(s.swayPitch).toBeCloseTo(s.kickPitch, 3);
    expect(s.shotAge).toBeLessThan(0.1);
  });

  it('a held auto climbs; let go and the view settles back — to recoverFrac of the climb (the rest is yours)', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'carbine', ads: true });
    const s = spray(f, 'carbine', 10, { ads: true });
    const climb = s.kickPitch;
    expect(climb).toBeGreaterThan(2 * DEG);
    const after = run(f, 1, { weaponId: 'carbine', ads: true });
    expect(after.kickPitch).toBeLessThan(0.05 * DEG);
    // the 20 % a rifle does not return moves into the base look (the InputController adds it)
    const r = f.takeResidual();
    expect(r.pitch).toBeCloseTo(climb * (1 - AIM_PROFILES.rifle.recoverFrac), 2);
    expect(f.takeResidual().pitch).toBe(0);
    // a sniper returns all of it
    const q = new AimFeel();
    run(q, 1, { ads: true });
    q.onShot('qilin', 0.5);
    run(q, 1, { ads: true });
    expect(q.takeResidual().pitch).toBe(0);
  });

  it('pulling down against the climb eats it first: no overshoot under the target after compensating', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'carbine', ads: true });
    spray(f, 'carbine', 8, { ads: true });
    const climb = f.snapshot.kickPitch;
    // the player pulls down exactly the climb: nothing is left for the base look, the view is back on target
    const left = f.absorbPitch(-climb);
    expect(left).toBeCloseTo(0, 9);
    expect(f.snapshot.kickPitch + 0).toBeGreaterThanOrEqual(0);
    const s = run(f, 1, { weaponId: 'carbine', ads: true });
    expect(s.kickPitch).toBeLessThan(1e-4);
    expect(f.takeResidual().pitch).toBeCloseTo(0, 6);
    // pulling down more than the climb passes the rest to the base look; looking up is untouched
    const g = new AimFeel();
    run(g, 1, { weaponId: 'carbine', ads: true });
    spray(g, 'carbine', 3, { ads: true });
    const c = g.snapshot.kickPitch;
    expect(g.absorbPitch(-(c + 0.01))).toBeCloseTo(-0.01, 9);
    expect(g.absorbPitch(0.02)).toBe(0.02);
  });

  it('the LMG\'s first 8 shots jump (× 1.5), shot 9 on is braced (× 0.6)', () => {
    const f = new AimFeel();
    run(f, 1, { weaponId: 'huben', ads: true });
    const gap = 1 / WEAPON_BY_ID.huben!.fireRate;
    const per = shotKick(WEAPON_BY_ID.huben!, 1).pitch * DEG;
    const deltas: number[] = [];
    for (let i = 0; i < 10; i++) {
      const before = f.snapshot.kickPitch;
      f.onShot('huben', 0.5);
      const s = run(f, gap, { weaponId: 'huben', ads: true });
      deltas.push(s.kickPitch - before);
      expect(s.burstShots).toBe(i + 1);
    }
    expect(deltas[0]).toBeCloseTo(per * 1.5, 6);
    expect(deltas[7]).toBeCloseTo(per * 1.5, 6);
    expect(deltas[8]).toBeCloseTo(per * 0.6, 6);
    expect(deltas[9]).toBeCloseTo(per * 0.6, 6);
    expect(AIM_PROFILES.lmg.recoverFrac).toBe(0.7);
  });

  it('touch kicks 0.6× as hard', () => {
    const m = new AimFeel();
    run(m, 1, { weaponId: 'carbine', ads: true });
    m.onShot('carbine', 0.5);
    const mouse = run(m, 0.1, { weaponId: 'carbine', ads: true }).kickPitch;
    const t = new AimFeel();
    run(t, 1, { weaponId: 'carbine', ads: true, touch: true });
    t.onShot('carbine', 0.5);
    const touch = run(t, 0.1, { weaponId: 'carbine', ads: true, touch: true }).kickPitch;
    expect(touch).toBeCloseTo(mouse * TOUCH_RECOIL, 6);
  });

  it('the outstanding climb never passes 9°', () => {
    const f = new AimFeel();
    run(f, 0.1, { weaponId: 'wushuang' });
    for (let i = 0; i < 60; i++) {
      f.onShot('wushuang', 1);
      run(f, 1 / 30, { weaponId: 'wushuang' });
    }
    const s = run(f, 0.1, { weaponId: 'wushuang' });
    expect(s.kickPitch).toBeLessThanOrEqual(RECOIL_MAX_DEG * DEG + 1e-9);
    expect(s.kickPitch).toBeGreaterThan(RECOIL_MAX_DEG * DEG * 0.95);
    expect(Math.abs(s.kickYaw)).toBeLessThanOrEqual(RECOIL_MAX_DEG * 0.5 * DEG + 1e-9);
  });

  it('the sniper jumps ~3° a shot and settles before the next round is chambered', () => {
    const f = new AimFeel();
    run(f, 1, { ads: true });
    f.onShot('qilin', 0.5);
    let s = run(f, KICK_EASE + DT, { ads: true });
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
