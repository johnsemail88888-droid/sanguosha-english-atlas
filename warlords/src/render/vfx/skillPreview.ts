// Skill targeting preview (MOBA style): while an aimed skill's key is held, the
// area it will cover is drawn on the ground — a range ring around you, the circle
// at the crosshair point, the dash corridor and its end sweep, the cone, the strip,
// or a ring under the unit the skill would pick (grey when there is none). A small
// ring marks each unit the area would catch; 反间 / 离间 draw a line to the hero the
// target will be turned on; a far point skill gets a pin standing at its landing spot.
// The plan also says why a release would do nothing (no target, too far …) for the
// hint by the crosshair (PreviewStatus). The same shape flashes briefly when the skill
// is cast (touch taps, quick key taps).
// Shapes come from data/skillInfo.ts skillArea(), i.e. from the ability's params.
// planSkillPreview() is pure (unit-tested); SkillPreview draws a plan with a few
// terrain-hugging meshes that are only rebuilt while shown.
import * as THREE from 'three';
import type { EntityId } from '../../core/types';
import type { AbilityDef } from '../../data/types';
import { skillArea, type DashStop, type SkillArea, type SkillLink } from '../../data/skillInfo';

export interface XZ {
  x: number;
  z: number;
}

/** A band of a circle / sector on the ground: radii rIn..rOut, `halfArc` rad either side of `yaw` (π = full). */
export interface PolarShape {
  x: number;
  z: number;
  rIn: number;
  rOut: number;
  yaw: number;
  halfArc: number;
}

/** A strip on the ground from `start` to `end` m along `yaw` from (x, z), `width` m either side. */
export interface StripShape {
  x: number;
  z: number;
  yaw: number;
  start: number;
  end: number;
  width: number;
}

export type PreviewTone = 'harm' | 'help' | 'self' | 'invalid';

/** Why releasing a held skill now would do nothing. */
export type PreviewReason = 'none' | 'far' | 'male' | 'alone';

/** What the hint by the crosshair says about a held skill (the plan minus its shapes). */
export interface PreviewStatus {
  /** false: releasing now finds nothing to act on (the key's release does not cast) */
  valid: boolean;
  reason?: PreviewReason;
  /** the unit a target skill picks — or, `reason: 'far'`, the one aimed at out of range */
  targetId?: EntityId;
  /** its distance (m) */
  dist?: number;
  /** a point skill aimed past its range: it lands this far out (m) */
  clamped?: number;
  /** units the area catches now (absent: the skill does not count them) */
  caught?: number;
  /** 反间 with nobody near its target: disarms it instead */
  fallback?: 'disarm';
  /** the hero 反间 / 离间 turns the target on */
  linkId?: EntityId;
}

export interface PreviewPlan extends PreviewStatus {
  tone: PreviewTone;
  /** thin ring at the skill's range around the caster */
  range: PolarShape | null;
  /** the area it covers */
  area: PolarShape | null;
  /** the path / strip */
  strip: StripShape | null;
  /** a ring under the picked unit or the landing point */
  marker: PolarShape | null;
  /** units the area would catch (a small ring under each) */
  caughtUnits: PreviewUnit[];
  /** a thin line from the target to the unit it is turned on (反间 / 离间) */
  link: StripShape | null;
  /** a pin standing at the landing point of a far / clamped point skill */
  pin: XZ | null;
}

/** What the plan needs to know about a unit under the crosshair. */
export interface PreviewUnit {
  id: EntityId;
  x: number;
  y: number;
  z: number;
  kind: string;
  /** your own hero, squad or summon */
  own: boolean;
  /** a hero's gender is male (结姻 picks a male hero only); absent: unknown / not a hero */
  male?: boolean;
  /** the hero a soldier / summon belongs to (离间 never turns a hero on its own squad) */
  owner?: EntityId;
  /** a downed hero (反间 / 离间 never turn anyone on one) */
  downed?: boolean;
}

export interface PreviewInput {
  def: AbilityDef;
  caster: { x: number; y: number; z: number };
  /** aim yaw (core/math convention: forward = (−sin yaw, −cos yaw)) */
  yaw: number;
  /** the crosshair point (renderer pick) */
  aimPoint: { x: number; y: number; z: number };
  /** the unit under the crosshair, if any */
  target: PreviewUnit | null;
  /** units near the caster (a charge that stops at the first enemy in its way ends there) */
  units?: readonly PreviewUnit[];
}

