// Aiming on the HUD: the hip-fire crosshair per weapon class sized from the
// sim's own spread (bloom, movement, jumping), hit / knock / kill markers, the
// sight you look through while aiming (iron sights, red dot, holo, a marksman
// or sniper scope with its lens overlay, a bow's draw ring), and the weapon's
// identity: a stat card when a weapon comes into your hands and a stat
// comparison under the pickup prompt (伤害 / 射速 / 射程 / 弹匣 / 精准).
import type { WeaponClass, WeaponDef } from '../../data/types';
import { RARITY_INFO, WEAPON_BY_ID, WEAPON_CLASS_INFO } from '../../data';
import { VF_ADS, VF_AIRBORNE, VF_FIRING, VF_RELOADING } from '../../core/types';
import {
  SIGHT_LABEL,
  STAT_LABEL,
  adsEase,
  adsZooms,
  aimProfile,
  pickupSlot,
  spreadDeg,
  weaponStats,
  zoomLabel,
  type SightKind,
  type WeaponStat,
} from '../../data/weaponFeel';
import type { AimSnapshot } from '../../game/aimFeel';
import { h, setClass, setText } from '../dom';
import { gearName, tx } from '../i18n';
import { RARITY_COLOR } from '../theme';
import { spreadToPx, type InteractPrompt } from './logic';
import type { HudFrame } from './types';
import { viewport } from './viewport';

