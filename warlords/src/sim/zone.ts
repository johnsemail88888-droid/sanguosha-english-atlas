// 烽火圈 shrinking zone (GAME_SPEC §4 table). Each phase: wait (circle static),
// then shrink linearly (center and radius) to the next circle. The next center
// is random inside the current circle (new circle fully contained), biased
// towards the map center. At the 15:00 hard cap the zone collapses to 0 and
// its damage keeps escalating.
import type { Vec3 } from '../core/math';
import type { Rng } from '../core/rng';
import type { ZoneView } from '../core/types';

export interface ZonePhaseDef {
  wait: number;
  shrink: number;
  radius: number;
  dps: number;
}

/**
 * Paced for 8–12 minute matches: the first circle closes at 2:30, the last one reaches 0 at
 * 10:40 (the 15:00 hard cap in rules.ts stays the backstop).
 */
export const ZONE_PHASES: readonly ZonePhaseDef[] = [
  { wait: 150, shrink: 0, radius: 230, dps: 0 },
  { wait: 0, shrink: 75, radius: 160, dps: 4 },
  { wait: 75, shrink: 60, radius: 100, dps: 8 },
  { wait: 60, shrink: 45, radius: 55, dps: 15 },
  { wait: 45, shrink: 40, radius: 25, dps: 30 },
  { wait: 45, shrink: 45, radius: 0, dps: 60 },
];

/** Start (s) of phase `i` (its wait), from the table. */
export function zonePhaseStart(i: number): number {
  let t = 0;
  for (let k = 0; k < Math.min(i, ZONE_PHASES.length); k++) t += ZONE_PHASES[k].wait + ZONE_PHASES[k].shrink;
  return t;
}

/** Time (s) the circle reaches radius 0 (end of the last shrink). */
export const ZONE_CLOSED_AT = zonePhaseStart(ZONE_PHASES.length);

/** zone damage tick period (s) */
export const ZONE_DAMAGE_PERIOD = 1;
const CAP_COLLAPSE_TIME = 10;
const CAP_DPS_GROWTH = 2; // extra dps per second after the hard cap
const CENTER_BIAS = 0.35;
const MAX_CENTER_DIST = 120;

export interface ZoneChange {
  phase: number;
  center: Vec3;
  radius: number;
  targetRadius: number;
  shrinkStart: number;
  shrinkEnd: number;
}

export class Zone {
  phase = 0;
  center: Vec3 = { x: 0, y: 0, z: 0 };
  radius: number;
  fromCenter: Vec3 = { x: 0, y: 0, z: 0 };
  fromRadius: number;
  targetCenter: Vec3 = { x: 0, y: 0, z: 0 };
  targetRadius: number;
  phaseStart = 0;
  shrinkStart: number;
  shrinkEnd: number;
  dps = 0;
  capped = false;
  capStart = 0;
  nextDamageAt = ZONE_DAMAGE_PERIOD;
  private readonly rng: Rng;

  constructor(rng: Rng, private readonly hardCap: number) {
    this.rng = rng;
    const p0 = ZONE_PHASES[0];
    this.radius = p0.radius;
    this.fromRadius = p0.radius;
    this.targetRadius = p0.radius;
    this.shrinkStart = p0.wait;
    this.shrinkEnd = p0.wait + p0.shrink;
    this.dps = p0.dps;
  }

