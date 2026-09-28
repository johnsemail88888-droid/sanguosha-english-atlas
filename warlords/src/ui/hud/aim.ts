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
  STAT_LABEL,
  adsEase,
  adsZooms,
  aimProfile,
  aimSummary,
  isScopedBow,
  pickupSlot,
  spreadDeg,
  weaponStats,
  type SightKind,
  type WeaponStat,
} from '../../data/weaponFeel';
import { SCOPE_AT, SCOPE_FADE, type AimSnapshot } from '../../game/aimFeel';
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
  /** seconds since your last shot (the lens jolts, the next round chambers) and between shots */
  shotAge: number;
  cycle: number;
  /** first-person camera (third person: near sights show only their lit reticle, iron sights none) */
  firstPerson: boolean;
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
      shotAge: snap.shotAge,
      cycle: snap.cycle,
      firstPerson: snap.firstPerson,
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
    shotAge: 99,
    cycle: def ? 1 / Math.max(0.05, def.fireRate) : 1,
    firstPerson: true,
  };
}

/** Sights that replace the crosshair once they are up (their own reticle marks the aim point). */
const OWN_RETICLE: ReadonlySet<SightKind> = new Set(['iron', 'reddot', 'holo', 'reflex', 'marksman', 'scope']);

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
    // (third person: no iron sights to look along — the crosshair stays)
    const sightUp = aim.blend > 0.55 && OWN_RETICLE.has(aim.sight) && (aim.firstPerson || aim.sight !== 'iron');
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

/** Reflex sight (SMGs): the round window of the sight and one glowing dot. */
const RED_DOT = '<circle r="44" class="glass"/><circle r="44" class="rim"/><circle r="1.7" class="dotc"/>';
/** Wide reflex sight (LMGs): a broad low window, a green chevron over a short range bar with end ticks. */
const REFLEX =
  '<rect x="-48" y="-26" width="96" height="52" rx="12" class="glass"/><rect x="-48" y="-26" width="96" height="52" rx="12" class="rim"/>' +
  '<g class="lit-g"><path d="M-6 5.5 L0 -0.4 L6 5.5" stroke-width="1.6" stroke-linejoin="miter"/>' +
  '<line x1="-17" y1="9" x2="-7" y2="9" stroke-width="1.2"/><line x1="7" y1="9" x2="17" y2="9" stroke-width="1.2"/>' +
  '<line x1="-17" y1="6.5" x2="-17" y2="11.5" stroke-width="1.2"/><line x1="17" y1="6.5" x2="17" y2="11.5" stroke-width="1.2"/></g>';
/** Holographic sight (rifles): a square window, a lit ring with ticks and a centre dot. */
const HOLO =
  '<rect x="-46" y="-34" width="92" height="68" rx="6" class="glass"/><rect x="-46" y="-34" width="92" height="68" rx="6" class="rim"/>' +
  '<g class="lit"><circle r="15" fill="none" stroke-width="1.3"/><line x1="0" y1="-15" x2="0" y2="-19" stroke-width="1.3"/><line x1="0" y1="15" x2="0" y2="19" stroke-width="1.3"/>' +
  '<line x1="-15" y1="0" x2="-19" y2="0" stroke-width="1.3"/><line x1="15" y1="0" x2="19" y2="0" stroke-width="1.3"/><circle r="1.3" class="dotc"/></g>';
/** Iron sights (pistols, crossbows): the rear notch either side, the front post up to the aim point, three white dots. */
const IRON =
  '<g class="metal"><path d="M-30 7 H-6 V30 Q-18 34 -30 30 Z"/><path d="M6 7 H30 V30 Q18 34 6 30 Z"/><path d="M-2.4 0.6 Q0 -0.4 2.4 0.6 V30 H-2.4 Z"/></g>' +
  '<g class="tri"><circle cx="-10.5" cy="10.5" r="1.9"/><circle cx="10.5" cy="10.5" r="1.9"/><circle cx="0" cy="3.2" r="1.7"/></g>';

/** Seconds a scoped shot jolts the lens up. */
const JOLT_TIME = 0.14;
/** The chamber / draw arc shows for weapons slower than this between shots (s): snipers, DMRs, the scoped bow. */
const BOLT_MIN_CYCLE = 0.3;

export class SightOverlay {
  /** the lens overlay (scopes); `.on` while it shows */
  readonly el: HTMLElement;
  /** reflex / holo / iron sights and the bow's draw ring */
  readonly near: HTMLElement;
  /** touch: a button beside the lens that switches the scope's zoom step (the wheel on desktop) */
  readonly zoomBtn: HTMLElement;
  /** the zoom button was tapped (the HUD switches the input's zoom step) */
  onZoomTap: (() => void) | null = null;
  private readonly lens: HTMLElement;
  private readonly blink: HTMLElement;
  private readonly reticle: HTMLElement;
  private readonly zoomTag: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly breathBar: HTMLElement;
  private readonly breathFill: HTMLElement;
  private readonly bolt: HTMLElement;
  private readonly boltArc: SVGCircleElement;
  private readonly boltLbl: HTMLElement;
  private readonly draw: HTMLElement;
  private readonly drawArc: SVGCircleElement;
  private readonly drawLbl: HTMLElement;
  private kind = '';
  private nearKind = '';
  private on = false;
  private opacity = -1;
  private lensXf = '';
  private nearOpacity = -1;
  private hintKey = '';
  private boltKey = '';
  private zoomText = '';
  private zoomBtnOn = false;
  private shownAt = -1;