const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): void {
  if (canAnimate) el.animate(frames, opts);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(markup: string, viewBox: string, cls: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = markup;
  return el;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const r3 = (v: number): string => (Math.round(v * 1000) / 1000).toString();

// ── the local aim as the HUD sees it ─────────────────────────────────────────

/** What the aim widgets read each frame (the input's aim snapshot, or a stand-in from the view flags). */
export interface AimView {
  def: WeaponDef | undefined;
  sight: SightKind;
  progress: number;
  blend: number;
  zoom: number;
  stepZoom: number;
  zoomIndex: number;
  zoomSteps: number;
  scoped: boolean;
  breath: number;
  holding: boolean;
  winded: boolean;
  drawHeld: number;
}

/**
 * The aim this frame: the input controller's snapshot when the game provides
 * one (GameHandle.aim), else derived from the view (VF_ADS → fully aimed at the
 * weapon's first zoom step) — the UI harness and older hosts.
 */
export function aimViewOf(f: HudFrame, snap: Readonly<AimSnapshot> | null | undefined): AimView {
  const me = f.me;
  const w = me ? me.weapons[me.activeSlot] : null;
  const def = w ? WEAPON_BY_ID[w.id] : undefined;
  const prof = aimProfile(def);
  if (snap && (!def || snap.weaponId === def.id)) {
    return {
      def,
      sight: snap.sight,
      progress: snap.progress,
      blend: snap.blend,
      zoom: snap.zoom,
      stepZoom: snap.stepZoom,
      zoomIndex: snap.zoomIndex,
      zoomSteps: snap.zoomSteps,
      scoped: snap.scoped,
      breath: snap.breath,
      holding: snap.holding,
      winded: snap.winded,
      drawHeld: snap.drawHeld,
    };
  }
  const ads = !!(f.myEnt && f.myEnt.flags & VF_ADS) && !!def && !def.melee;
  const zooms = adsZooms(def);
  return {
    def,
    sight: prof.sight,
    progress: ads ? 1 : 0,
    blend: ads ? 1 : 0,
    zoom: ads ? zooms[0]! : 1,
    stepZoom: zooms[0]!,
    zoomIndex: 0,
    zoomSteps: zooms.length,
    scoped: ads && prof.overlay,
    breath: 1,
    holding: false,
    winded: false,
    drawHeld: 0,
  };
}

/** Sights that replace the crosshair once they are up (their own reticle marks the aim point). */
const OWN_RETICLE: ReadonlySet<SightKind> = new Set(['iron', 'reddot', 'holo', 'marksman', 'scope']);

// ── Crosshair (hip fire) ─────────────────────────────────────────────────────

/** Seconds without a shot (trigger released) before the bloom is gone — sim BURST_RESET. */
const BURST_RESET = 0.35;

export class Crosshair {
  readonly el: HTMLElement;
  private style = '';
  private cls = '';
  private gap = -1;
  private hidden = false;
  private burst = 0;
  private lastShot = -99;

  constructor(private readonly fov: () => number) {
    this.el = h('div', { class: 'hud-xhair', data: { style: 'cross' } },
      h('i', { class: 'l t' }), h('i', { class: 'l b' }), h('i', { class: 'l le' }), h('i', { class: 'l r' }),
      h('i', { class: 'dot' }), h('i', { class: 'ring' }), h('i', { class: 'chev' }), h('i', { class: 'drop' }),
    );
  }

  /** A shot of ours left the gun (the 'shot' event): bloom like the sim's burst counter. */
  shot(now: number): void {
    if (now - this.lastShot > BURST_RESET) this.burst = 0;
    this.burst++;
    this.lastShot = now;
  }

  update(f: HudFrame, aim: AimView): void {
    const me = f.me;
    const ent = f.myEnt;
    const def = aim.def;
    const sightUp = aim.blend > 0.55 && OWN_RETICLE.has(aim.sight);
    const hide = !me || me.dead || me.downed || !ent || aim.scoped || sightUp;
    if (hide !== this.hidden) {
      this.hidden = hide;
      setClass(this.el, 'off', hide);
    }
    if (hide || !me || !ent) return;
    const style = aimProfile(def).crosshair;
    if (style !== this.style) {
      this.style = style;
      this.el.dataset.style = style;
    }
    const cls = def?.class ?? '';
    if (cls !== this.cls) {
      this.cls = cls;
      this.el.dataset.cls = cls;
    }
    const firing = !!(ent.flags & VF_FIRING);
    if (!firing && f.now - this.lastShot > BURST_RESET) this.burst = 0;
    // the sim's own cone (data/weaponFeel.ts spreadDeg): what you see is where the pellets / bullets go
    const spread = def
      ? spreadDeg(def, { adsT: aim.progress, moving: ent.speed > 1, airborne: !!(ent.flags & VF_AIRBORNE), burst: this.burst })
      : 2;
    const vfov = this.fov() / Math.max(1, aim.zoom);
    const H = viewport().h;
    const px = Math.max(style === 'circle' ? 12 : style === 'dot' ? 6 : 3, Math.min(H * 0.3, spreadToPx(spread, vfov, H)));
    const g = Math.round(px * 2) / 2;
    if (g !== this.gap) {
      this.gap = g;
      this.el.style.setProperty('--gap', `${g}px`);
    }
    setClass(this.el, 'ads', aim.blend > 0.5);
    setClass(this.el, 'reloading', !!(ent.flags & VF_RELOADING));
  }
}

// ── Hit / knock / kill markers ───────────────────────────────────────────────

export type HitKind = 'hit' | 'head' | 'down' | 'kill';

/** Always on screen (also through a scope): the X flashes on every hit of yours. */
export class HitMarker {
  readonly el: HTMLElement;
  private readonly x: HTMLElement;
  private readonly ring: HTMLElement;

  constructor() {
    this.x = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.ring = h('div', { class: 'hm-ring' });
    this.el = h('div', { class: 'hud-hitmark' }, this.x, this.ring);
  }

  hit(kind: HitKind): void {
    this.x.dataset.kind = kind;
    const big = kind === 'kill' || kind === 'down';
    play(this.x, [
      { opacity: 1, transform: `translate(-50%, -50%) scale(${big ? 1.6 : 1.35}) rotate(45deg)` },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(45deg)', offset: 0.25 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1) rotate(45deg)' },
    ], { duration: kind === 'kill' ? 650 : kind === 'down' ? 480 : 260, easing: 'ease-out' });
    if (big) {
      // a kill / knock: a ring bursts out of the X (red for a kill, orange for a knock)
      this.ring.dataset.kind = kind;
      play(this.ring, [
        { opacity: 0.95, transform: 'translate(-50%, -50%) scale(0.35)' },
        { opacity: 0, transform: `translate(-50%, -50%) scale(${kind === 'kill' ? 1.5 : 1.15})` },
      ], { duration: kind === 'kill' ? 520 : 380, easing: 'ease-out' });
    }
  }
}

// ── Sights (what you look through while aiming) ─────────────────────────────

/** Mil-dot sniper reticle: thick outer posts, fine centre cross, dots every 8 units, a red centre dot. */
function milDotMarkup(): string {
  const dots: string[] = [];
  for (const d of [-32, -24, -16, -8, 8, 16, 24, 32]) {
    dots.push(`<circle cx="${d}" cy="0" r="1.15"/>`, `<circle cx="0" cy="${d}" r="1.15"/>`);
  }
  return (
    '<g stroke="#070707" fill="none" stroke-linecap="butt">' +
    '<line x1="-101" y1="0" x2="-40" y2="0" stroke-width="3.4"/><line x1="40" y1="0" x2="101" y2="0" stroke-width="3.4"/>' +
    '<line x1="0" y1="40" x2="0" y2="101" stroke-width="3.4"/><line x1="0" y1="-101" x2="0" y2="-40" stroke-width="3.4"/>' +
    '<line x1="-40" y1="0" x2="40" y2="0" stroke-width="0.45"/><line x1="0" y1="-40" x2="0" y2="40" stroke-width="0.45"/>' +
    '</g>' +
    `<g fill="#070707">${dots.join('')}</g>` +
    '<circle r="0.85" fill="#ff3a24" class="ctr"/>'
  );
}

/** Marksman (ACOG-like) reticle: a lit amber chevron over a fine drop line with stadia ticks. */
function chevronMarkup(): string {
  const ticks: string[] = [];
  [14, 22, 30, 38].forEach((y, i) => {
    const w = 9 - i * 1.8;
    ticks.push(`<line x1="${-w}" y1="${y}" x2="${w}" y2="${y}"/>`);
  });
  return (
    '<g stroke="#101010" fill="none">' +
    '<line x1="-101" y1="0" x2="-26" y2="0" stroke-width="1.6"/><line x1="26" y1="0" x2="101" y2="0" stroke-width="1.6"/>' +
    '<line x1="0" y1="7" x2="0" y2="44" stroke-width="0.6"/>' +
    `<g stroke-width="0.7">${ticks.join('')}</g>` +
    '</g>' +
    '<path d="M-6.5 6 L0 -0.6 L6.5 6" fill="none" stroke="#ffb42a" stroke-width="1.8" stroke-linejoin="miter" class="chev"/>'
  );
}

/** Reflex sight (SMG / LMG): the round window of the sight and one glowing dot. */
const RED_DOT = '<circle r="44" class="glass"/><circle r="44" class="rim"/><circle r="1.7" class="dotc"/>';
/** Holographic sight (rifles): a square window, a lit ring with ticks and a centre dot. */
const HOLO =
  '<rect x="-46" y="-34" width="92" height="68" rx="6" class="glass"/><rect x="-46" y="-34" width="92" height="68" rx="6" class="rim"/>' +
  '<g class="lit"><circle r="15" fill="none" stroke-width="1.3"/><line x1="0" y1="-15" x2="0" y2="-19" stroke-width="1.3"/><line x1="0" y1="15" x2="0" y2="19" stroke-width="1.3"/>' +
  '<line x1="-15" y1="0" x2="-19" y2="0" stroke-width="1.3"/><line x1="15" y1="0" x2="19" y2="0" stroke-width="1.3"/><circle r="1.3" class="dotc"/></g>';
/** Iron sights (pistols, crossbows): the rear notch either side, the front post up to the aim point, three white dots. */
const IRON =
  '<g class="metal"><path d="M-30 7 H-6 V30 Q-18 34 -30 30 Z"/><path d="M6 7 H30 V30 Q18 34 6 30 Z"/><path d="M-2.4 0.6 Q0 -0.4 2.4 0.6 V30 H-2.4 Z"/></g>' +
  '<g class="tri"><circle cx="-10.5" cy="10.5" r="1.9"/><circle cx="10.5" cy="10.5" r="1.9"/><circle cx="0" cy="3.2" r="1.7"/></g>';

export class SightOverlay {
  /** the lens overlay (scopes); `.on` while it shows */
  readonly el: HTMLElement;
  /** reflex / holo / iron sights and the bow's draw ring */
  readonly near: HTMLElement;
  private readonly lens: HTMLElement;
  private readonly blink: HTMLElement;
  private readonly reticle: HTMLElement;
  private readonly zoomTag: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly breathBar: HTMLElement;
  private readonly breathFill: HTMLElement;
  private readonly draw: HTMLElement;
  private readonly drawArc: SVGCircleElement;
  private readonly drawLbl: HTMLElement;
  private kind = '';
  private nearKind = '';
  private on = false;
  private opacity = -1;
  private nearOpacity = -1;
  private hintKey = '';
  private shownAt = -1;

  constructor() {
    this.reticle = h('div', { class: 'sc-ret' });
    this.zoomTag = h('div', { class: 'sc-zoom' });
    this.hint = h('div', { class: 'sc-hint' });
    this.breathFill = h('i');
    this.breathBar = h('div', { class: 'sc-breath' }, this.breathFill);
    this.lens = h('div', { class: 'sc-lens' }, this.reticle, this.zoomTag, this.breathBar, this.hint);
    this.blink = h('div', { class: 'sc-blink' });
    this.el = h('div', { class: 'hud-scope' }, this.lens, this.blink);
    const ring = svg('<circle r="18" class="trk"/><circle r="18" class="arc" pathLength="100"/>', '-22 -22 44 44', 'dr-svg');
    this.drawArc = ring.querySelector('.arc') as SVGCircleElement;
    this.drawLbl = h('div', { class: 'dr-lbl' });
    this.draw = h('div', { class: 'hud-draw' }, ring, this.drawLbl);
    this.near = h('div', { class: 'hud-sight' }, this.draw);
  }

  /** Returns whether a lens overlay covers the screen (the crosshair / prompts step aside). */
  update(f: HudFrame, aim: AimView): boolean {
    const me = f.me;
    const alive = !!me && !me.dead && !me.downed && !!f.myEnt;
    const def = aim.def;
    const prof = aimProfile(def);
    // ── lens overlay (scope / marksman) ──
    const lensKind = alive && prof.overlay ? aim.sight : '';
    // fades in over the last part of the scope-in (the eye reaching the scope), with a short dark blink
    const o = lensKind ? clamp01((aim.progress - 0.5) / 0.35) : 0;
    const on = o > 0;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
      if (on) this.shownAt = f.now;
    }
    if (on) {
      if (lensKind !== this.kind) {
        this.kind = lensKind;
        this.el.dataset.kind = lensKind;
        this.reticle.replaceChildren(svg(lensKind === 'scope' ? milDotMarkup() : chevronMarkup(), '-100 -100 200 200', 'sc-svg'));
      }
      const q = Math.round(o * 50) / 50;
      if (q !== this.opacity) {
        this.opacity = q;
        this.el.style.opacity = String(q);
        this.lens.style.transform = `translate(-50%, -50%) scale(${r3(0.9 + 0.1 * adsEase(q))})`;
        this.blink.style.opacity = r3(4 * q * (1 - q) * 0.6);
      }
      this.updateLensText(f, aim, prof.holdBreath);
    }
    // ── near sights (red dot / holo / iron) and the bow's draw ring ──
    const nearKind = alive && !prof.overlay && (aim.sight === 'reddot' || aim.sight === 'holo' || aim.sight === 'iron') ? aim.sight : alive && aim.sight === 'bow' ? 'bow' : '';
    if (nearKind !== this.nearKind) {
      this.nearKind = nearKind;
      this.near.dataset.kind = nearKind;
      this.near.querySelector('.ns-svg')?.remove();
      if (nearKind && nearKind !== 'bow') this.near.prepend(svg(nearKind === 'reddot' ? RED_DOT : nearKind === 'holo' ? HOLO : IRON, '-50 -50 100 100', 'ns-svg'));
    }
    const no = nearKind === 'bow' ? clamp01(aim.progress * 3) : nearKind ? clamp01((aim.blend - 0.45) / 0.4) : 0;
    const nq = Math.round(no * 50) / 50;
    if (nq !== this.nearOpacity) {
      this.nearOpacity = nq;
      this.near.style.opacity = String(nq);
      setClass(this.near, 'on', nq > 0);
    }
    if (nearKind === 'bow' && nq > 0) {
      // the draw fills with the aim (a full draw = aimed spread); held too long the arm shakes
      const full = aim.progress >= 0.999;
      const tired = full && aim.drawHeld > prof.fatigueAfter;
      this.drawArc.style.strokeDashoffset = r3(100 - aim.progress * 100);
      setClass(this.draw, 'full', full && !tired);
      setClass(this.draw, 'tired', tired);
      setText(this.drawLbl, tired ? tx('臂力不支', 'Arm shaking') : full ? tx('满弦', 'Full draw') : '');
    }
    return on && o >= 0.6;
  }

  private updateLensText(f: HudFrame, aim: AimView, holdBreath: boolean): void {
    const z = Math.round(aim.stepZoom * 10) / 10;
    const zooms = aim.def ? adsZooms(aim.def) : [];
    const zt = `${z}×`;
    setText(this.zoomTag, zt);
    // the hint fades out after a few seconds of every scope-in
    const fresh = f.now - this.shownAt < 3.5;
    let key = '';
    let text = '';
    if (aim.winded) {
      key = 'winded';
      text = tx('气息紊乱…', 'Out of breath…');
    } else if (aim.holding) {
      key = 'hold';
      text = tx('屏息中', 'Holding breath');
    } else if (fresh) {
      const parts: string[] = [];
      if (holdBreath) parts.push(tx('Shift 屏息稳枪', 'Shift: hold breath'));
      if (zooms.length > 1 && !f.touch) parts.push(tx('滚轮 切换 {z}', 'Wheel: {z}', { z: zooms.map((x) => `${Math.round(x * 10) / 10}×`).join('/') }));
      key = `tip|${parts.join('|')}`;
      text = parts.join(' · ');
    }
    if (key + f.lang !== this.hintKey) {
      this.hintKey = key + f.lang;
      setText(this.hint, text);
      setClass(this.hint, 'warn', key === 'winded');
    }
    const showBreath = holdBreath && (aim.holding || aim.winded || aim.breath < 0.999);
    setClass(this.breathBar, 'on', showBreath);
    if (showBreath) {
      this.breathFill.style.transform = `scaleX(${r3(clamp01(aim.breath))})`;
      setClass(this.breathBar, 'low', aim.breath < 0.3 || aim.winded);
    }
  }
}

