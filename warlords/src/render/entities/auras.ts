// Status auras around characters: shield / invulnerability bubbles, lord
// crown, marked chevron, stun stars, plus rate-limited particle emitters for
// burn, charm, dance, boost, haste, freeze, slow and root. Shared geometries /
// materials; per-character objects are created lazily.
import * as THREE from 'three';
import {
  VF_BOOSTED,
  VF_BURNING,
  VF_CHARMED,
  VF_DANCING,
  VF_DEAD,
  VF_FROZEN,
  VF_HASTE,
  VF_INVULN,
  VF_LORD,
  VF_MARKED,
  VF_ROOTED,
  VF_SHIELDED,
  VF_SLOWED,
  VF_STUNNED,
} from '../../core/types';
import { PT } from '../core/textures';
import { makeCanvas } from '../core/textures';
import type { Effects } from '../vfx/effects';

const BUBBLE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  vP = position;
  gl_Position = projectionMatrix * mv;
}`;
const BUBBLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float hex = 0.5 + 0.5 * sin(vP.y * 22.0 + uTime * 3.0) * sin(atan(vP.x, vP.z) * 9.0);
  float a = (f * 0.9 + hex * 0.12) * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}`;

let bubbleGeo: THREE.BufferGeometry | null = null;
const bubbleMats = new Map<string, THREE.ShaderMaterial>();
/** `faint`: the local hero's own bubble — it sits in the middle of the third-person view, so it is only a hint. */
function bubbleMaterial(kind: 'shield' | 'invuln', faint = false): THREE.ShaderMaterial {
  const key = faint ? `${kind}:faint` : kind;
  let m = bubbleMats.get(key);
  if (!m) {
    m = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      uniforms: {
        uColor: { value: kind === 'shield' ? new THREE.Color(0.5, 0.9, 2.2) : new THREE.Color(2.2, 1.7, 0.6) },
        uTime: { value: 0 },
        uAlpha: { value: faint ? 0.22 : 0.8 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    bubbleMats.set(key, m);
  }
  return m;
}

let crownGeo: THREE.BufferGeometry | null = null;
let crownMat: THREE.MeshStandardMaterial | null = null;
function crownMesh(): THREE.Mesh {
  if (!crownGeo) {
    const s = new THREE.Shape();
    const pts = 5;
    s.moveTo(-0.16, 0);
    for (let i = 0; i <= pts * 2; i++) {
      const x = -0.16 + (i / (pts * 2)) * 0.32;
      s.lineTo(x, i % 2 === 0 ? 0.16 : 0.07);
    }
    s.lineTo(0.16, 0);
    s.lineTo(-0.16, 0);
    const flat = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false });
    // bend the flat crown into a ring by wrapping x around a cylinder
    const pos = flat.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = (x / 0.32) * Math.PI * 2;
      const r = 0.1 + z;
      pos.setXYZ(i, Math.sin(a) * r, y, Math.cos(a) * r);
    }
    flat.computeVertexNormals();
    crownGeo = flat;
    crownMat = new THREE.MeshStandardMaterial({ color: '#f0c040', emissive: '#6a4a10', metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide });
  }
  const m = new THREE.Mesh(crownGeo, crownMat!);
  m.name = 'crown';
  return m;
}

let chevronMat: THREE.SpriteMaterial | null = null;
function chevronSprite(): THREE.Sprite {
  if (!chevronMat) {
    const c = makeCanvas(64, 64);
    let tex: THREE.Texture | null = null;
    if (c) {
      const g = c.ctx;
      g.fillStyle = '#ff3b2a';
      g.strokeStyle = '#2a0404';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(6, 10);
      g.lineTo(32, 38);
      g.lineTo(58, 10);
      g.lineTo(58, 26);
      g.lineTo(32, 56);
      g.lineTo(6, 26);
      g.closePath();
      g.stroke();
      g.fill();
      tex = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    chevronMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false });
  }
  const s = new THREE.Sprite(chevronMat);
  s.center.set(0.5, 0);
  s.renderOrder = 51;
  return s;
}

let starMat: THREE.SpriteMaterial | null = null;
function starSprite(): THREE.Sprite {
  if (!starMat) {
    const c = makeCanvas(32, 32);
    let tex: THREE.Texture | null = null;
    if (c) {
      const g = c.ctx;
      g.fillStyle = '#ffe070';
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 15 : 6;
        const x = 16 + Math.cos(a) * r;
        const y = 16 + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      tex = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    starMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  }
  const s = new THREE.Sprite(starMat);
  s.scale.setScalar(0.16);
  return s;
}

/** Update shared aura uniforms once per frame. */
export function updateAuraShared(time: number): void {
  for (const m of bubbleMats.values()) m.uniforms.uTime.value = time;
}

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);
const COL = {
  burn: C(2.6, 0.9, 0.2),
  burn1: C(0.8, 0.1, 0.02),
  heart: C(2.4, 0.6, 1.1),
  note: C(2.2, 1.7, 0.6),
  boost: C(2.6, 0.5, 0.2),
  haste: C(1.6, 1.8, 2.2),
  snow: C(1.4, 1.8, 2.3),
  slow: C(0.5, 0.8, 1.8),
  root: C(0.5, 1.6, 0.4),
};

export class AuraSet {
  readonly group = new THREE.Group();
  private bubble: THREE.Mesh | null = null;
  private crown: THREE.Mesh | null = null;
  private chevron: THREE.Sprite | null = null;
  private stars: THREE.Sprite[] = [];
  private acc = 0;
  private readonly tmp = new THREE.Vector3();

