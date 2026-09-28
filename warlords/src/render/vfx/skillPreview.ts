// Skill targeting preview (MOBA style): while an aimed skill's key is held, the
// area it will cover is drawn on the ground — a range ring around you, the circle
// at the crosshair point, the dash corridor and its end sweep, the cone, the strip,
// or a ring under the unit the skill would pick (grey when there is none). The same
// shape flashes briefly when the skill is cast (touch taps, quick key taps).
// Shapes come from data/skillInfo.ts skillArea(), i.e. from the ability's params.
// planSkillPreview() is pure (unit-tested); SkillPreview draws a plan with a few
// terrain-hugging meshes that are only rebuilt while shown.
import * as THREE from 'three';
import type { EntityId } from '../../core/types';
import type { AbilityDef } from '../../data/types';
import { skillArea, type DashStop, type SkillArea } from '../../data/skillInfo';

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

export interface PreviewPlan {
  tone: PreviewTone;
  /** thin ring at the skill's range around the caster */
  range: PolarShape | null;
  /** the area it covers */
  area: PolarShape | null;
  /** the path / strip */
  strip: StripShape | null;
  /** a ring under the picked unit or the landing point */
  marker: PolarShape | null;
  /** false: releasing now finds nothing to act on (no target in range) */
  valid: boolean;
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

/**
 * Is `t` a unit this targeted skill can pick? Enemy skills take anything not on your
 * own side; ally skills take heroes and your own soldiers (hidden roles: any hero may be
 * a friend). Range: from the caster's eye to the unit's chest, like the sim's aimTarget.
 */
export function pickable(area: Extract<SkillArea, { kind: 'target' }>, caster: { x: number; y: number; z: number }, t: PreviewUnit | null): boolean {
  if (!t || !UNIT_KINDS.has(t.kind)) return false;
  const d = Math.hypot(t.x - caster.x, t.y + 1.1 - (caster.y + 1.6), t.z - caster.z);
  if (d > area.range + 0.6) return false;
  if (area.side === 'enemy') return !t.own;
  return t.kind === 'hero' || (t.kind === 'troop' && t.own);
}

/** The shapes to draw for a held skill (null: the skill has nothing to show). */
export function planSkillPreview(inp: PreviewInput): PreviewPlan | null {
  const area = skillArea(inp.def);
  if (!area) return null;
  const c = inp.caster;
  const f = fwd(inp.yaw);
  const plan: PreviewPlan = { tone: previewTone(inp.def), range: null, area: null, strip: null, marker: null, valid: true };
  switch (area.kind) {
    case 'ring':
      plan.area = full(c.x, c.z, 0, area.radius);
      break;
    case 'circle': {
      const p = clampToRange(c, inp.aimPoint, area.range);
      plan.range = rangeRing(c, area.range);
      plan.area = full(p.x, p.z, 0, Math.max(0.6, area.radius));
      break;
    }
    case 'blinkPoint': {
      const p = clampToRange(c, inp.aimPoint, area.range);
      plan.range = rangeRing(c, area.range);
      const len = Math.hypot(p.x - c.x, p.z - c.z);
      plan.strip = { x: c.x, z: c.z, yaw: Math.atan2(-(p.x - c.x), -(p.z - c.z)), start: 0.6, end: Math.max(0.6, len - 0.9), width: 0.25 };
      plan.marker = full(p.x, p.z, 0.55, 0.95);
      break;
    }
    case 'dash': {
      const stop = area.stop && inp.units ? dashStop(c, inp.yaw, area.length, area.stop, inp.units) : { length: area.length, unit: null };
      const len = stop.length;
      const end = { x: c.x + f.x * len, z: c.z + f.z * len };
      plan.strip = { x: c.x, z: c.z, yaw: inp.yaw, start: Math.min(0.6, len), end: len, width: area.width > 0 ? area.width : 0.3 };
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
      if (area.endRadius) {
        const d = area.start + area.length;
        plan.area = full(c.x + f.x * d, c.z + f.z * d, 0, area.endRadius);
      }
      break;
    }
    case 'target': {
      plan.range = rangeRing(c, area.range);
      const t = inp.target;
      if (pickable(area, c, t)) {
        plan.marker = full(t!.x, t!.z, 0.7, 1.15);
        if (area.radius) plan.area = full(t!.x, t!.z, 0, area.radius);
      } else if (area.selfFallback) {
        plan.marker = full(c.x, c.z, 0.7, 1.15);
      } else {
        plan.valid = false;
        plan.tone = 'invalid';
      }
      break;
    }
  }
  return plan;
}

// ── drawing ─────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
attribute float aEdge;
attribute float aAlong;
varying float vEdge;
varying float vAlong;
void main() {
  vEdge = aEdge;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

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

function makeMaterial(fill: number, edgeW: number, flow: number): THREE.ShaderMaterial {
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
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A grid mesh whose vertices are rewritten each shown frame (positions + edge distance + distance along). */
class GroundMesh {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
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

export class SkillPreview {
  readonly group = new THREE.Group();
  private readonly rangeM: GroundMesh;
  private readonly areaM: GroundMesh;
  private readonly stripM: GroundMesh;
  private readonly markerM: GroundMesh;
  private time = 0;
  /** last shown plan (the cast flash replays it), whose skill it was and when it was last shown */
  private last: PreviewPlan | null = null;
  private lastId = '';
  private lastAt = -1;
  private flashUntil = 0;
  /** releasing now would act (a target is in range); true when nothing is held */
  valid = true;
  groundY: (x: number, z: number) => number = () => 0;

  constructor() {
    this.group.name = 'skillPreview';
    this.rangeM = new GroundMesh(128, 1, makeMaterial(0.35, 0.3, 0), 41);
    this.areaM = new GroundMesh(72, 6, makeMaterial(0.26, 0.5, 1), 42);
    this.stripM = new GroundMesh(4, 40, makeMaterial(0.24, 0.4, 1), 42);
    this.markerM = new GroundMesh(48, 1, makeMaterial(0.9, 0.2, 0), 43);
    for (const m of [this.rangeM, this.areaM, this.stripM, this.markerM]) this.group.add(m.mesh);
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
    } else if (this.last && this.time < this.flashUntil) {
      plan = this.last;
      alpha = Math.max(0, (this.flashUntil - this.time) / CAST_FLASH_SECONDS);
    }
    this.valid = plan?.valid ?? true;
    const show = (m: GroundMesh, shape: PolarShape | StripShape | null, color: THREE.Color, a: number, strip = false): void => {
      if (!shape) {
        m.mesh.visible = false;
        return;
      }
      if (strip) drawStrip(m, shape as StripShape, this.groundY);
      else drawPolar(m, shape as PolarShape, this.groundY);
      const u = m.mat.uniforms;
      (u.uColor.value as THREE.Color).copy(color);
      u.uAlpha.value = a;
      u.uTime.value = this.time;
      m.mesh.visible = a > 0.01;
    };
    if (!plan) {
      for (const m of [this.rangeM, this.areaM, this.stripM, this.markerM]) m.mesh.visible = false;
      return;
    }
    const tone = TONES[plan.tone];
    const flashing = alpha < 1 || !f.def;
    show(this.rangeM, flashing ? null : plan.range, plan.valid ? RANGE_COLOR : TONES.invalid, 0.7 * alpha);
    show(this.areaM, plan.area, tone, alpha);
    show(this.stripM, plan.strip, tone, alpha, true);
    show(this.markerM, plan.marker, tone, 0.9 * alpha);
  }

  /** Hide everything (spectating, dead). */
  clear(): void {
    this.last = null;
    this.lastId = '';
    this.flashUntil = 0;
    this.valid = true;
    for (const m of [this.rangeM, this.areaM, this.stripM, this.markerM]) m.mesh.visible = false;
  }

  dispose(): void {
    for (const m of [this.rangeM, this.areaM, this.stripM, this.markerM]) m.dispose();
  }
}
