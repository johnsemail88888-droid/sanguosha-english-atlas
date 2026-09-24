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
  private key = '';
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

  /** Redraw if the content changed. */
  set(d: PlateData): void {
    const hpQ = Math.round((d.hp / Math.max(1, d.maxHp)) * 60);
    const shQ = Math.round(d.shield / 5);
    const key = `${d.heroName}|${d.playerName}|${hpQ}|${shQ}|${d.maxHp}|${d.lord}|${d.role ?? ''}|${d.claim ?? ''}|${d.downed}|${d.friendly}|${d.bubble ?? ''}`;
    if (key === this.key || !this.ctx || !this.tex) return;
    this.key = key;
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
const pennantMats = new Map<string, THREE.SpriteMaterial>();
let barBgMat: THREE.SpriteMaterial | null = null;
const barFillMats = new Map<string, THREE.SpriteMaterial>();

function pennantMaterial(color: string, chevron: boolean): THREE.SpriteMaterial {
  const key = `${color}|${chevron}`;
  let m = pennantMats.get(key);
  if (m) return m;
  const c = makeCanvas(64, 64);
  let tex: THREE.Texture | null = null;
  if (c) {
    const g = c.ctx;
    if (chevron) {
      g.fillStyle = color;
      g.strokeStyle = '#0c1a0c';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(8, 14);
      g.lineTo(32, 40);
      g.lineTo(56, 14);
      g.lineTo(56, 28);
      g.lineTo(32, 54);
      g.lineTo(8, 28);
      g.closePath();
      g.stroke();
      g.fill();
    } else {
      g.fillStyle = '#3a2a1a';
      g.fillRect(14, 6, 5, 54);
      g.fillStyle = color;
      g.strokeStyle = '#1a1208';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(19, 8);
      g.lineTo(58, 20);
      g.lineTo(19, 34);
      g.closePath();
      g.fill();
      g.stroke();
    }
    tex = new THREE.CanvasTexture(c.canvas as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
  pennantMats.set(key, m);
  return m;
}

function barMaterials(color: string): { bg: THREE.SpriteMaterial; fill: THREE.SpriteMaterial } {
  if (!barBgMat) barBgMat = new THREE.SpriteMaterial({ color: '#140c08', transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, sizeAttenuation: false });
  let f = barFillMats.get(color);
  if (!f) {
    f = new THREE.SpriteMaterial({ color, depthTest: false, depthWrite: false, sizeAttenuation: false });
    barFillMats.set(color, f);
  }
  return { bg: barBgMat, fill: f };
}

/** Small overhead marker for troops / NPCs: kingdom pennant (or green squad chevron) + HP bar when damaged. */
export class TroopBadge {
  readonly group = new THREE.Group();
  private readonly pennant: THREE.Sprite;
  private readonly bg: THREE.Sprite;
  private readonly fill: THREE.Sprite;
  private color = '';
  private squad = false;

  constructor() {
    this.pennant = new THREE.Sprite(pennantMaterial('#888888', false));
    this.pennant.center.set(0.5, 0);
    this.bg = new THREE.Sprite(barMaterials('#4fc25a').bg);
    this.fill = new THREE.Sprite(barMaterials('#4fc25a').fill);
    this.bg.center.set(0.5, 0.5);
    for (const s of [this.pennant, this.bg, this.fill]) {
      s.renderOrder = 49;
      this.group.add(s);
    }
    this.fill.renderOrder = 50;
  }

  set(kingdomColor: string, squad: boolean, hpFrac: number, showBar: boolean, fovDeg: number, dist: number): void {
    if (kingdomColor !== this.color || squad !== this.squad) {
      this.color = kingdomColor;
      this.squad = squad;
      this.pennant.material = pennantMaterial(squad ? '#5ad07a' : kingdomColor, squad);
    }
    const unit = 2 * Math.tan(((fovDeg * Math.PI) / 180) / 2);
    const k = Math.max(0.6, Math.min(1, 1 - (dist - 10) / 80));
    const ps = 0.028 * unit * k;
    this.pennant.scale.set(ps, ps, 1);
    this.pennant.position.set(0, 0, 0);
    this.bg.visible = this.fill.visible = showBar;
    if (showBar) {
      const bw = 0.05 * unit * k;
      const bh = 0.0065 * unit * k;
      // bars sit just above the pennant: offset in world units scales with distance (sizeAttenuation off)
      this.bg.scale.set(bw * 1.06, bh * 1.8, 1);
      const f = Math.max(0.02, Math.min(1, hpFrac));
      const col = f > 0.6 ? '#4fc25a' : f > 0.3 ? '#e0b030' : '#e04a3a';
      this.fill.material = barMaterials(squad ? '#5ad07a' : col).fill;
      this.fill.scale.set(bw * f, bh, 1);
      this.fill.center.set(0.5 / f, 0.5);
      const lift = dist * ps * 1.15;
      this.bg.position.set(0, lift, 0);
      this.fill.position.set(0, lift, 0);
    }
  }

  dispose(): void {
    /* shared materials are kept for reuse */
  }
}