const UNIT_RADIUS = 0.45;

/**
 * Where a charge that stops at the first enemy in its way ends (sim: 青龙斩, 独目怒冲), and
 * the unit it stops at: the nearest non-own unit ahead within the stop width of the path.
 */
export function dashStop(caster: XZ, yaw: number, length: number, stop: DashStop, units: readonly PreviewUnit[]): { length: number; unit: PreviewUnit | null } {
  const f = fwd(yaw);
  let len = length;
  let unit: PreviewUnit | null = null;
  for (const u of units) {
    if (u.own || !UNIT_KINDS.has(u.kind) || (stop.heroesOnly && u.kind !== 'hero')) continue;
    const dx = u.x - caster.x;
    const dz = u.z - caster.z;
    const along = dx * f.x + dz * f.z;
    if (along <= UNIT_RADIUS || along > length + UNIT_RADIUS) continue;
    if (Math.abs(dx * -f.z + dz * f.x) > stop.width + UNIT_RADIUS) continue;
    const end = Math.max(0, along - UNIT_RADIUS - stop.gap);
    if (end < len) {
      len = end;
      unit = u;
    }
  }
  return { length: len, unit };
}

/** width of the range ring: thicker for long ranges (it is seen from far away, at a grazing angle) */
const rangeBand = (range: number): number => Math.min(0.7, Math.max(0.3, range * 0.014));
const UNIT_KINDS = new Set(['hero', 'troop', 'npc', 'turret']);

const fwd = (yaw: number): XZ => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

/** Tone of a skill's preview: red for harm, green for heals / ally help, gold for the rest. */
export function previewTone(def: AbilityDef): PreviewTone {
  if (def.aiHint === 'heal') return 'help';
  if (def.targeting === 'ally') return 'help';
  if (def.aiHint === 'offense' || def.dtype !== undefined || def.targeting === 'enemy') return 'harm';
  // an area that hinders whoever stands in it (八阵图, 咆哮, 威震 …)
  if (HARM_PARAMS.some((k) => (def.params[k] ?? 0) > 0)) return 'harm';
  return 'self';
}

const HARM_PARAMS = ['damage', 'stun', 'stunHero', 'silence', 'slow', 'disarm', 'knockback'];

/** The crosshair point clamped horizontally to `range` from the caster (sim World.aimPoint). */
export function clampToRange(caster: XZ, p: XZ, range: number): XZ {
  const dx = p.x - caster.x;
  const dz = p.z - caster.z;
  const d = Math.hypot(dx, dz);
  if (d <= range || d < 1e-6) return { x: p.x, z: p.z };
  return { x: caster.x + (dx / d) * range, z: caster.z + (dz / d) * range };
}

const full = (x: number, z: number, rIn: number, rOut: number): PolarShape => ({ x, z, rIn, rOut, yaw: 0, halfArc: Math.PI });
const rangeRing = (c: XZ, range: number): PolarShape => full(c.x, c.z, Math.max(0, range - rangeBand(range)), range);

type TargetArea = Extract<SkillArea, { kind: 'target' }>;

/** Distance from the caster's eye to a unit's chest (the sim's aimTarget measures range so). */
const reachOf = (caster: { x: number; y: number; z: number }, t: PreviewUnit): number => Math.hypot(t.x - caster.x, t.y + 1.1 - (caster.y + 1.6), t.z - caster.z);

/** Is `t` the kind of unit this targeted skill takes (range aside)? */
function takes(area: TargetArea, t: PreviewUnit): boolean {
  if (!UNIT_KINDS.has(t.kind)) return false;
  if (area.side === 'enemy') return !t.own;
  if (area.maleOnly) return t.kind === 'hero' && t.male !== false;
  return t.kind === 'hero' || (t.kind === 'troop' && t.own);
}

/**
 * Is `t` a unit this targeted skill can pick? Enemy skills take anything not on your
 * own side; ally skills take heroes and your own soldiers (hidden roles: any hero may be
 * a friend). Range: from the caster's eye to the unit's chest, like the sim's aimTarget.
 */
export function pickable(area: TargetArea, caster: { x: number; y: number; z: number }, t: PreviewUnit | null): boolean {
  return !!t && takes(area, t) && reachOf(caster, t) <= area.range + 0.6;
}

/** The sim's forgiving aim (World.aimTarget): a unit this close to the crosshair ray counts as aimed at. */
const STICKY_RAD = (5.5 * Math.PI) / 180;