// ── Weapon identity: class icon, stat bars, stat card, pickup comparison ────

/** Tiny class silhouettes (viewBox 0 0 48 20, currentColor). */
const CLASS_ICON: Readonly<Record<WeaponClass, string>> = {
  pistol: '<path d="M9 5h26v5H21l-3 8h-7l3-8H9z"/>',
  smg: '<path d="M8 7h26v4h-8v1h-4l-1 6h-4l1-6h-2l-2 5H9l1-5H8z"/><path d="M34 8h9v2h-9z"/><path d="M2 7h6v3l-5 3H2z"/>',
  rifle: '<path d="M11 7h25v4H28l1 6h-4l-1-6h-4l-2 5h-4l1-5h-4z"/><path d="M36 8h11v1.6H36z"/><path d="M1 8l10-1v4l-9 3z"/>',
  dmr: '<path d="M11 8h25v3.5H18l-2 5h-4l1-5h-2z"/><path d="M36 8.8h11v1.4H36z"/><path d="M1 8.5l10-.5v3.5l-9 3z"/><path d="M16 3.5h14v3H16z"/><path d="M22 11.5h3v3h-3z"/>',
  sniper: '<path d="M10 8.5h28v3H17l-2 5h-4l1-5h-2z"/><path d="M38 9.2h10v1.2H38z"/><path d="M1 8.5l9 0v3l-7 4H1z"/><path d="M14 3h18v3.4H14z"/><path d="M13 3.6h2v2.2h-2zM31 3.6h2v2.2h-2z"/><path d="M36 11.5l1-.2 2.4 6.6-1 .3z"/>',
  lmg: '<path d="M8 6h28v6H8z"/><path d="M36 8h12v2H36z"/><path d="M1 7l7-1v6l-6 2z"/><path d="M17 12h11v6H17z"/><path d="M40 10l1-.3 2.5 7.4-1 .3z"/>',
  shotgun: '<path d="M12 7h35v3H12z"/><path d="M29 10h10v3H29z"/><path d="M1 8l11-1v4l-10 3z"/><path d="M14 10h4l-2 6h-4z"/>',
  bow: '<path d="M16 1.5Q34 10 16 18.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M16 1.5V18.5" stroke="currentColor" stroke-width="0.7"/><path d="M6 9.3h36v1.4H6z"/><path d="M42 7.5l5 2.5-5 2.5z"/>',
  crossbow: '<path d="M4 9h32v3H4z"/><path d="M30 1.5Q37 10.5 30 19.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M36 9.8h10v1.4H36z"/><path d="M12 12h4l-2 6h-4z"/>',
  launcher: '<path d="M4 6h38v6H4z"/><path d="M42 5h5v8h-5z"/><path d="M17 12h4l-1 6h-4z"/><path d="M26 12h3v4h-3z"/>',
  flamer: '<circle cx="9" cy="11" r="6.5"/><path d="M15 8.5h24v3H15z"/><path d="M39 7.5h4l3 2.5-3 2.5h-4z"/><path d="M20 11.5h4l-1 6h-4z"/>',
  melee: '<path d="M3 9.2L34 7.5l12 2.5-12 2.5L3 10.8z"/><path d="M8 5h2.4v10H8z"/>',
};