  /**
   * @param headY  top of the head in the character's local frame
   * @param world  world position of the character's feet (for particle emitters)
   */
  update(flags: number, headY: number, world: THREE.Vector3, dt: number, time: number, fx: Effects, fovDeg: number, camDist: number, emit: boolean, local = false): void {
    const dead = (flags & VF_DEAD) !== 0;
    // bubble: invuln (gold) wins over shield (blue)
    const bubbleKind = dead ? null : flags & VF_INVULN ? 'invuln' : flags & VF_SHIELDED ? 'shield' : null;
    if (bubbleKind) {
      if (!this.bubble) {
        if (!bubbleGeo) bubbleGeo = new THREE.IcosahedronGeometry(1, 2);
        this.bubble = new THREE.Mesh(bubbleGeo, bubbleMaterial(bubbleKind, local));
        this.bubble.renderOrder = 22;
        this.group.add(this.bubble);
      }
      this.bubble.material = bubbleMaterial(bubbleKind, local);
      this.bubble.visible = true;
      this.bubble.position.set(0, headY * 0.52, 0);
      this.bubble.scale.set(0.85, headY * 0.62, 0.85);
    } else if (this.bubble) this.bubble.visible = false;
    // lord crown
    if (flags & VF_LORD && !dead) {
      if (!this.crown) {
        this.crown = crownMesh();
        this.group.add(this.crown);
      }
      this.crown.visible = true;
      this.crown.position.set(0, headY + 0.32 + Math.sin(time * 2) * 0.03, 0);
      this.crown.rotation.y = time * 1.2;
    } else if (this.crown) this.crown.visible = false;
    // marked chevron (constant screen size)
    if (flags & VF_MARKED && !dead) {
      if (!this.chevron) {
        this.chevron = chevronSprite();
        this.group.add(this.chevron);
      }
      const unit = 2 * Math.tan(((fovDeg * Math.PI) / 180) / 2);
      this.chevron.scale.setScalar(0.03 * unit);
      this.chevron.position.set(0, headY + 0.75 + Math.sin(time * 5) * 0.06, 0);
      this.chevron.visible = true;
    } else if (this.chevron) this.chevron.visible = false;
    // stun stars orbiting the head
    const stunned = (flags & VF_STUNNED) !== 0 && !dead;
    if (stunned && this.stars.length === 0) {
      for (let i = 0; i < 3; i++) {
        const s = starSprite();
        this.stars.push(s);
        this.group.add(s);
      }
    }
    this.stars.forEach((s, i) => {
      s.visible = stunned;
      if (!stunned) return;
      const a = time * 4 + (i * Math.PI * 2) / 3;
      s.position.set(Math.cos(a) * 0.28, headY + 0.08 + Math.sin(a * 2) * 0.03, Math.sin(a) * 0.28);
    });
    // particle emitters (throttled; skipped for far characters)
    if (!emit || dead || camDist > 60) return;
    this.acc += dt;
    if (this.acc < 0.06) return;
    const step = this.acc;
    this.acc = 0;
    const p = this.tmp;
    const body = (h: number): THREE.Vector3 => p.set(world.x + (Math.random() - 0.5) * 0.5, world.y + h, world.z + (Math.random() - 0.5) * 0.5);
    const n = (rate: number): number => Math.max(0, Math.round(rate * step + Math.random() - 0.5));
    if (flags & VF_BURNING)
      fx.burst(body(0.3 + Math.random() * headY * 0.7), { count: n(28), tex: PT.flame, color: COL.burn, color1: COL.burn1, speed: [0.5, 1.5], up: 1, life: [0.3, 0.6], size: [0.25, 0.5], gravity: -3, drag: 1 });
    if (flags & VF_CHARMED) fx.burst(body(headY + 0.2), { count: n(5), tex: PT.heart, color: COL.heart, speed: [0.3, 0.8], up: 1, life: [0.8, 1.2], size: [0.14, 0.1], gravity: -0.8 });
    if (flags & VF_DANCING) fx.burst(body(headY + 0.1), { count: n(4), tex: PT.note, color: COL.note, speed: [0.3, 1], up: 1, life: [0.9, 1.3], size: [0.16, 0.12], gravity: -0.7, spin: 3 });
    if (flags & VF_BOOSTED) fx.burst(body(Math.random() * headY), { count: n(10), tex: PT.glow, color: COL.boost, speed: [0.3, 1], up: 1, life: [0.4, 0.8], size: [0.08, 0.02], gravity: -2 });
    if (flags & VF_FROZEN) fx.burst(body(Math.random() * headY), { count: n(8), tex: PT.snow, color: COL.snow, speed: [0.1, 0.4], life: [0.6, 1.0], size: [0.08, 0.05], gravity: 0.6 });
    if (flags & VF_HASTE) fx.burst(body(0.2 + Math.random() * 0.8), { count: n(10), tex: PT.spark, color: COL.haste, speed: [0.1, 0.3], life: [0.2, 0.35], size: [0.04, 0.02], alpha: 0.6 });
    if (flags & VF_SLOWED) fx.burst(body(0.05), { count: n(6), tex: PT.glow, color: COL.slow, speed: [0.1, 0.4], life: [0.4, 0.7], size: [0.1, 0.04], gravity: 1, flat: true });
    if (flags & VF_ROOTED) fx.burst(body(0.05), { count: n(8), tex: PT.petal, color: COL.root, speed: [0.3, 0.8], up: 1, life: [0.4, 0.7], size: [0.1, 0.06], gravity: -0.5, spin: 4 });
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}
