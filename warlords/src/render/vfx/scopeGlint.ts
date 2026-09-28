// Scope glint: a hero looking down a sniper / marksman scope flashes a small
// sun glint toward whoever stands in front of the lens — the fair tell of a
// scope aimed at you (other heroes only, never through walls). A small star
// sprite at the scope, a constant size on screen, brightest dead on the aim line.
import * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import { dirFromYawPitch } from '../../core/math';
import type { EntityId, ViewEntity } from '../../core/types';
import { VF_ADS, VF_DEAD, VF_DOWNED, VF_STEALTH } from '../../core/types';
import { WEAPON_BY_ID } from '../../data';
import { aimProfile } from '../../data/weaponFeel';
import { fpEyeOf } from '../camera/firstPerson';

const COS_FULL = Math.cos((7 * Math.PI) / 180);
const COS_NONE = Math.cos((22 * Math.PI) / 180);
/** Closer than this the glint adds nothing (you can see the shooter anyway). */
const MIN_DIST = 10;

/**
 * Glint strength 0..1 for a scope aimed along `aim` seen from the direction
 * `toViewer` (both unit vectors from the scope): full within ~7° of the aim
 * line, gone past ~22°; none up close.
 */
export function glintStrength(aim: Vec3, toViewer: Vec3, dist: number): number {
  if (dist < MIN_DIST) return 0;
  const c = aim.x * toViewer.x + aim.y * toViewer.y + aim.z * toViewer.z;
  const s = (c - COS_NONE) / (COS_FULL - COS_NONE);
  return s <= 0 ? 0 : s >= 1 ? 1 : s;
}

/** Does this hero entity show a glint at all (aiming a scoped weapon, up, not hidden)? */
export function scopedForGlint(e: Pick<ViewEntity, 'kind' | 'flags' | 'weapon'>): boolean {
  if (e.kind !== 'hero' || !(e.flags & VF_ADS) || e.flags & (VF_DEAD | VF_DOWNED | VF_STEALTH)) return false;
  const def = e.weapon ? WEAPON_BY_ID[e.weapon] : undefined;
  return !!def && aimProfile(def).overlay;
}

let glintTex: THREE.Texture | null = null;
function glintTexture(): THREE.Texture {
  if (glintTex) return glintTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.18, 'rgba(255,246,214,0.95)');
    r.addColorStop(0.45, 'rgba(255,214,140,0.28)');
    r.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    // four thin rays
    g.globalCompositeOperation = 'lighter';
    for (const [w, h] of [[64, 3], [3, 64]] as const) {
      const lg = g.createLinearGradient(32 - w / 2, 32 - h / 2, 32 + w / 2, 32 + h / 2);
      lg.addColorStop(0, 'rgba(255,240,200,0)');
      lg.addColorStop(0.5, 'rgba(255,250,235,0.9)');
      lg.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = lg;
      g.fillRect(32 - w / 2, 32 - h / 2, w, h);
    }
  }
  glintTex = new THREE.CanvasTexture(c);
  glintTex.colorSpace = THREE.SRGBColorSpace;
  return glintTex;
}

const _to = new THREE.Vector3();
const _eye = { x: 0, y: 0, z: 0 };

export class ScopeGlints {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Sprite[] = [];

  constructor() {
    this.group.name = 'scopeGlints';
  }

  /**
   * One frame: a glint for every other hero scoped toward the camera with a
   * clear line to it. `zoom`: the camera's zoom (the glint keeps its size on screen).
   */
  update(ents: readonly ViewEntity[], localId: EntityId | null, camPos: THREE.Vector3, time: number, zoom: number, blocked: (a: Vec3, b: Vec3) => boolean): void {
    let n = 0;
    for (const e of ents) {
      if (e.id === localId || !scopedForGlint(e)) continue;
      const aim = dirFromYawPitch(e.yaw, e.pitch);
      _eye.x = e.x + aim.x * 0.45;
      _eye.y = e.y + fpEyeOf(e) + aim.y * 0.45;
      _eye.z = e.z + aim.z * 0.45;
      _to.set(camPos.x - _eye.x, camPos.y - _eye.y, camPos.z - _eye.z);
      const dist = _to.length();
      if (dist < 1e-3) continue;
      _to.multiplyScalar(1 / dist);
      const s = glintStrength(aim, _to, dist);
      if (s <= 0.02 || blocked(_eye, { x: camPos.x, y: camPos.y, z: camPos.z })) continue;
      const sp = this.sprite(n++);
      sp.position.set(_eye.x, _eye.y, _eye.z);
      // ~1.1° across at full strength whatever the distance / zoom, with a slow twinkle
      const twinkle = 0.85 + 0.15 * Math.sin(time * 7.3 + e.id * 1.7);
      const size = (dist * 0.02 * (0.55 + 0.45 * s) * twinkle) / Math.max(1, zoom);
      sp.scale.set(size, size, 1);
      (sp.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.35 + 0.75 * s);
      sp.visible = true;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i]!.visible = false;
  }

  /** Loading warm-up: one (hidden) glint exists so its program compiles with the rest. */
  prewarm(): void {
    this.sprite(0).visible = false;
  }

  private sprite(i: number): THREE.Sprite {
    let sp = this.pool[i];
    if (!sp) {
      const mat = new THREE.SpriteMaterial({ map: glintTexture(), color: '#fff6e0', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      sp = new THREE.Sprite(mat);
      sp.name = 'scopeGlint';
      sp.frustumCulled = false;
      sp.renderOrder = 5;
      this.pool.push(sp);
      this.group.add(sp);
    }
    return sp;
  }

  dispose(): void {
    for (const sp of this.pool) (sp.material as THREE.SpriteMaterial).dispose();
    this.pool.length = 0;
    this.group.clear();
  }
}