export function classIcon(cls: WeaponClass | undefined, extra = ''): SVGSVGElement {
  return svg(CLASS_ICON[cls ?? 'rifle'] ?? CLASS_ICON.rifle, '0 0 48 20', `wst-icon${extra ? ` ${extra}` : ''}`);
}

export function className(cls: WeaponClass | undefined): string {
  const i = WEAPON_CLASS_INFO[cls ?? 'rifle'];
  return i ? tx(i.nameZh, i.nameEn) : '';
}

function statRows(def: WeaponDef, vs: WeaponDef | undefined): HTMLElement[] {
  const cur = vs ? weaponStats(vs) : null;
  return weaponStats(def).map((s: WeaponStat, i) => {
    const o = cur?.[i];
    let delta: HTMLElement | null = null;
    if (o && Math.abs(s.raw - o.raw) > 1e-6 * Math.max(1, Math.abs(o.raw))) {
      const up = s.raw > o.raw;
      delta = h('b', { class: `wst-d ${up ? 'up' : 'dn'}` }, up ? '▲' : '▼');
    }
    const fill = h('i');
    fill.style.transform = `scaleX(${r3(Math.max(0.04, s.bar))})`;
    const ghost = h('u');
    if (o) ghost.style.transform = `scaleX(${r3(Math.max(0.04, o.bar))})`;
    return h('div', { class: 'wst-row', data: { k: s.key } },
      h('span', { class: 'wst-lbl' }, tx(STAT_LABEL[s.key].zh, STAT_LABEL[s.key].en)),
      h('span', { class: 'wst-bar' }, o ? ghost : null, fill),
      h('span', { class: 'wst-val' }, s.value),
      delta,
    );
  });
}

