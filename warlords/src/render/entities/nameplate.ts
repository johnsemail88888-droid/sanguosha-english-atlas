// Screen-space nameplates (sprites + canvas textures, no DOM). Heroes get a
// full plate (name, player, HP/shield bar with 100-HP ticks, crown, role seal,
// claim tag, downed icon, quick-chat bubble); troops get a tiny pennant and an
// HP bar only when damaged. Textures redraw only when their content changes.
import * as THREE from 'three';
import type { Kingdom, RoleId } from '../../core/types';
import { KINGDOM_COLORS, ROLE_BADGE } from '../palette';
import { CALLIGRAPHY_FONT, UI_FONT, makeCanvas, roundRect, hexA } from '../core/textures';

export interface PlateData {
  heroName: string;
  playerName: string;
  hp: number;
  maxHp: number;
  shield: number;
  lord: boolean;
  role?: RoleId;
  claim?: RoleId;
  claimLabel?: string;
  downed: boolean;
  kingdom: Kingdom | undefined;
  /** your own hero / squad: green accents */
  friendly: boolean;
  bubble?: string;
}

const W = 384;
const H = 136;
/** plate height as a fraction of the screen height */
export const PLATE_SCREEN_FRAC = 0.085;

export class Nameplate {
  readonly sprite: THREE.Sprite;
  private readonly tex: THREE.CanvasTexture | null;
  private readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  /** what the texture currently shows (quantised; compared field by field, no per-frame strings) */
  private readonly shown = {
    valid: false,
    heroName: '',
    playerName: '',
    hpQ: 0,
    shQ: 0,
    maxHp: 0,
    lord: false,
    role: undefined as RoleId | undefined,
    claim: undefined as RoleId | undefined,
    claimLabel: undefined as string | undefined,
    downed: false,
    kingdom: undefined as Kingdom | undefined,
    friendly: false,
    bubble: undefined as string | undefined,
  };
  opacity = 1;

  constructor() {
    const c = makeCanvas(W, H);
    this.ctx = c?.ctx ?? null;
    this.tex = c ? new THREE.CanvasTexture(c.canvas as HTMLCanvasElement) : null;
    if (this.tex) {
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.minFilter = THREE.LinearFilter;
      this.tex.generateMipmaps = false;
    }
    const mat = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 50;
    this.sprite.name = 'nameplate';
  }

  /** Redraw if the (quantised) content changed. */
  set(d: PlateData): void {
    if (!this.ctx || !this.tex) return;
    const hpQ = Math.round((d.hp / Math.max(1, d.maxHp)) * 60);
    const shQ = Math.round(d.shield / 5);
    const s = this.shown;
    if (
      s.valid &&
      s.heroName === d.heroName &&
      s.playerName === d.playerName &&
      s.hpQ === hpQ &&
      s.shQ === shQ &&
      s.maxHp === d.maxHp &&
      s.lord === d.lord &&
      s.role === d.role &&
      s.claim === d.claim &&
      s.claimLabel === d.claimLabel &&
      s.downed === d.downed &&
      s.kingdom === d.kingdom &&
      s.friendly === d.friendly &&
      s.bubble === d.bubble
    )
      return;
    s.valid = true;
    s.heroName = d.heroName;
    s.playerName = d.playerName;
    s.hpQ = hpQ;
    s.shQ = shQ;
    s.maxHp = d.maxHp;
    s.lord = d.lord;
    s.role = d.role;
    s.claim = d.claim;
    s.claimLabel = d.claimLabel;
    s.downed = d.downed;
    s.kingdom = d.kingdom;
    s.friendly = d.friendly;
    s.bubble = d.bubble;
    draw(this.ctx, d);
    this.tex.needsUpdate = true;
  }

  /** Scale for the current fov + distance, and apply opacity. */
  layout(fovDeg: number, dist: number, aspectFix = 1): void {
    const h = PLATE_SCREEN_FRAC * 2 * Math.tan(((fovDeg * Math.PI) / 180) / 2);
    const k = Math.max(0.55, Math.min(1, 1 - (dist - 12) / 140));
    this.sprite.scale.set(((h * W) / H) * k * aspectFix, h * k, 1);
    (this.sprite.material as THREE.SpriteMaterial).opacity = this.opacity;
    this.sprite.visible = this.opacity > 0.02;
  }