  constructor() {
    this.reticle = h('div', { class: 'sc-ret' });
    this.zoomTag = h('div', { class: 'sc-zoom' });
    this.hint = h('div', { class: 'sc-hint' });
    this.breathFill = h('i');
    this.breathBar = h('div', { class: 'sc-breath' }, this.breathFill);
    const boltRing = svg('<circle r="18" class="trk"/><circle r="18" class="arc" pathLength="100"/>', '-22 -22 44 44', 'bl-svg');
    this.boltArc = boltRing.querySelector('.arc') as SVGCircleElement;
    this.boltLbl = h('span', { class: 'bl-lbl' });
    this.bolt = h('div', { class: 'sc-bolt' }, boltRing, this.boltLbl);
    this.lens = h('div', { class: 'sc-lens' }, this.reticle, this.zoomTag, this.bolt, this.breathBar, this.hint);
    this.blink = h('div', { class: 'sc-blink' });
    this.el = h('div', { class: 'hud-scope' }, this.lens, this.blink);
    const ring = svg('<circle r="18" class="trk"/><circle r="18" class="arc" pathLength="100"/>', '-22 -22 44 44', 'dr-svg');
    this.drawArc = ring.querySelector('.arc') as SVGCircleElement;
    this.drawLbl = h('div', { class: 'dr-lbl' });
    this.draw = h('div', { class: 'hud-draw' }, ring, this.drawLbl);
    this.near = h('div', { class: 'hud-sight' }, this.draw);
    this.zoomBtn = h('button', { class: 'hud-zoombtn', type: 'button' });
    // (a touch on the look area underneath would turn the view: this one only switches the zoom)
    const tap = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      this.onZoomTap?.();
    };
    this.zoomBtn.addEventListener('pointerdown', tap);
    this.zoomBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }

  /** Returns whether a lens overlay covers the screen (the crosshair / prompts step aside). */
  update(f: HudFrame, aim: AimView): boolean {
    const me = f.me;
    const alive = !!me && !me.dead && !me.downed && !!f.myEnt;
    const def = aim.def;
    const prof = aimProfile(def);
    // ── lens overlay (scope / marksman) ──
    const lensKind = alive && prof.overlay ? aim.sight : '';
    // fades in from SCOPE_AT (the weapon has dropped away, the zoom starts), with a short dark blink
    const o = lensKind ? clamp01((aim.progress - SCOPE_AT) / SCOPE_FADE) : 0;
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
        this.blink.style.opacity = r3(4 * q * (1 - q) * 0.6);
      }
      // a shot kicks the whole scope up for a moment (the view's recoil follows: game/aimFeel.ts)
      const j = aim.shotAge < JOLT_TIME ? 1 - aim.shotAge / JOLT_TIME : 0;
      const xf = `translate(-50%, calc(-50% - ${r3(3 * j * j)}%)) scale(${r3(0.9 + 0.1 * adsEase(q))})`;
      if (xf !== this.lensXf) {
        this.lensXf = xf;
        this.lens.style.transform = xf;
      }
      this.updateLensText(f, aim, prof.holdBreath);
      this.updateBolt(f, aim, def);
    }
    const zoomBtnOn = on && f.touch && aim.zoomSteps > 1;
    if (zoomBtnOn !== this.zoomBtnOn) {
      this.zoomBtnOn = zoomBtnOn;
      setClass(this.zoomBtn, 'on', zoomBtnOn);
    }
    // ── near sights (red dot / holo / wide reflex / iron) and the bow's draw ring (inside the lens on a scoped bow) ──
    const scopedBow = isScopedBow(def);
    const nearKind =
      alive && !prof.overlay && (aim.sight === 'reddot' || aim.sight === 'holo' || aim.sight === 'reflex' || (aim.sight === 'iron' && aim.firstPerson))
        ? aim.sight
        : alive && (aim.sight === 'bow' || scopedBow)
          ? 'bow'
          : '';
    // third person: the reticle floats over the world, without the sight's glass and frame
    setClass(this.near, 'tps', !aim.firstPerson);
    setClass(this.near, 'in-scope', scopedBow);
    if (nearKind !== this.nearKind) {
      this.nearKind = nearKind;
      this.near.dataset.kind = nearKind;
      this.near.querySelector('.ns-svg')?.remove();
      if (nearKind && nearKind !== 'bow') this.near.prepend(svg(nearKind === 'reddot' ? RED_DOT : nearKind === 'holo' ? HOLO : nearKind === 'reflex' ? REFLEX : IRON, '-50 -50 100 100', 'ns-svg'));
    }
    const no = nearKind === 'bow' ? clamp01(aim.progress * 3) : nearKind ? clamp01((aim.blend - 0.45) / 0.4) : 0;
    const nq = Math.round(no * 50) / 50;
    if (nq !== this.nearOpacity) {
      this.nearOpacity = nq;
      this.near.style.opacity = String(nq);
      setClass(this.near, 'on', nq > 0);
    }
    if (nearKind === 'bow' && nq > 0) {
      // the draw fills with the aim (a full draw = aimed spread and full damage) and again after each
      // arrow (nocking the next one takes the bow's shot interval); held too long the arm shakes
      const nock = aim.shotAge < aim.cycle ? clamp01(aim.shotAge / Math.max(0.05, aim.cycle)) : 1;
      const drawn = Math.min(aim.progress, nock);
      const full = drawn >= 0.999;
      const tired = full && aim.drawHeld > prof.fatigueAfter;
      this.drawArc.style.strokeDashoffset = r3(100 - drawn * 100);
      setClass(this.draw, 'full', full && !tired);
      setClass(this.draw, 'tired', tired);
      setText(this.drawLbl, tired ? tx('臂力不支', 'Arm shaking') : full ? tx('满弦', 'Full draw') : nock < 1 ? tx('搭箭', 'Nocking') : '');
    }
    return on && o >= 0.6;
  }

  /** Scoped slow guns / the scoped bow: after a shot an arc fills until the next round (arrow) is ready. */
  private updateBolt(f: HudFrame, aim: AimView, def: WeaponDef | undefined): void {
    // (a bow's own draw ring refills instead: nock, draw, 满弦)
    const busy = !!def && def.class !== 'bow' && aim.cycle >= BOLT_MIN_CYCLE && aim.shotAge < aim.cycle;
    const k = busy ? clamp01(aim.shotAge / aim.cycle) : 1;
    const key = busy ? `${Math.round(k * 40)}|${f.lang}` : '';
    if (key === this.boltKey) return;
    this.boltKey = key;
    setClass(this.bolt, 'on', busy);
    if (!busy) return;
    this.boltArc.style.strokeDashoffset = r3(100 - k * 100);
    setText(this.boltLbl, def?.class === 'bow' ? tx('搭箭', 'Nocking') : tx('上膛', 'Chambering'));
  }

  private updateLensText(f: HudFrame, aim: AimView, holdBreath: boolean): void {
    const zooms = aim.def ? adsZooms(aim.def) : [];
    // the step chosen (not the zoom gliding between steps)
    const z = zooms[aim.zoomIndex] ?? aim.stepZoom;
    const zt = `${Math.round(z * 10) / 10}×`;
    if (zt !== this.zoomText) {
      this.zoomText = zt;
      setText(this.zoomTag, zt);
      setText(this.zoomBtn, zooms.length > 1 ? `${zt} ⇄` : zt);
    }
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
      if (holdBreath && !f.touch) parts.push(tx('Shift 屏息稳枪', 'Shift: hold breath'));
      const steps = zooms.map((x) => `${Math.round(x * 10) / 10}×`).join('/');
      if (zooms.length > 1) parts.push(f.touch ? tx('点 {z} 切换倍率', 'Tap {z} to zoom', { z: zt }) : tx('滚轮 切换 {z}', 'Wheel: {z}', { z: steps }));
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

/** "狙击镜 4× / 8× · 开镜 0.3 秒 · 腰射 ±6° · Shift 屏息" — how this weapon aims (data/weaponFeel.ts aimSummary). */
export function aimLine(def: WeaponDef): string {
  const a = aimSummary(def);
  return tx(a.zh, a.en);
}

/** The aim line as unbreakable parts (a narrow card wraps between "开镜 0.3 秒" and "Shift 屏息", never inside one). */
function aimLineParts(def: WeaponDef): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  aimLine(def)
    .split(' · ')
    .forEach((part, i) => {
      if (i > 0) out.push(' · ');
      out.push(h('span', null, part));
    });
  return out;
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

  /** `aiming`: the sights are up — the card steps aside (the sights and the edge of a lens need the view) */
  update(f: HudFrame, aiming = false): void {
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
    const vis = f.now < this.until && !!me && !me.dead && !me.downed && !aiming;
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
      h('div', { class: 'wst-aim' }, ...aimLineParts(def)),
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
    // (not for a copy of the gun you hold: F takes its ammo, there is nothing to compare)
    const itemId = prompt && ((prompt.kind === 'pickup' && !prompt.ammo) || prompt.kind === 'full') ? prompt.itemId : '';
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
      h('div', { class: 'wst-aim' }, ...aimLineParts(def)),
    );
  }

  relabel(): void {
    this.key = '';
  }
}