/** "狙击镜 4× / 8× · 开镜 0.3 秒" — how this weapon aims. */
export function aimLine(def: WeaponDef): string {
  const p = aimProfile(def);
  const sight = tx(SIGHT_LABEL[p.sight].zh, SIGHT_LABEL[p.sight].en);
  const secs = (Math.round(p.adsTime * 100) / 100).toString();
  const zoom = def.adsZoom > 1.001 ? ` ${zoomLabel(def)}` : '';
  const extra = p.holdBreath ? tx(' · Shift 屏息', ' · Shift: hold breath') : p.sight === 'bow' ? tx(' · 按住右键拉弓', ' · hold RMB to draw') : '';
  return tx(`${sight}${zoom} · 开镜 ${secs} 秒${extra}`, `${sight}${zoom} · aim ${secs} s${extra}`);
}

/**
 * Stat card of the weapon that just came into your hands (pickup, switch,
 * spawn): class, rarity, the five bars and how it aims — for a few seconds,
 * above the weapon panel.
 */
export class WeaponCard {
  readonly el: HTMLElement;
  private shownId = '';
  private until = 0;
  private visible = false;
  private langKey = '';

  constructor() {
    this.el = h('div', { class: 'hud-wcard' });
  }

  update(f: HudFrame): void {
    const me = f.me;
    const w = me && !me.dead ? me.weapons[me.activeSlot] : null;
    const id = w?.id ?? '';
    if (id !== this.shownId) {
      this.shownId = id;
      const def = id ? WEAPON_BY_ID[id] : undefined;
      if (def && !def.melee) {
        this.render(def);
        this.until = f.now + 4.5;
      } else this.until = 0;
    } else if (this.visible && id && f.lang !== this.langKey) {
      const def = WEAPON_BY_ID[id];
      if (def) this.render(def);
    }
    this.langKey = f.lang;
    const vis = f.now < this.until && !!me && !me.dead && !me.downed;
    if (vis !== this.visible) {
      this.visible = vis;
      setClass(this.el, 'on', vis);
    }
  }

