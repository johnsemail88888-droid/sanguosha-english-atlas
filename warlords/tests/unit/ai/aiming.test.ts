// Abilities and cards are aimed like a human would: the view turns with lag
// and a capped turn speed (never snaps), the press waits for the crosshair to
// be on target and for the reaction time, a lock-on target is only sent while
// it is inside the crosshair cone, and point casts carry difficulty-scaled
// error (easy bots miss by more than hard ones).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import { Rng } from '../../../src/core/rng';
import type { BotDifficulty, Entity, InputFrame, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import type { SimApi } from '../../../src/sim/api';
import { cameraRig } from '../../../src/sim/aim';
import { Aimer, wrapAngle } from '../../../src/sim/ai/aimer';
import { difficultyProfile } from '../../../src/sim/ai/difficulty';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { aimPointOf } from '../../../src/sim/ai/perception';
import { hero, makeWorld, place } from '../sim/helpers';

const DEG = Math.PI / 180;
const MAX_TURN: Record<BotDifficulty, number> = { easy: 260 * DEG, normal: 480 * DEG, hard: 760 * DEG };

/** Angle between the crosshair ray of (yaw, pitch) and the direction to `p`, from the camera. */
function crosshairOff(pos: Vec3, yaw: number, pitch: number, p: Vec3): number {
  const rig = cameraRig(pos, yaw, pitch);
  const vx = p.x - rig.origin.x;
  const vy = p.y - rig.origin.y;
  const vz = p.z - rig.origin.z;
  const l = Math.hypot(vx, vy, vz) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (vx * rig.dir.x + vy * rig.dir.y + vz * rig.dir.z) / l)));
}

describe('Aimer: point aims carry human error', () => {
  /** Aim at a point 28 m away, 70° off the current view; release when the aimer is "on it". */
  function trial(d: BotDifficulty, seed: number): { miss: number; time: number; maxStep: number } {
    const prof = difficultyProfile(d);
    const aimer = new Aimer(prof, new Rng(seed));
    const self = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hero: { downed: false } } as unknown as Entity;
    const clock = { time: 0 };
    const sim = { get time() { return clock.time; }, eyePos: (e: Entity) => ({ x: e.pos.x, y: e.pos.y + 1.6, z: e.pos.z }) } as unknown as SimApi;
    const a = 70 * DEG;
    const target = { x: -Math.sin(a) * 28, y: 0.2, z: -Math.cos(a) * 28 };
    let prevYaw = 0;
    let maxStep = 0;
    for (let t = 0; t < 90; t++) {
      clock.time = t / 30;
      const o = aimer.aimAtPoint(sim, self, target, 1 / 30, -1);
      maxStep = Math.max(maxStep, Math.abs(wrapAngle(o.yaw - prevYaw)));
      prevYaw = o.yaw;
      if (clock.time >= prof.reaction * 0.6 && o.errAngle <= 3 * DEG) {
        const hit = o.point;
        return { miss: Math.hypot(hit.x - target.x, hit.z - target.z), time: clock.time, maxStep };
      }
    }
    return { miss: Infinity, time: Infinity, maxStep };
  }

  it('never snaps: the view turns at most the difficulty’s turn speed per tick', () => {
    for (const d of ['easy', 'normal', 'hard'] as const) {
      for (let s = 1; s <= 8; s++) expect(trial(d, s).maxStep).toBeLessThanOrEqual(MAX_TURN[d] / 30 + 1e-9);
    }
  });

  it('easy bots take longer and land further off than hard bots', () => {
    const stats = (d: BotDifficulty): { miss: number; time: number } => {
      let miss = 0;
      let time = 0;
      const n = 40;
      for (let s = 1; s <= n; s++) {
        const r = trial(d, 1000 + s);
        miss += Math.min(r.miss, 20);
        time += Math.min(r.time, 3);
      }
      return { miss: miss / n, time: time / n };
    };
    const easy = stats('easy');
    const hard = stats('hard');
    expect(easy.time).toBeGreaterThan(hard.time);
    expect(easy.miss).toBeGreaterThan(hard.miss * 1.3);
    expect(hard.miss).toBeGreaterThan(0); // never pixel-perfect
  });
});