  dispose(): void {
    this.tex?.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}

function draw(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, d: PlateData): void {
  g.clearRect(0, 0, W, H);
  const kc = d.kingdom ? KINGDOM_COLORS[d.kingdom] : '#b08a3a';
  let y = 4;
  // quick-chat bubble (top)
  if (d.bubble) {
    g.font = `bold 22px ${UI_FONT}`;
    const tw = Math.min(W - 20, g.measureText(d.bubble).width + 24);
    const bx = (W - tw) / 2;
    g.fillStyle = 'rgba(244,236,214,0.95)';
    roundRect(g, bx, y, tw, 32, 10);
    g.fill();
    g.strokeStyle = '#6b4a2e';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#2a1d14';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(d.bubble, W / 2, y + 17, tw - 16);
  }
  y = 40;
  // name row
  g.textBaseline = 'middle';
  g.font = `bold 36px ${CALLIGRAPHY_FONT}`;
  const nameW = g.measureText(d.heroName).width;
  g.font = `bold 20px ${UI_FONT}`;
  const pn = d.playerName ? ` ${d.playerName}` : '';
  const pnW = g.measureText(pn).width;
  const badges = (d.lord ? 34 : 0) + (d.role ? 34 : 0);
  let x = (W - (nameW + pnW + badges)) / 2;
  const rowY = y + 20;
  if (d.lord) {
    drawCrown(g, x + 14, rowY, 13);
    x += 34;
  }
  if (d.role) {
    const rb = ROLE_BADGE[d.role];
    g.fillStyle = rb.color;
    roundRect(g, x + 2, rowY - 14, 28, 28, 5);
    g.fill();
    g.strokeStyle = '#2a1d14';
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = '#fff8e8';
    g.font = `bold 20px ${CALLIGRAPHY_FONT}`;
    g.textAlign = 'center';
    g.fillText(rb.glyph, x + 16, rowY + 1);
    x += 34;
  }
  g.textAlign = 'left';
  g.font = `bold 36px ${CALLIGRAPHY_FONT}`;
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(12,8,4,0.85)';
  g.strokeText(d.heroName, x, rowY);
  g.fillStyle = d.friendly ? '#8fe08a' : lighten(kc);
  g.fillText(d.heroName, x, rowY);
  x += nameW;
  if (pn) {
    g.font = `bold 20px ${UI_FONT}`;
    g.lineWidth = 4;
    g.strokeText(pn, x, rowY + 2);
    g.fillStyle = '#f2ead6';
    g.fillText(pn, x, rowY + 2);
  }
  // claim tag (跳身份) under the name, right-aligned
  const barY = y + 48;
  if (d.claim && d.claimLabel) {
    const rb = ROLE_BADGE[d.claim];
    g.font = `bold 16px ${UI_FONT}`;
    const t = d.claimLabel;
    const tw = g.measureText(t).width + 14;
    g.fillStyle = hexA(rb.color, 0.9);
    roundRect(g, W - tw - 30, barY + 22, tw, 22, 6);
    g.fill();
    g.fillStyle = '#1a1208';
    g.textAlign = 'center';
    g.fillText(t, W - tw / 2 - 30, barY + 34);
  }
  // HP bar with 100-HP ticks (勾玉 segments) + shield overlay
  const bw = 260;
  const bh = 18;
  const bx = (W - bw) / 2;
  g.fillStyle = 'rgba(10,8,6,0.8)';
  roundRect(g, bx - 3, barY - 3, bw + 6, bh + 6, 5);
  g.fill();
  if (d.downed) {
    g.fillStyle = '#6a0e0e';
    g.fillRect(bx, barY, bw, bh);
    g.fillStyle = '#ffdddd';
    g.font = `bold 15px ${UI_FONT}`;
    g.textAlign = 'center';
    g.fillText('濒死 DOWNED', W / 2, barY + bh / 2 + 1);
    return;
  }
  const total = Math.max(1, d.maxHp);
  const frac = Math.max(0, Math.min(1, d.hp / total));
  const hpCol = frac > 0.6 ? '#4fc25a' : frac > 0.3 ? '#e0b030' : '#e04a3a';
  g.fillStyle = '#2a1a14';
  g.fillRect(bx, barY, bw, bh);
  g.fillStyle = d.friendly ? '#5ad07a' : hpCol;
  g.fillRect(bx, barY, bw * frac, bh);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(bx, barY, bw * frac, bh * 0.4);
  if (d.shield > 0) {
    const sf = Math.min(1 - frac, d.shield / total);
    g.fillStyle = 'rgba(170,215,255,0.95)';
    g.fillRect(bx + bw * frac, barY, bw * Math.max(sf, 0.02), bh);
  }
  g.fillStyle = 'rgba(10,8,6,0.9)';
  for (let k = 100; k < total; k += 100) g.fillRect(bx + (bw * k) / total - 1, barY, 2, bh);
}

function drawCrown(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  g.fillStyle = '#f0c040';
  g.strokeStyle = '#5a3a10';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx - s, cy + s * 0.7);
  g.lineTo(cx - s, cy - s * 0.4);
  g.lineTo(cx - s * 0.5, cy + s * 0.05);
  g.lineTo(cx, cy - s * 0.8);
  g.lineTo(cx + s * 0.5, cy + s * 0.05);
  g.lineTo(cx + s, cy - s * 0.4);
  g.lineTo(cx + s, cy + s * 0.7);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#c0392b';
  g.beginPath();
  g.arc(cx, cy + s * 0.25, s * 0.2, 0, Math.PI * 2);
  g.fill();
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) + 70);
  const gg = Math.min(255, ((n >> 8) & 255) + 70);
  const b = Math.min(255, (n & 255) + 70);
  return `rgb(${r},${gg},${b})`;
}