  private render(def: WeaponDef): void {
    const rar = RARITY_INFO[def.rarity];
    this.el.style.setProperty('--rc', RARITY_COLOR[def.rarity] ?? '#b9b2a2');
    this.el.replaceChildren(
      h('div', { class: 'wst-head' },
        classIcon(def.class),
        h('span', { class: 'wst-cls' }, className(def.class)),
        def.lootable ? h('span', { class: 'wst-rar' }, rar ? tx(rar.nameZh, rar.nameEn) : '') : h('span', { class: 'wst-rar' }, tx('专属', 'Signature')),
      ),
      h('div', { class: 'wst-name' }, gearName(def.id), def.sgsCard ? h('span', { class: 'wst-card' }, `〔${def.sgsCard}〕`) : null),
      h('div', { class: 'wst-stats' }, ...statRows(def, undefined)),
      h('div', { class: 'wst-aim' }, aimLine(def)),
    );
  }

  /** Language switched: rebuild on the next frame. */
  relabel(): void {
    this.langKey = '';
  }
}

/**
 * Under the F prompt of a weapon on the ground: its class and the five stats
 * against the weapon it would replace (▲ better / ▼ worse, the current bar as
 * a ghost behind the new one).
 */
export class LootCompare {
  readonly el: HTMLElement;
  private key = '';