  /** Advance to `time`. Returns the phase change (for events) if one happened. */
  update(time: number): ZoneChange | null {
    let change: ZoneChange | null = null;
    if (!this.capped && time >= this.hardCap) {
      this.capped = true;
      this.capStart = time;
      this.fromCenter = { ...this.center };
      this.fromRadius = this.radius;
      this.targetCenter = { ...this.center };
      this.targetRadius = 0;
      this.shrinkStart = time;
      this.shrinkEnd = time + CAP_COLLAPSE_TIME;
      this.phase = ZONE_PHASES.length;
      this.dps = ZONE_PHASES[ZONE_PHASES.length - 1].dps;
      change = this.change();
    }
    if (!this.capped) {
      while (this.phase < ZONE_PHASES.length - 1 && time >= this.shrinkEnd) {
        this.startPhase(this.phase + 1, this.shrinkEnd);
        change = this.change();
      }
    } else {
      this.dps = ZONE_PHASES[ZONE_PHASES.length - 1].dps + Math.max(0, time - this.capStart) * CAP_DPS_GROWTH;
    }
    // interpolate
    if (time <= this.shrinkStart || this.shrinkEnd <= this.shrinkStart) {
      if (time >= this.shrinkEnd) {
        this.center = { ...this.targetCenter };
        this.radius = this.targetRadius;
      } else {
        this.center = { ...this.fromCenter };
        this.radius = this.fromRadius;
      }
    } else if (time >= this.shrinkEnd) {
      this.center = { ...this.targetCenter };
      this.radius = this.targetRadius;
    } else {
      const t = (time - this.shrinkStart) / (this.shrinkEnd - this.shrinkStart);
      this.center = {
        x: this.fromCenter.x + (this.targetCenter.x - this.fromCenter.x) * t,
        y: 0,
        z: this.fromCenter.z + (this.targetCenter.z - this.fromCenter.z) * t,
      };
      this.radius = this.fromRadius + (this.targetRadius - this.fromRadius) * t;
    }
    return change;
  }

  private startPhase(index: number, at: number): void {
    const def = ZONE_PHASES[index];
    this.phase = index;
    this.phaseStart = at;
    this.fromCenter = { ...this.targetCenter };
    this.fromRadius = this.targetRadius;
    this.targetRadius = def.radius;
    this.targetCenter = this.pickCenter(this.fromCenter, this.fromRadius, def.radius);
    this.shrinkStart = at + def.wait;
    this.shrinkEnd = at + def.wait + def.shrink;
    this.dps = def.dps;
  }

  /** Random center with the new circle fully inside the old one, biased toward the origin. */
  pickCenter(c: Vec3, R: number, r: number): Vec3 {
    const slack = Math.max(0, R - r);
    const a = this.rng.next() * Math.PI * 2;
    const d = slack * Math.sqrt(this.rng.next());
    let x = c.x + Math.cos(a) * d;
    let z = c.z + Math.sin(a) * d;
    // bias toward the map center, staying inside the allowed disk (convex)
    const ox = c.x;
    const oz = c.z;
    const toO = Math.hypot(ox, oz);
    let px = 0;
    let pz = 0;
    if (toO > slack) {
      px = ox - (ox / toO) * slack;
      pz = oz - (oz / toO) * slack;
    }
    x += (px - x) * CENTER_BIAS;
    z += (pz - z) * CENTER_BIAS;
    const dist = Math.hypot(x, z);
    if (dist > MAX_CENTER_DIST) {
      // pull back toward the origin while staying inside the allowed disk
      const k = MAX_CENTER_DIST / dist;
      const nx = x * k;
      const nz = z * k;
      if (Math.hypot(nx - c.x, nz - c.z) <= slack) {
        x = nx;
        z = nz;
      }
    }
    return { x, y: 0, z };
  }

  private change(): ZoneChange {
    return {
      phase: this.phase,
      center: { ...this.fromCenter },
      radius: this.fromRadius,
      targetRadius: this.targetRadius,
      shrinkStart: this.shrinkStart,
      shrinkEnd: this.shrinkEnd,
    };
  }

  isOutside(pos: Vec3): boolean {
    return Math.hypot(pos.x - this.center.x, pos.z - this.center.z) > this.radius;
  }

  view(): ZoneView {
    return {
      phase: this.phase,
      center: { ...this.center },
      radius: this.radius,
      targetCenter: { ...this.targetCenter },
      targetRadius: this.targetRadius,
      shrinkStart: this.shrinkStart,
      shrinkEnd: this.shrinkEnd,
      dps: this.dps,
    };
  }
}