// ── troop badges ────────────────────────────────────────────────────────────
// Every troop / NPC marker (kingdom pennant or green squad chevron, plus a
// tiny HP bar while damaged) is one instance of a screen-aligned quad batch:
// ONE draw call for all of them, whatever the troop count. Sizes are fractions
// of the screen height (constant on-screen size, like sizeAttenuation=false
// sprites), anchored above each unit's head.

const BADGE_VERT = /* glsl */ `
attribute vec3 aAnchor;
attribute vec4 aRect;   // offX, offY, width, height (fractions of the screen height)
attribute vec4 aColor;  // linear rgb + alpha
attribute float aKind;  // 0 solid, 1 pennant, 2 chevron
varying vec2 vUv;
varying vec4 vColor;
varying float vKind;
void main() {
  vUv = uv;
  vColor = aColor;
  vKind = aKind;
  vec4 clip = projectionMatrix * viewMatrix * vec4(aAnchor, 1.0);
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  // quad: x in [-0.5, 0.5], y in [0, 1] (bottom-anchored)
  vec2 off = vec2(aRect.x + position.x * aRect.z, aRect.y + position.y * aRect.w) * 2.0;
  clip.xy += vec2(off.x / aspect, off.y) * clip.w;
  gl_Position = clip;
}`;

