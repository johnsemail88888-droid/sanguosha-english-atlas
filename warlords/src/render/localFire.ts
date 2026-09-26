// Local fire prediction: decides, every rendered frame, how many shots the
// host is about to fire for the local hero so muzzle flash / tracer / gunshot
// audio play instantly instead of one round trip later. Mirrors the sim's
// heroFire (sim/combat.ts) gating and pacing:
//   - no shot while dead / downed / stunned / disarmed / dancing / reloading
//   - semi-auto weapons fire once per press, autos at fireRate (zhuge-style
//     'rapid' ramp included); an unknown extra multiplier (fireRateUp status,
//     passive modifiers) is inferred from the cadence of the host's own shots
//   - the magazine gate uses host mag minus predictions not yet confirmed by a
//     host 'shot' event, and is skipped under noReload / infinite ammo
// Every host 'shot' of the local hero is offered to confirmHostShot(): when it
// matches an outstanding prediction for the same weapon the renderer skips its
// visuals (no double muzzle flash); shots from other sources (abilities,
// chain effects) never consume predictions. Pure TS (unit-tested in node).
import type { WeaponDef } from '../data/types';

/** Unconfirmed predictions older than this are dropped (host never fired them). */
export const PREDICTION_TTL = 0.7;
/** Same cap as the sim (MAX_SHOTS_PER_TICK) per rendered frame. */
const MAX_SHOTS_PER_FRAME = 4;
/** Sim BURST_RESET: a pause longer than this restarts the rapid-fire ramp. */
const RAMP_RESET = 0.35;
/** Window (s) over which the host's own cadence is measured. */
const CADENCE_WINDOW = 1.2;

export interface LocalFireGate {
  /** false while dead / downed / stunned / disarmed / dancing */
  canShoot: boolean;
  /** host reload in progress */
  reloading: boolean;
  /** 'noReload' status (咆哮, 连营, 奇才…): firing does not consume the magazine */
  noReload: boolean;
}

export interface LocalWeapon {
  id: string;
  slot: number;
  /** host-authoritative rounds in the magazine */
  mag: number;
}

type FireDef = Pick<WeaponDef, 'auto' | 'fireRate' | 'magSize' | 'special' | 'specialParams'> & { melee?: unknown };

interface Pending {
  t: number;
  weapon: string;
}

export class LocalFirePredictor {
  private prevHeld = false;
  private nextAt = 0;
  private lastShotAt = -Infinity;
  private rampStart = 0;
  private readonly pending: Pending[] = [];
  /** receive times of host shots of the active weapon (cadence estimate) */
  private readonly hostTimes: number[] = [];
  private activeWeapon = '';
  /** inferred host / predicted fire-rate ratio (1 = matches the data) */
  private rateMul = 1;
  /** host shots confirmed with no magazine change: the hero has infinite ammo */
  private freeShots = 0;
  private lastMag = -1;

  /** Outstanding (unconfirmed) predictions for a weapon. */
  outstanding(weaponId: string): number {
    let n = 0;
    for (const p of this.pending) if (p.weapon === weaponId) n++;
    return n;
  }

  /** Current inferred fire-rate multiplier (exposed for tests / debug). */
  get inferredRateMul(): number {
    return this.rateMul;
  }

  /**
   * Advance one rendered frame. Returns the number of shots to draw locally
   * (0 when nothing fires). `def` undefined = unknown weapon (nothing predicted).
   */
  update(time: number, dt: number, held: boolean, weapon: LocalWeapon | null, def: FireDef | undefined, gate: LocalFireGate): number {
    const pressed = held && !this.prevHeld;
    this.prevHeld = held;
    this.expire(time);
    if (!weapon || !def) return 0;
    if (weapon.id !== this.activeWeapon) {
      this.activeWeapon = weapon.id;
      this.hostTimes.length = 0;
      this.rateMul = 1;
      this.freeShots = 0;
      this.lastMag = weapon.mag;
    }
    if (weapon.mag !== this.lastMag) {
      this.lastMag = weapon.mag;
      this.freeShots = 0;
    }
    if (!held || !gate.canShoot || gate.reloading) return 0;
    if (!def.auto && !pressed) return 0;
    const ammo = !def.melee && def.magSize > 0;
    const infinite = gate.noReload || this.freeShots >= 3;
    // resync pacing after an idle period (sim: nextFireAt < time - SIM_DT → time)
    if (this.nextAt < time - Math.max(dt, 1 / 60)) this.nextAt = time;
    let shots = 0;
    while (time + 1e-9 >= this.nextAt && shots < MAX_SHOTS_PER_FRAME) {
      if (ammo && !infinite && weapon.mag - this.outstanding(weapon.id) <= 0) break;
      if (time - this.lastShotAt > (def.specialParams.resetAfter ?? RAMP_RESET)) this.rampStart = time;
      this.lastShotAt = time;
      this.pending.push({ t: time, weapon: weapon.id });
      if (this.pending.length > 64) this.pending.shift();
      shots++;
      this.nextAt += 1 / this.rate(def, time);
      if (!def.auto) break;
    }
    return shots;
  }

  /**
   * A host 'shot' event of the local hero arrived. Returns true when it
   * confirms (and consumes) a local prediction for the same weapon — the
   * caller then skips its visuals.
   */
  confirmHostShot(time: number, weaponId: string): boolean {
    this.expire(time);
    if (weaponId !== this.activeWeapon) return false;
    const h = this.hostTimes;
    h.push(time);
    while (h.length > 32 || (h.length && time - h[0] > CADENCE_WINDOW)) h.shift();
    const i = this.pending.findIndex((p) => p.weapon === weaponId);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    if (this.lastMag >= 0) this.freeShots++;
    return true;
  }

  /** Forget everything (respawn, spectator handover). */
  reset(): void {
    this.prevHeld = false;
    this.nextAt = 0;
    this.lastShotAt = -Infinity;
    this.pending.length = 0;
    this.hostTimes.length = 0;
    this.activeWeapon = '';
    this.rateMul = 1;
    this.freeShots = 0;
    this.lastMag = -1;
  }

  private expire(time: number): void {
    const p = this.pending;
    while (p.length && time - p[0].t > PREDICTION_TTL) p.shift();
  }

  /** Predicted fire rate: data rate × rapid ramp × inferred host multiplier. */
  private rate(def: FireDef, time: number): number {
    let base = Math.max(0.05, def.fireRate);
    let steady = true;
    if (def.special === 'rapid') {
      const rampTime = Math.max(0.05, def.specialParams.rampTime ?? 1.5);
      const mul = def.specialParams.rampMul ?? 1.5;
      base *= 1 + (mul - 1) * Math.min(1, (time - this.rampStart) / rampTime);
      // the cadence window must not straddle the ramp, or it reads as a slowdown
      steady = time - this.rampStart > rampTime + CADENCE_WINDOW;
    }
    const h = this.hostTimes;
    if (def.auto && steady && h.length >= 5) {
      const span = h[h.length - 1] - h[0];
      if (span >= 0.3) {
        const observed = (h.length - 1) / span;
        const ratio = Math.min(3, Math.max(0.5, observed / base));
        // ignore jitter; adopt clear differences (fireRateUp, passives, slows)
        if (Math.abs(ratio - 1) > 0.12) this.rateMul += (ratio - this.rateMul) * 0.5;
        else this.rateMul += (1 - this.rateMul) * 0.5;
      }
    }
    return Math.max(0.05, base * this.rateMul);
  }
}