  constructor() {
    this.el = h('div', { class: 'hud-lootcmp' });
  }

  update(f: HudFrame, prompt: InteractPrompt | null, aiming: boolean): void {
    const me = f.me;
    const itemId = prompt && (prompt.kind === 'pickup' || prompt.kind === 'full') ? prompt.itemId : '';
    const def = itemId ? WEAPON_BY_ID[itemId] : undefined;
    const slot = def && me ? pickupSlot(def, me.weapons[0]?.id) : 0;
    const vsId = def && me ? (me.weapons[slot]?.id ?? '') : '';
    // (not while aiming: the sights need the middle of the screen)
    const key = def && !aiming && !f.touch ? `${def.id}|${vsId}|${f.lang}` : '';
    if (key === this.key) return;
    this.key = key;
    setClass(this.el, 'on', !!key);
    if (!key || !def) {
      this.el.replaceChildren();
      return;
    }
    const vs = vsId ? WEAPON_BY_ID[vsId] : undefined;
    this.el.style.setProperty('--rc', RARITY_COLOR[def.rarity] ?? '#b9b2a2');
    this.el.replaceChildren(
      h('div', { class: 'wst-head' },
        classIcon(def.class),
        h('span', { class: 'wst-cls' }, className(def.class)),
        vs ? h('span', { class: 'wst-vs' }, tx(`对比 ${gearName(vs.id)}`, `vs ${gearName(vs.id)}`)) : null,
      ),
      h('div', { class: 'wst-stats' }, ...statRows(def, vs)),
      h('div', { class: 'wst-aim' }, aimLine(def)),
    );
  }

  relabel(): void {
    this.key = '';
  }
}