const BADGE_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vKind;
void main() {
  vec4 c = vColor;
  if (vKind > 0.5) {
    // greyscale atlas multiplied by the kingdom / squad tint (white fill takes the
    // colour, the dark outline and pole stay dark; mip-averaged edges blend)
    vec4 t = texture2D(uAtlas, vec2((vUv.x + (vKind > 1.5 ? 1.0 : 0.0)) * 0.5, vUv.y));
    c = vec4(t.rgb * vColor.rgb, t.a * vColor.a);
  }
  if (c.a < 0.02) discard;
  gl_FragColor = c;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Greyscale atlas: [pennant | chevron], 64x64 each; white where the tint goes. */
function badgeAtlas(): THREE.Texture | null {
  const c = makeCanvas(128, 64);
  if (!c) return null;
  const g = c.ctx;
  // pennant on a pole
  g.fillStyle = '#2a2a2a';
  g.fillRect(14, 6, 5, 54);
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#1a1208';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(19, 8);
  g.lineTo(58, 20);
  g.lineTo(19, 34);
  g.closePath();
  g.fill();
  g.stroke();
  // squad chevron
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#0c1a0c';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(64 + 8, 14);
  g.lineTo(64 + 32, 40);
  g.lineTo(64 + 56, 14);
  g.lineTo(64 + 56, 28);
  g.lineTo(64 + 32, 54);
  g.lineTo(64 + 8, 28);
  g.closePath();
  g.stroke();
  g.fill();
  const tex = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  return tex;
}

const SQUAD_GREEN = new THREE.Color('#5ad07a');
const BAR_BG = new THREE.Color('#140c08');
const BAR_HIGH = new THREE.Color('#4fc25a');
const BAR_MID = new THREE.Color('#e0b030');
const BAR_LOW = new THREE.Color('#e04a3a');

/** Batched overhead markers for every troop / NPC (one draw call). */
export class TroopBadgeLayer {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly anchor: THREE.InstancedBufferAttribute;
  private readonly rect: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly kind: THREE.InstancedBufferAttribute;
  private readonly tex: THREE.Texture | null;
  private readonly capacity: number;
  private n = 0;

  constructor(maxUnits = 256) {
    this.capacity = maxUnits * 3;
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.anchor = mk(3);
    this.rect = mk(4);
    this.color = mk(4);
    this.kind = mk(1);
    this.geo.setAttribute('aAnchor', this.anchor);
    this.geo.setAttribute('aRect', this.rect);
    this.geo.setAttribute('aColor', this.color);
    this.geo.setAttribute('aKind', this.kind);
    this.geo.instanceCount = 0;
    this.tex = badgeAtlas();
    const mat = new THREE.ShaderMaterial({
      vertexShader: BADGE_VERT,
      fragmentShader: BADGE_FRAG,
      uniforms: { uAtlas: { value: this.tex } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 49;
    this.mesh.name = 'troop_badges';
  }

  /** Number of quads queued this frame. */
  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  private quad(x: number, y: number, z: number, offX: number, offY: number, w: number, h: number, c: THREE.Color, a: number, kind: number): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.anchor.setXYZ(i, x, y, z);
    this.rect.setXYZW(i, offX, offY, w, h);
    this.color.setXYZW(i, c.r, c.g, c.b, a);
    this.kind.setX(i, kind);
  }

  /**
   * Queue one unit's pennant (or green squad chevron) anchored at the head-top
   * point (x, y, z), plus its HP bar when `showBar`; `alpha` fades the whole
   * marker (line-of-sight occlusion). Allocation-free.
   */
  add(x: number, y: number, z: number, kingdom: THREE.Color, squad: boolean, hpFrac: number, showBar: boolean, dist: number, alpha = 1): void {
    const k = Math.max(0.6, Math.min(1, 1 - (dist - 10) / 80));
    const ps = 0.028 * k;
    const a = Math.max(0, Math.min(1, alpha));
    if (a <= 0.02) return;
    this.quad(x, y, z, 0, 0, ps, ps, squad ? SQUAD_GREEN : kingdom, a, squad ? 2 : 1);
    if (!showBar) return;
    const bw = 0.05 * k;
    const bh = 0.0065 * k;
    const lift = ps * 1.15;
    const f = Math.max(0.02, Math.min(1, hpFrac));
    this.quad(x, y, z, 0, lift - bh * 0.9, bw * 1.06, bh * 1.8, BAR_BG, 0.85 * a, 0);
    const col = squad ? SQUAD_GREEN : f > 0.6 ? BAR_HIGH : f > 0.3 ? BAR_MID : BAR_LOW;
    this.quad(x, y, z, -bw / 2 + (bw * f) / 2, lift - bh * 0.5, bw * f, bh, col, a, 0);
  }

  /** Upload this frame's quads. */
  end(): void {
    const n = this.n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const [attr, size] of [
      [this.anchor, 3],
      [this.rect, 4],
      [this.color, 4],
      [this.kind, 1],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex?.dispose();
    this.mesh.removeFromParent();
  }
}