/**
 * The unit a held target skill would pick, as the sim does: the unit under the crosshair
 * when it is the right kind, else the right kind of unit nearest the crosshair ray within a
 * few degrees (an own soldier in front of the enemy does not block it). `far`: the unit
 * aimed at is out of range; `wrong`: only the wrong kind of unit is under the crosshair.
 */
export function aimedUnit(area: TargetArea, inp: Pick<PreviewInput, 'caster' | 'aimPoint' | 'target' | 'units'>): { unit: PreviewUnit | null; far: boolean; wrong: boolean } {
  const c = inp.caster;
  const t = inp.target;
  if (t && takes(area, t)) return { unit: t, far: reachOf(c, t) > area.range + 0.6, wrong: false };
  const eye = { x: c.x, y: c.y + 1.6, z: c.z };
  const rx = inp.aimPoint.x - eye.x;
  const ry = inp.aimPoint.y - eye.y;
  const rz = inp.aimPoint.z - eye.z;
  const rl = Math.hypot(rx, ry, rz);
  let best: PreviewUnit | null = null;
  let bestA = STICKY_RAD;
  if (rl > 1e-3) {
    for (const u of inp.units ?? []) {
      if (!takes(area, u)) continue;
      const vx = u.x - eye.x;
      const vy = u.y + 1.1 - eye.y;
      const vz = u.z - eye.z;
      const vl = Math.hypot(vx, vy, vz) || 1;
      const a = Math.acos(Math.max(-1, Math.min(1, (vx * rx + vy * ry + vz * rz) / (vl * rl))));
      if (a < bestA) {
        bestA = a;
        best = u;
      }
    }
  }
  if (best) return { unit: best, far: reachOf(c, best) > area.range + 0.6, wrong: false };
  return { unit: null, far: false, wrong: !!t && UNIT_KINDS.has(t.kind) };
}

/**
 * The unit 反间 / 离间 turns `t` on: the nearest other hero within the link radius (never
 * you), else (离间) the nearest soldier / NPC / turret that is not `t`'s own.
 */