describe('HeroBot: abilities go through the aimer', () => {
  const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
  // heroes with aimed actives: lock-on (enemy), ground (point) and skillshots (direction)
  const AIMED = ['guanyu', 'ganning', 'zhangjiao', 'yuanshao', 'huangzhong', 'lubu', 'zhouyu', 'diaochan'];

  interface Press {
    t: number;
    slot: string;
    targetId: number | undefined;
    off: number;
    targetAngle: number;
  }

  function fight(heroId: string, d: BotDifficulty): { presses: Press[]; maxStep: number; firstAim: number; frames: number } {
    const presses: Press[] = [];
    let prevYaw: number | undefined;
    let maxStep = 0;
    let frames = 0;
    const w = makeWorld(STD5, {
      heroes: ['caocao', 'guanyu', heroId, 'guanyu', 'guanyu'],
      humans: [0, 1, 3, 4],
      settings: { botDifficulty: d },
      botFactory: (seat, diff, seed) => {
        const b = new HeroBot(seat, diff, seed);
        return {
          think(sim, self, dt): InputFrame {
            const f = b.think(sim, self, dt);
            if (seat !== 2) return f;
            frames++;
            if (prevYaw !== undefined) maxStep = Math.max(maxStep, Math.abs(wrapAngle(f.yaw - prevYaw)));
            prevYaw = f.yaw;
            for (const a of f.actions) {
              if (a.a !== 'ability') continue;
              const t = f.aimTargetId !== undefined ? sim.get(f.aimTargetId) : undefined;
              const c = t ? aimPointOf(t) : undefined;
              const eye = sim.eyePos(self);
              presses.push({
                t: sim.time,
                slot: a.slot,
                targetId: f.aimTargetId,
                off: c ? crosshairOff(self.pos, f.yaw, f.pitch, c) : NaN,
                targetAngle: t && c ? Math.atan2(Math.max(t.radius, 0.6), Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z)) : 0,
              });
            }
            return f;
          },
        };
      },
    });
    const lord = hero(w, 0);
    lord.maxHp = 1e5;
    lord.hp = 1e5;
    place(w, lord, 0, 30);
    // the bot starts looking AWAY from the lord: every first cast needs a real turn
    place(w, hero(w, 2), 0, 46, Math.PI);
    [1, 3, 4].forEach((s, i) => place(w, hero(w, s), -50 + i * 6, -52));
    w.tick = 300 * 30;
    w.time = 300;
    let seq = 1;
    for (let t = 0; t < 30 * 14; t++) {
      // the lord strafes and keeps shooting the bot (a fight is on)
      const dir = Math.floor(t / 40) % 2 === 0 ? 1 : -1;
      w.setInput('p0', { ...emptyInput(seq++), moveX: dir * 0.8, yaw: 0, actions: [] });
      const me = hero(w, 2);
      if (t % 15 === 0 && !me.hero!.downed && me.hp > 80) w.dealDamage({ targetId: me.id, sourceId: lord.id, amount: 10, type: 'normal', weaponId: 'pistol' });
      w.step();
      w.drainEvents();
    }
    return { presses, maxStep, firstAim: presses.length ? presses[0].t - 300 : Infinity, frames };
  }

  it('no view snaps, and every lock-on press has the target inside the crosshair cone', () => {
    let aimedPresses = 0;
    for (const id of AIMED) {
      for (const d of ['easy', 'hard'] as const) {
        const r = fight(id, d);
        expect(r.frames).toBeGreaterThan(300);
        expect(r.maxStep, `${id} ${d} snapped its view`).toBeLessThanOrEqual(MAX_TURN[d] / 30 + 1e-6);
        for (const p of r.presses) {
          if (p.targetId === undefined) continue;
          aimedPresses++;
          expect(p.off, `${id} ${d} pressed ${p.slot} with the target ${(p.off / DEG).toFixed(1)}° off the crosshair`).toBeLessThanOrEqual(p.targetAngle * 1.6 + 4.5 * DEG);
        }
      }
    }
    process.stdout.write(`[ai] aimed lock-on presses: ${aimedPresses}\n`);
    expect(aimedPresses).toBeGreaterThan(5);
  }, 120_000);

  it('the first aimed cast waits for the turn and the reaction time (hard is quicker than easy)', () => {
    const first = (d: BotDifficulty): number => {
      let sum = 0;
      for (const id of AIMED) sum += Math.min(fight(id, d).firstAim, 14);
      return sum / AIMED.length;
    };
    const easy = first('easy');
    const hard = first('hard');
    process.stdout.write(`[ai] first aimed cast after ${easy.toFixed(2)} s (easy) / ${hard.toFixed(2)} s (hard)\n`);
    expect(hard).toBeGreaterThanOrEqual(difficultyProfile('hard').reaction);
    expect(easy).toBeGreaterThan(hard);
  }, 120_000);
});