export function linkedUnit(link: SkillLink, t: PreviewUnit, units: readonly PreviewUnit[]): PreviewUnit | null {
  let best: PreviewUnit | null = null;
  let bestD = Infinity;
  const near = (u: PreviewUnit): number => Math.hypot(u.x - t.x, u.y - t.y, u.z - t.z);
  for (const u of units) {
    if (u.id === t.id || u.kind !== 'hero' || u.own || u.downed) continue;
    const d = near(u);
    if (d <= link.radius + UNIT_RADIUS && d < bestD) {
      bestD = d;
      best = u;
    }
  }
  if (best || link.fallback !== 'units') return best;
  for (const u of units) {
    if (u.id === t.id || u.kind === 'hero' || !UNIT_KINDS.has(u.kind) || u.owner === t.id) continue;
    // third-party units first, your own soldiers last (as the sim picks)
    const d = near(u) + (u.own ? 1e3 : 0);
    if (near(u) <= link.radius + UNIT_RADIUS && d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** Is (x, z) inside a polar shape (a unit's radius counts)? */
function inPolar(s: PolarShape, u: XZ): boolean {
  const dx = u.x - s.x;
  const dz = u.z - s.z;
  const d = Math.hypot(dx, dz);
  if (d > s.rOut + UNIT_RADIUS) return false;
  if (s.halfArc >= Math.PI - 1e-3 || d < UNIT_RADIUS) return true;
  const a = Math.atan2(-dx, -dz);
  let off = a - s.yaw;
  while (off > Math.PI) off -= 2 * Math.PI;
  while (off < -Math.PI) off += 2 * Math.PI;
  return Math.abs(off) <= s.halfArc + Math.asin(Math.min(1, UNIT_RADIUS / d));
}

/** Is (x, z) inside a strip (a unit's radius counts)? */
function inStrip(s: StripShape, u: XZ): boolean {
  const f = fwd(s.yaw);
  const dx = u.x - s.x;
  const dz = u.z - s.z;
  const along = dx * f.x + dz * f.z;
  return along >= s.start - UNIT_RADIUS && along <= s.end + UNIT_RADIUS && Math.abs(dx * -f.z + dz * f.x) <= s.width + UNIT_RADIUS;
}

/** at most this many "caught" rings are drawn */
export const MAX_CAUGHT = 12;
/** a point skill's circle this far out (m) gets a pin standing in it (a flat circle far ahead is a sliver) */
const PIN_FROM = 12;

/**
 * How far from the caster units matter to a held skill's preview (the units list the
 * renderer passes: charge stops, caught units, the target's partner), at most 80 m.
 */
export function previewReach(def: AbilityDef): number {
  const a = skillArea(def);
  let r = 0;
  switch (a?.kind) {
    case 'ring':
      r = a.radius;
      break;
    case 'circle':
      r = a.range + a.radius;
      break;
    case 'blinkPoint':
      r = a.range;
      break;
    case 'dash':
      r = a.length + (a.endRadius ?? 0) + a.width;
      break;
    case 'cone':
      r = a.range;
      break;
    case 'line':
      r = a.start + a.length + (a.endRadius ?? 0) + a.width;
      break;
    case 'target':
      // (a unit aimed at a little past the range is still found: the hint says "too far")
      r = a.range * 1.6 + Math.max(a.radius ?? 0, a.link?.radius ?? 0);
      break;
    default:
      break;
  }
  return Math.min(80, r + 2);
}

/** The shapes to draw for a held skill (null: the skill has nothing to show). */
export function planSkillPreview(inp: PreviewInput): PreviewPlan | null {
  const area = skillArea(inp.def);
  if (!area) return null;
  const c = inp.caster;
  const f = fwd(inp.yaw);
  const units = inp.units ?? [];
  const plan: PreviewPlan = { tone: previewTone(inp.def), range: null, area: null, strip: null, marker: null, valid: true, caughtUnits: [], link: null, pin: null };
  /** the strip hurts what stands in it (a plain dash / a blink path does not) */
  let countStrip = true;
  /** projectiles stop at what they hit (or burst there): counting what stands in their path would lie */
  let countable = true;
  switch (area.kind) {
    case 'ring':
      plan.area = full(c.x, c.z, 0, area.radius);
      break;
    case 'circle':
    case 'blinkPoint': {
      const p = clampToRange(c, inp.aimPoint, area.range);
      const raw = Math.hypot(inp.aimPoint.x - c.x, inp.aimPoint.z - c.z);
      if (raw > area.range + 0.5) plan.clamped = area.range;
      plan.range = rangeRing(c, area.range);
      if (area.kind === 'circle') plan.area = full(p.x, p.z, 0, Math.max(0.6, area.radius));
      else {
        const len = Math.hypot(p.x - c.x, p.z - c.z);
        plan.strip = { x: c.x, z: c.z, yaw: Math.atan2(-(p.x - c.x), -(p.z - c.z)), start: 0.6, end: Math.max(0.6, len - 0.9), width: 0.25 };
        plan.marker = full(p.x, p.z, 0.55, 0.95);
        countStrip = false;
      }
      if (plan.clamped !== undefined || Math.hypot(p.x - c.x, p.z - c.z) >= PIN_FROM) plan.pin = { x: p.x, z: p.z };
      break;
    }
    case 'dash': {
      const stop = area.stop && inp.units ? dashStop(c, inp.yaw, area.length, area.stop, inp.units) : { length: area.length, unit: null };
      const len = stop.length;
      const end = { x: c.x + f.x * len, z: c.z + f.z * len };
      plan.strip = { x: c.x, z: c.z, yaw: inp.yaw, start: Math.min(0.6, len), end: len, width: area.width > 0 ? area.width : 0.3 };
      // (a plain dash harms nobody on its way)
      countStrip = area.width > 0;
      // the unit the charge runs into
      if (stop.unit) plan.marker = full(stop.unit.x, stop.unit.z, 0.7, 1.15);
      if (area.endRadius) {
        const arc = area.endArc ?? 360;
        plan.area = { x: end.x, z: end.z, rIn: 0, rOut: area.endRadius, yaw: inp.yaw, halfArc: arc >= 360 ? Math.PI : (arc * Math.PI) / 360 };
      } else if (!plan.marker) plan.marker = full(end.x, end.z, 0.55, 0.95);
      break;
    }
    case 'cone':
      plan.area = { x: c.x, z: c.z, rIn: 0.8, rOut: area.range, yaw: inp.yaw, halfArc: (area.arc * Math.PI) / 360 };
      break;
    case 'line': {
      plan.strip = { x: c.x, z: c.z, yaw: inp.yaw, start: area.start, end: area.start + area.length, width: area.width };
      countable = area.reach === undefined;
      if (area.endRadius) {
        const d = area.start + area.length;
        plan.area = full(c.x + f.x * d, c.z + f.z * d, 0, area.endRadius);
      }
      break;
    }
    case 'target': {
      plan.range = rangeRing(c, area.range);
      const aimed = aimedUnit(area, { caster: c, aimPoint: inp.aimPoint, target: inp.target, units });
      const t = aimed.unit;
      if (t) {
        plan.targetId = t.id;
        plan.dist = reachOf(c, t);
      }
      if (t && !aimed.far) {
        plan.marker = full(t.x, t.z, 0.7, 1.15);
        if (area.radius) plan.area = full(t.x, t.z, 0, area.radius);
        if (area.link) {
          const other = linkedUnit(area.link, t, units);
          if (other) {
            plan.linkId = other.id;
            const len = Math.hypot(other.x - t.x, other.z - t.z);
            plan.link = { x: t.x, z: t.z, yaw: Math.atan2(-(other.x - t.x), -(other.z - t.z)), start: 1.15, end: Math.max(1.15, len - 0.9), width: 0.14 };
          } else if (area.link.fallback === 'disarm') plan.fallback = 'disarm';
          else {
            plan.valid = false;
            plan.reason = 'alone';
            plan.tone = 'invalid';
          }
        }
      } else if (area.selfFallback) {
        // nobody (in range) aimed at: the skill works without a target (青囊 on yourself, 宁教's free charge)
        plan.marker = full(c.x, c.z, 0.7, 1.15);
        if (aimed.far) plan.reason = 'far';
      } else {
        plan.valid = false;
        plan.tone = 'invalid';
        plan.reason = aimed.far ? 'far' : aimed.wrong && area.maleOnly ? 'male' : 'none';
        // (the far unit gets a grey ring: that is the one out of range)
        if (t) plan.marker = full(t.x, t.z, 0.7, 1.15);
      }
      break;
    }
  }
  // who the area catches (harm: anyone not yours; heals: heroes and your own units)
  if (countable && plan.valid && plan.tone !== 'self' && plan.tone !== 'invalid' && area.kind !== 'blinkPoint') {
    const harm = plan.tone === 'harm';
    for (const u of units) {
      if (plan.caughtUnits.length >= MAX_CAUGHT) break;
      if (!UNIT_KINDS.has(u.kind) || (harm ? u.own : !(u.own || u.kind === 'hero'))) continue;
      const inside = (plan.area !== null && inPolar(plan.area, u)) || (countStrip && plan.strip !== null && inStrip(plan.strip, u));
      if (inside) plan.caughtUnits.push(u);
    }
    // a target skill without a secondary area catches its target only (the marker says so);
    // 离间's radius is where its partner is searched, not an area it hits
    if (area.kind !== 'target' || (area.radius && !area.link)) plan.caught = plan.caughtUnits.length;
    else plan.caughtUnits = [];
  }
  return plan;
}

/** The plan's status for the hint by the crosshair. */
export function previewStatus(plan: PreviewPlan | null): PreviewStatus {
  if (!plan) return { valid: true };
  const { valid, reason, targetId, dist, clamped, caught, fallback, linkId } = plan;
  const out: PreviewStatus = { valid };
  if (reason !== undefined) out.reason = reason;
  if (targetId !== undefined) out.targetId = targetId;
  if (dist !== undefined) out.dist = dist;
  if (clamped !== undefined) out.clamped = clamped;
  if (caught !== undefined) out.caught = caught;
  if (fallback !== undefined) out.fallback = fallback;
  if (linkId !== undefined) out.linkId = linkId;
  return out;
}

// ── drawing ─────────────────────────────────────────────────────────────────

// Drawn twice: depth-tested and pulled uBias m towards the camera (it lies on the terrain it
// hugs but units standing in it — your own hero in third person — stay in front of it), and a
// faint copy that ignores depth (the parts a raised floor or a wall hides still show).
const VERT = /* glsl */ `
attribute float aEdge;
attribute float aAlong;
uniform float uBias;
varying float vEdge;
varying float vAlong;
void main() {
  vEdge = aEdge;
  vAlong = aAlong;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = length(mv.xyz);
  mv.xyz *= max(0.0, d - uBias) / max(d, 1e-4);
  gl_Position = projectionMatrix * mv;
}`;
/** metres the depth-tested pass is pulled towards the camera */
const DEPTH_BIAS = 0.35;
/** alpha of the pass that ignores depth (seen through what hides the area) */
const GHOST_ALPHA = 0.22;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFill;
uniform float uEdgeW;
uniform float uTime;
uniform float uFlow;
varying float vEdge;
varying float vAlong;
void main() {
  float edge = 1.0 - smoothstep(0.0, uEdgeW, vEdge);
  // bands running outward / forward: which way the skill goes
  float flow = uFlow > 0.0 ? smoothstep(0.55, 1.0, 0.5 + 0.5 * sin(vAlong * 1.3 - uTime * 7.0)) : 0.0;
  float a = uAlpha * (uFill + 0.22 * flow + 0.85 * edge);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, min(a, 1.0));
}`;

// (saturated: the picture is tone-mapped and bloomed after this, which washes colours out)
const TONES: Record<PreviewTone, THREE.Color> = {
  harm: new THREE.Color(1.0, 0.16, 0.06),
  help: new THREE.Color(0.12, 0.95, 0.3),
  self: new THREE.Color(1.0, 0.72, 0.1),
  invalid: new THREE.Color(0.55, 0.55, 0.55),
};
const RANGE_COLOR = new THREE.Color(1.0, 0.9, 0.6);
const LIFT = 0.08;
const BIG = 1e3;

function makeMaterial(fill: number, edgeW: number, flow: number, depthTest = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(1, 1, 1) },
      uAlpha: { value: 1 },
      uFill: { value: fill },
      uEdgeW: { value: edgeW },
      uTime: { value: 0 },
      uFlow: { value: flow },
      uBias: { value: depthTest ? DEPTH_BIAS : 0 },
    },
    transparent: true,
    depthTest,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A grid mesh whose vertices are rewritten each shown frame (positions + edge distance + distance along). */
class GroundMesh {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  /** the faint copy drawn over whatever hides the area (a child of `mesh`: shown with it) */
  readonly ghost: THREE.Mesh;
  readonly ghostMat: THREE.ShaderMaterial;
  private readonly pos: THREE.BufferAttribute;
  private readonly edge: THREE.BufferAttribute;
  private readonly along: THREE.BufferAttribute;

  constructor(
    readonly cols: number,
    readonly rows: number,
    mat: THREE.ShaderMaterial,
    order: number,
  ) {
    const n = (cols + 1) * (rows + 1);
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.edge = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.along = new THREE.BufferAttribute(new Float32Array(n), 1);
    for (const a of [this.pos, this.edge, this.along]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aEdge', this.edge);
    g.setAttribute('aAlong', this.along);
    const idx: number[] = [];
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BIG);
    this.mat = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    this.ghostMat = makeMaterial(mat.uniforms.uFill.value as number, mat.uniforms.uEdgeW.value as number, mat.uniforms.uFlow.value as number, false);
    this.ghost = new THREE.Mesh(g, this.ghostMat);
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = order - 10;
    this.mesh.add(this.ghost);
  }

  /** Colour / alpha / time / rim width for both passes. */
  style(color: THREE.Color, alpha: number, time: number, edgeW?: number): void {
    for (const [m, a] of [[this.mat, alpha], [this.ghostMat, alpha * GHOST_ALPHA]] as const) {
      const u = m.uniforms;
      (u.uColor.value as THREE.Color).copy(color);
      u.uAlpha.value = a;
      u.uTime.value = time;
      if (edgeW !== undefined) u.uEdgeW.value = edgeW;
    }
  }

  set(k: number, x: number, y: number, z: number, edge: number, along: number): void {
    this.pos.setXYZ(k, x, y, z);
    this.edge.setX(k, edge);
    this.along.setX(k, along);
  }

  commit(): void {
    this.pos.needsUpdate = true;
    this.edge.needsUpdate = true;
    this.along.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.ghostMat.dispose();
  }
}

function drawPolar(m: GroundMesh, s: PolarShape, groundY: (x: number, z: number) => number): void {
  const cols = m.cols;
  const rows = m.rows;
  const fullCircle = s.halfArc >= Math.PI - 1e-3;
  for (let j = 0; j <= rows; j++) {
    const r = s.rIn + ((s.rOut - s.rIn) * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const off = -s.halfArc + 2 * s.halfArc * u;
      const a = s.yaw + off;
      const x = s.x - Math.sin(a) * r;
      const z = s.z - Math.cos(a) * r;
      let edge = s.rOut - r;
      if (s.rIn > 0) edge = Math.min(edge, r - s.rIn);
      if (!fullCircle) edge = Math.min(edge, r * Math.sin(Math.min(Math.PI / 2, Math.min(off + s.halfArc, s.halfArc - off))));
      m.set(j * (cols + 1) + i, x, groundY(x, z) + LIFT, z, Math.max(0, edge), r);
    }
  }
  m.commit();
}

function drawStrip(m: GroundMesh, s: StripShape, groundY: (x: number, z: number) => number): void {
  const cols = m.cols; // across
  const rows = m.rows; // along
  const f = fwd(s.yaw);
  const rx = -f.z; // right of forward
  const rz = f.x;
  for (let j = 0; j <= rows; j++) {
    const d = s.start + ((s.end - s.start) * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const w = -s.width + (2 * s.width * i) / cols;
      const x = s.x + f.x * d + rx * w;
      const z = s.z + f.z * d + rz * w;
      const edge = Math.min(s.width - Math.abs(w), d - s.start, s.end - d);
      m.set(j * (cols + 1) + i, x, groundY(x, z) + LIFT, z, Math.max(0, edge), d);
    }
  }
  m.commit();
}

export interface SkillPreviewFrame {
  /** the held skill (null: none held) */
  def: AbilityDef | null;
  caster: { x: number; y: number; z: number } | null;
  yaw: number;
  aimPoint: { x: number; y: number; z: number } | null;
  target: PreviewUnit | null;
  units?: readonly PreviewUnit[];
}

/** Seconds a cast's area stays up after the skill is released / tapped. */
export const CAST_FLASH_SECONDS = 0.5;

/** A pin standing at a far landing point: a thin beam fading upward (seen over the horizon in first person). */
const PIN_VERT = /* glsl */ `
varying float vH;
void main() {
  vH = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const PIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vH;
void main() {
  gl_FragColor = vec4(uColor, uAlpha * (1.0 - vH) * (0.55 + 0.45 * smoothstep(0.0, 0.08, vH)));
}`;
const PIN_HEIGHT = 7;
/** amber: the point skill is aimed past its range and lands on the range ring */
const CLAMPED_COLOR = new THREE.Color(1.0, 0.62, 0.08);

export class SkillPreview {
  readonly group = new THREE.Group();
  private readonly rangeM: GroundMesh;
  private readonly areaM: GroundMesh;
  private readonly stripM: GroundMesh;
  private readonly markerM: GroundMesh;
  /** a small ring under each unit the area would catch */
  private readonly caughtM: GroundMesh[] = [];
  /** 反间 / 离间: the line to the hero the target is turned on */
  private readonly linkM: GroundMesh;
  private readonly pin: THREE.Mesh;
  private readonly pinMat: THREE.ShaderMaterial;
  private time = 0;
  /** last shown plan (the cast flash replays it), whose skill it was and when it was last shown */
  private last: PreviewPlan | null = null;
  private lastId = '';
  private lastAt = -1;
  private flashUntil = 0;
  /** what releasing now would do (the hint by the crosshair); valid when nothing is held */
  status: PreviewStatus = { valid: true };
  groundY: (x: number, z: number) => number = () => 0;

  constructor() {
    this.group.name = 'skillPreview';
    this.rangeM = new GroundMesh(128, 1, makeMaterial(0.35, 0.3, 0), 41);
    this.areaM = new GroundMesh(72, 6, makeMaterial(0.17, 0.5, 1), 42);
    this.stripM = new GroundMesh(4, 40, makeMaterial(0.2, 0.4, 1), 42);
    this.markerM = new GroundMesh(48, 1, makeMaterial(0.9, 0.2, 0), 43);
    this.linkM = new GroundMesh(2, 24, makeMaterial(0.75, 0.05, 1), 43);
    for (let i = 0; i < MAX_CAUGHT; i++) this.caughtM.push(new GroundMesh(24, 1, makeMaterial(0.95, 0.1, 0), 44));
    this.pinMat = new THREE.ShaderMaterial({
      vertexShader: PIN_VERT,
      fragmentShader: PIN_FRAG,
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const g = new THREE.CylinderGeometry(0.1, 0.16, PIN_HEIGHT, 8, 1, true);
    g.translate(0, PIN_HEIGHT / 2, 0);
    this.pin = new THREE.Mesh(g, this.pinMat);
    this.pin.renderOrder = 45;
    this.pin.frustumCulled = false;
    this.pin.visible = false;
    for (const m of this.meshes()) this.group.add(m.mesh);
    this.group.add(this.pin);
  }

  private meshes(): GroundMesh[] {
    return [this.rangeM, this.areaM, this.stripM, this.markerM, this.linkM, ...this.caughtM];
  }

  /** releasing now would act (a target is in range); true when nothing is held */
  get valid(): boolean {
    return this.status.valid;
  }

  /**
   * The local hero cast `def`: its area stays up briefly, fading — the preview as it was on
   * release, or (a touch tap / a skill that never previewed) planned now from `now()`.
   */
  castOf(def: AbilityDef, now: () => PreviewInput): void {
    let plan = this.lastId === def.id && this.time - this.lastAt < 1 ? this.last : null;
    if (!plan) plan = planSkillPreview(now());
    if (!plan || !plan.valid) return;
    this.last = plan;
    this.lastId = def.id;
    this.flashUntil = this.time + CAST_FLASH_SECONDS;
  }

  update(dt: number, f: SkillPreviewFrame): void {
    this.time += dt;
    let plan: PreviewPlan | null = null;
    let alpha = 1;
    if (f.def && f.caster && f.aimPoint) {
      plan = planSkillPreview({ def: f.def, caster: f.caster, yaw: f.yaw, aimPoint: f.aimPoint, target: f.target, units: f.units });
      this.last = plan;
      this.lastId = f.def.id;
      this.lastAt = this.time;
      this.flashUntil = 0;
      this.status = previewStatus(plan);
    } else {
      this.status = { valid: true };
      if (this.last && this.time < this.flashUntil) {
        plan = this.last;
        alpha = Math.max(0, (this.flashUntil - this.time) / CAST_FLASH_SECONDS);
      }
    }
    const show = (m: GroundMesh, shape: PolarShape | StripShape | null, color: THREE.Color, a: number, strip = false): void => {
      if (!shape) {
        m.mesh.visible = false;
        return;
      }
      if (strip) drawStrip(m, shape as StripShape, this.groundY);
      else drawPolar(m, shape as PolarShape, this.groundY);
      // a crisp rim that stays visible on big areas seen at a grazing angle
      const edgeW = m === this.areaM ? Math.min(0.9, Math.max(0.35, (shape as PolarShape).rOut * 0.08)) : undefined;
      m.style(color, a, this.time, edgeW);
      m.mesh.visible = a > 0.01;
    };
    if (!plan) {
      for (const m of this.meshes()) m.mesh.visible = false;
      this.pin.visible = false;
      return;
    }
    const tone = TONES[plan.tone];
    const flashing = alpha < 1 || !f.def;
    show(this.rangeM, flashing ? null : plan.range, plan.valid ? RANGE_COLOR : TONES.invalid, 0.7 * alpha);
    show(this.areaM, plan.area, tone, alpha);
    show(this.stripM, plan.strip, tone, alpha, true);
    show(this.markerM, plan.marker, tone, 0.9 * alpha);
    show(this.linkM, flashing ? null : plan.link, tone, 0.9 * alpha, true);
    for (let i = 0; i < this.caughtM.length; i++) {
      const u = flashing ? undefined : plan.caughtUnits[i];
      show(this.caughtM[i], u ? full(u.x, u.z, 0.5, 0.8) : null, tone, alpha);
    }
    // the pin: amber when the aim is past the range (the area lands on the range ring)
    const pin = flashing ? null : plan.pin;
    this.pin.visible = !!pin;
    if (pin) {
      this.pin.position.set(pin.x, this.groundY(pin.x, pin.z), pin.z);
      (this.pinMat.uniforms.uColor.value as THREE.Color).copy(plan.clamped !== undefined ? CLAMPED_COLOR : tone);
      this.pinMat.uniforms.uAlpha.value = 0.85;
    }
  }

  /** Hide everything (spectating, dead). */
  clear(): void {
    this.last = null;
    this.lastId = '';
    this.flashUntil = 0;
    this.status = { valid: true };
    for (const m of this.meshes()) m.mesh.visible = false;
    this.pin.visible = false;
  }

  dispose(): void {
    for (const m of this.meshes()) m.dispose();
    this.pin.geometry.dispose();
    this.pinMat.dispose();
  }
}
