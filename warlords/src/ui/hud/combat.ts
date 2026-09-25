// Combat feedback: crosshair (per weapon class, spread-aware), hit markers,
// floating damage numbers, damage direction arcs, sniper scope, interaction
// prompt, channel bar, downed overlay, spectate bar, outside-zone warning.
import type { EntityId, Vec3 } from '../../core/types';
import { VF_ADS, VF_AIRBORNE, VF_FIRING, VF_RELOADING } from '../../core/types';
import { HERO_BY_ID, ITEM_BY_ID, WEAPON_BY_ID } from '../../data';
import { h, setClass, setText } from '../dom';
import { gearName, getLang, heroName, t, tx, type I18nKey } from '../i18n';
import { displayName } from '../../game/names';
import { CRATE_NAME } from '../theme';
import { crosshairStyle, deriveInteract, distanceOutsideZone, relativeBearing, spreadToPx, type InteractPrompt } from './logic';
import type { HudFrame } from './types';
import { viewport } from './viewport';
import type { PortraitCache } from '../widgets';

const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): void {
  if (canAnimate) el.animate(frames, opts);
}

// ── Crosshair + hit marker ───────────────────────────────────────────────────

export class Crosshair {
  readonly el: HTMLElement;
  private readonly marker: HTMLElement;
  private style = '';
  private gap = -1;
  private bloom = 0;
  private hidden = false;

  constructor(private readonly fov: () => number) {
    this.marker = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.el = h('div', { class: 'hud-xhair', data: { style: 'cross' } },
      h('i', { class: 'l t' }), h('i', { class: 'l b' }), h('i', { class: 'l le' }), h('i', { class: 'l r' }),
      h('i', { class: 'dot' }), h('i', { class: 'ring' }), h('i', { class: 'chev' }), h('i', { class: 'drop' }),
      this.marker,
    );
  }

  update(f: HudFrame, scoped: boolean): void {
    const me = f.me;
    const ent = f.myEnt;
    const hide = !me || me.dead || me.downed || scoped || !ent;
    if (hide !== this.hidden) {
      this.hidden = hide;
      setClass(this.el, 'off', hide);
    }
    if (hide || !me || !ent) return;
    const w = me.weapons[me.activeSlot];
    const def = w ? WEAPON_BY_ID[w.id] : undefined;
    const style = crosshairStyle(def?.class);
    if (style !== this.style) {
      this.style = style;
      this.el.dataset.style = style;
    }
    const ads = !!(ent.flags & VF_ADS);
    const firing = !!(ent.flags & VF_FIRING);
    if (firing) this.bloom = Math.min(1.6, this.bloom + f.dt * (def ? def.recoil * 2.2 : 1.5));
    else this.bloom = Math.max(0, this.bloom - f.dt * 2.5);
    let spread = def ? (ads ? def.spreadAds : def.spreadHip) : 2;
    spread *= 1 + this.bloom * 0.6;
    if (ent.speed > 0.6) spread *= ads ? 1.15 : 1.35;
    if (ent.flags & VF_AIRBORNE) spread *= 1.6;
    const vfov = this.fov() / (ads && def ? def.adsZoom : 1);
    const H = viewport().h;
    const px = Math.max(style === 'circle' ? 14 : 4, Math.min(H * 0.22, spreadToPx(spread, vfov, H)));
    const g = Math.round(px * 2) / 2;
    if (g !== this.gap) {
      this.gap = g;
      this.el.style.setProperty('--gap', `${g}px`);
    }
    setClass(this.el, 'ads', ads);
    setClass(this.el, 'reloading', !!(ent.flags & VF_RELOADING));
  }

  hit(kind: 'hit' | 'head' | 'kill'): void {
    this.marker.dataset.kind = kind;
    play(this.marker, [
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.35) rotate(45deg)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(45deg)', offset: 0.25 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1) rotate(45deg)' },
    ], { duration: kind === 'kill' ? 520 : 260, easing: 'ease-out' });
  }
}

// ── Kill stamp (斩) ───────────────────────────────────────────────────────────

export class KillStamp {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly face: HTMLElement;
  /** `portraits`: the victim's painted face under the seal when the art ships */
  constructor(private readonly portraits: PortraitCache | null = null) {
    this.label = h('span', { class: 'lbl' });
    this.face = h('span', { class: 'ks-face' });
    this.el = h('div', { class: 'hud-killstamp' }, h('span', { class: 'sg-seal', style: '--sz:3.2em' }, h('span', null, '斩')), this.face, this.label);
  }
  show(victim: string, heroId?: string): void {
    this.label.textContent = victim;
    const pc = this.portraits;
    if (heroId && pc?.hasArt(heroId)) this.face.replaceChildren(pc.avatar(heroId));
    else this.face.replaceChildren();
    play(this.el, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(2.2) rotate(-12deg)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(-6deg)', offset: 0.18 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(-6deg)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.95) rotate(-6deg)' },
    ], { duration: 1500, easing: 'ease-out' });
  }
}

// ── Damage numbers ───────────────────────────────────────────────────────────

interface Floater {
  outer: HTMLElement;
  inner: HTMLElement;
  world: Vec3 | null;
  until: number;
  x: number;
  y: number;
}

export type DamageKind = 'normal' | 'head' | 'squad' | 'blocked' | 'heal' | 'crit';

export class DamageNumbers {
  readonly el: HTMLElement;
  private readonly pool: Floater[] = [];
  private next = 0;

  constructor(private readonly project: ((p: Vec3) => { x: number; y: number } | null) | undefined) {
    this.el = h('div', { class: 'hud-dmg' });
    for (let i = 0; i < 24; i++) {
      const inner = h('span', { class: 'n' });
      const outer = h('span', { class: 'f' }, inner);
      this.el.appendChild(outer);
      this.pool.push({ outer, inner, world: null, until: 0, x: 0, y: 0 });
    }
  }

  spawn(text: string, kind: DamageKind, world: Vec3 | null, now: number): void {
    const f = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    f.inner.textContent = text;
    f.inner.className = `n ${kind}`;
    f.until = now + 0.9;
    const { w: W, h: H } = viewport();
    const p = world && this.project ? this.project(world) : null;
    if (p) {
      f.world = world;
      f.x = p.x + (Math.random() - 0.5) * 24;
      f.y = p.y - 10;
    } else {
      f.world = null;
      // near the crosshair, fanned out to the upper right
      f.x = W / 2 + 26 + Math.random() * 46;
      f.y = H / 2 - 24 - Math.random() * 40;
    }
    f.outer.style.transform = `translate(${Math.round(f.x)}px, ${Math.round(f.y)}px)`;
    f.outer.style.visibility = 'visible';
    const big = kind === 'head' || kind === 'crit';
    play(f.inner, [
      { opacity: 0, transform: `translate(-50%, 0) scale(${big ? 1.7 : 1.3})` },
      { opacity: 1, transform: 'translate(-50%, -6px) scale(1)', offset: 0.15 },
      { opacity: 1, transform: 'translate(-50%, -22px) scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'translate(-50%, -34px) scale(0.9)' },
    ], { duration: 900, easing: 'ease-out', fill: 'forwards' });
  }

  update(now: number): void {
    for (const f of this.pool) {
      if (!f.until) continue;
      if (now > f.until) {
        f.until = 0;
        f.world = null;
        f.outer.style.visibility = 'hidden';
        continue;
      }
      if (f.world && this.project) {
        const p = this.project(f.world);
        if (p) f.outer.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - 10)}px)`;
      }
    }
  }
}

// ── Damage direction ─────────────────────────────────────────────────────────

export class DamageDirection {
  readonly el: HTMLElement;
  private readonly arcs: { el: HTMLElement; src: Vec3; until: number }[] = [];
  private next = 0;

  constructor() {
    this.el = h('div', { class: 'hud-dmgdir' });
    for (let i = 0; i < 4; i++) {
      const el = h('i');
      this.el.appendChild(el);
      this.arcs.push({ el, src: { x: 0, y: 0, z: 0 }, until: 0 });
    }
  }

  add(src: Vec3, now: number): void {
    const a = this.arcs[this.next];
    this.next = (this.next + 1) % this.arcs.length;
    a.src = { ...src };
    a.until = now + 1.3;
    play(a.el, [{ opacity: 0.95 }, { opacity: 0.95, offset: 0.4 }, { opacity: 0 }], { duration: 1300, easing: 'ease-in', fill: 'forwards' });
  }

  update(f: HudFrame): void {
    const ent = f.myEnt;
    for (const a of this.arcs) {
      if (!a.until) continue;
      if (f.now > a.until || !ent) {
        a.until = 0;
        a.el.style.opacity = '0';
        continue;
      }
      const ang = relativeBearing(ent.x, ent.z, ent.yaw, a.src.x, a.src.z);
      a.el.style.transform = `translate(-50%, -50%) rotate(${Math.round((ang * 180) / Math.PI)}deg)`;
    }
  }
}

// ── Sniper scope ─────────────────────────────────────────────────────────────

export class Scope {
  readonly el: HTMLElement;
  private on = false;
  constructor() {
    this.el = h('div', { class: 'hud-scope' }, h('div', { class: 'lens' }, h('i', { class: 'h' }), h('i', { class: 'v' }), h('i', { class: 'ticks' })));
  }
  /** returns whether the scope is showing */
  update(f: HudFrame): boolean {
    const me = f.me;
    const ent = f.myEnt;
    let on = false;
    if (me && ent && !me.dead && !me.downed && ent.flags & VF_ADS) {
      const w = me.weapons[me.activeSlot];
      const def = w ? WEAPON_BY_ID[w.id] : undefined;
      on = !!def && def.adsZoom >= 3;
    }
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
    }
    return on;
  }
}

// ── Interaction prompt + channel bar ─────────────────────────────────────────

export function interactText(p: InteractPrompt, lang: 'zh' | 'en'): { key: string; text: string; sub: string } {
  switch (p.kind) {
    case 'revive':
      return { key: '', text: t('hud.interact.revive', { name: `${heroName(p.heroId)}${p.name && p.name !== p.heroId ? `·${displayName(p.name, getLang())}` : ''}` }), sub: p.needPeach ? t('hud.interact.needPeach') : '' };
    case 'airdrop':
      return { key: 'F', text: t('hud.interact.airdrop'), sub: '' };
    case 'crate': {
      const n = CRATE_NAME[p.tier];
      return { key: 'F', text: `${tx('打开', 'Open')}${lang === 'en' ? ' ' : ''}${lang === 'en' ? n.en.toLowerCase() : n.zh}`, sub: '' };
    }
    case 'pickup':
      return { key: 'F', text: p.swap ? t('hud.interact.swap', { name: gearName(p.itemId) }) : t('hud.interact.pickup', { name: gearName(p.itemId) }), sub: '' };
    case 'full':
      return { key: '', text: gearName(p.itemId), sub: tx('锦囊栏已满', 'Item slots full') };
    case 'selfRevive':
      return { key: '', text: t('hud.interact.selfRevive', { key: String(4 + p.slot) }), sub: '' };
  }
}

export class InteractPromptView {
  readonly el: HTMLElement;
  private readonly keyEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private key = '';

  constructor(private readonly onTap?: () => void) {
    this.keyEl = h('span', { class: 'sg-key' });
    this.textEl = h('span', { class: 'txt' });
    this.subEl = h('span', { class: 'sub' });
    this.el = h('div', { class: 'hud-interact off' }, this.keyEl, this.textEl, this.subEl);
    this.el.addEventListener('click', () => this.onTap?.());
  }

  update(f: HudFrame): InteractPrompt | null {
    const derived = deriveInteract(f.me, f.myEnt, f.ents);
    // the downed overlay already explains self-revive
    const p = derived?.kind === 'selfRevive' ? null : derived;
    const k = p ? `${p.kind}|${'targetId' in p ? p.targetId : ''}|${'itemId' in p ? p.itemId : ''}|${p.kind === 'revive' ? p.needPeach : ''}|${f.lang}|${f.touch}` : '';
    if (k !== this.key) {
      this.key = k;
      setClass(this.el, 'off', !p);
      if (p) {
        const txt = interactText(p, f.lang);
        const keyLabel = f.touch ? '' : txt.key;
        setText(this.keyEl, keyLabel);
        setClass(this.keyEl, 'sg-hidden', !keyLabel);
        setText(this.textEl, txt.text);
        setText(this.subEl, txt.sub);
        setClass(this.subEl, 'sg-hidden', !txt.sub);
        setClass(this.el, 'warn', p.kind === 'full' || (p.kind === 'revive' && p.needPeach));
      }
    }
    return p;
  }

  relabel(): void {
    this.key = '';
  }
}

export class ChannelBar {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly fill: HTMLElement;
  private kind = '';
  constructor() {
    this.label = h('span', { class: 'lbl' });
    this.fill = h('i');
    this.el = h('div', { class: 'hud-channel off' }, this.label, h('div', { class: 'track' }, this.fill));
  }
  update(f: HudFrame): void {
    const ch = f.me && !f.me.dead ? f.me.channel : null;
    const kind = ch ? `${ch.kind}|${f.lang}` : '';
    if (kind !== this.kind) {
      this.kind = kind;
      setClass(this.el, 'off', !ch);
      if (ch) setText(this.label, t(`hud.channel.${ch.kind}` as I18nKey));
    }
    if (ch) this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ch.progress)).toFixed(3)})`;
  }
  relabel(): void {
    this.kind = '';
  }
}

// ── Downed overlay ───────────────────────────────────────────────────────────

const BLEED_TOTAL = 12;

export class DownedOverlay {
  readonly el: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly hint: HTMLElement;
  private readonly title: HTMLElement;
  private on = false;
  private secs = -1;
  private hintKey = '';

  constructor() {
    this.timer = h('b', { class: 'secs' });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 60 60');
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('class', 'bg');
    this.ring = document.createElementNS(NS, 'circle');
    this.ring.setAttribute('class', 'fg');
    for (const c of [bg, this.ring]) {
      c.setAttribute('cx', '30');
      c.setAttribute('cy', '30');
      c.setAttribute('r', '26');
      svg.appendChild(c);
    }
    this.ring.setAttribute('stroke-dasharray', String(2 * Math.PI * 26));
    this.hint = h('div', { class: 'hint' });
    this.title = h('div', { class: 'ttl' }, t('hud.downed'));
    this.el = h('div', { class: 'hud-downed' }, h('div', { class: 'vignette' }), h('div', { class: 'box' }, this.title, h('div', { class: 'ringwrap' }, svg, this.timer), this.hint));
  }

  update(f: HudFrame): void {
    const me = f.me;
    const on = !!me && me.downed && !me.dead;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
    }
    if (!on || !me) return;
    const rem = Math.max(0, me.downedRemaining);
    const secs = Math.ceil(rem);
    if (secs !== this.secs) {
      this.secs = secs;
      setText(this.timer, String(secs));
    }
    this.ring.setAttribute('stroke-dashoffset', ((2 * Math.PI * 26) * (1 - Math.min(1, rem / BLEED_TOTAL))).toFixed(1));
    const jiu = me.items.findIndex((it) => it?.id === 'jiu');
    const hk = `${jiu}|${f.lang}`;
    if (hk !== this.hintKey) {
      this.hintKey = hk;
      setText(this.hint, jiu >= 0 ? t('hud.interact.selfRevive', { key: String(4 + jiu) }) : t('hud.downedHint'));
      setText(this.title, t('hud.downed'));
    }
  }

  relabel(): void {
    this.hintKey = '';
  }
}

// ── Death / spectate bar ─────────────────────────────────────────────────────

/** Who killed you: an entity (translated when shown, in the current language) or the zone. */
export type KillerRef = { entityId: EntityId } | { zone: true } | null;

export class SpectateBar {
  readonly el: HTMLElement;
  private readonly killerEl: HTMLElement;
  private readonly killerText: HTMLElement;
  private readonly killerFace: HTMLElement;
  private readonly targetEl: HTMLElement;
  private readonly targetText: HTMLElement;
  private readonly targetFace: HTMLElement;
  private readonly titleEl: HTMLElement;
  private on = false;
  private dirty = true;
  private shownKiller: KillerRef = null;
  private shownKillerHero: string | null = null;
  private shownTarget = -1;
  private shownLang = '';
  /** a new reference per death (hud.ts): the name is rendered (and re-rendered) in the current language */
  killer: KillerRef = null;
  /** the killer's hero (for its painted face) */
  killerHero: string | null = null;

  /**
   * `label(id)` names an entity as "hero·player" in the current language (null = unknown);
   * `portraits`: painted faces of the killer and the spectated hero when the art ships
   */
  constructor(
    private readonly cycle: (dir: 1 | -1) => void,
    private readonly label: (id: EntityId) => string | null = () => null,
    private readonly portraits: PortraitCache | null = null,
  ) {
    this.killerText = h('span');
    this.killerFace = h('span', { class: 'face' });
    this.killerEl = h('div', { class: 'killer' }, this.killerFace, this.killerText);
    this.targetText = h('span');
    this.targetFace = h('span', { class: 'face' });
    this.targetEl = h('span', { class: 'target' }, this.targetFace, this.targetText);
    this.titleEl = h('div', { class: 'dead-title' }, t('hud.dead'));
    const prev = h('button', { class: 'sg-btn small dark', type: 'button', title: t('hud.prev') }, '◀');
    const next = h('button', { class: 'sg-btn small dark', type: 'button', title: t('hud.next') }, '▶');
    prev.addEventListener('click', () => this.cycle(-1));
    next.addEventListener('click', () => this.cycle(1));
    this.el = h('div', { class: 'hud-spectate' }, this.titleEl, this.killerEl, h('div', { class: 'spec' }, prev, this.targetEl, next));
  }

  update(f: HudFrame): void {
    const on = !!f.me?.dead;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
    }
    if (!on) return;
    // per frame while dead: compare fields instead of building a key string
    let target: HudFrame['players'][number] | undefined;
    for (const p of f.players) {
      if (p.entityId === f.spectateId) {
        target = p;
        break;
      }
    }
    const targetId = target ? target.entityId : -1;
    const kr = this.killer;
    if (!this.dirty && this.shownKiller === kr && this.shownKillerHero === this.killerHero && this.shownTarget === targetId && this.shownLang === f.lang) return;
    this.dirty = false;
    this.shownKiller = kr;
    this.shownKillerHero = this.killerHero;
    this.shownTarget = targetId;
    this.shownLang = f.lang;
    setText(this.titleEl, t('hud.dead'));
    const killerName = !kr ? '' : 'zone' in kr ? t('hud.zoneDeath') : this.label(kr.entityId) ?? '';
    setText(this.killerText, killerName ? t('hud.killedBy', { name: killerName }) : '');
    setClass(this.killerEl, 'sg-hidden', !killerName);
    this.face(this.killerFace, kr && !('zone' in kr) ? this.killerHero : null);
    setText(this.targetText, target ? t('hud.spectating', { name: `${heroName(target.heroId)}·${displayName(target.name, f.lang)}` }) : '—');
    this.face(this.targetFace, target?.heroId ?? null);
  }

  private face(slot: HTMLElement, heroId: string | null): void {
    const pc = this.portraits;
    const id = heroId && pc?.hasArt(heroId) ? heroId : '';
    if (slot.dataset.hero === id) return;
    slot.dataset.hero = id;
    slot.replaceChildren(...(id && pc ? [pc.avatar(id)] : []));
  }

  relabel(): void {
    this.dirty = true;
  }
}

// ── Outside-zone warning ─────────────────────────────────────────────────────

export class ZoneWarning {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly dist: HTMLElement;
  private readonly arrow: HTMLElement;
  private on = false;
  private key = '';

  constructor() {
    this.text = h('span', { class: 'txt' });
    this.dist = h('span', { class: 'dist' });
    this.arrow = h('i', { class: 'arrow' }, '▲');
    this.el = h('div', { class: 'hud-zonewarn' }, this.arrow, h('div', null, this.text, this.dist));
  }

  update(f: HudFrame): void {
    const ent = f.myEnt;
    const me = f.me;
    const out = !!ent && !!me && !me.dead ? distanceOutsideZone(ent.x, ent.z, f.zone) : 0;
    const on = out > 0.5 && f.zone.dps > 0;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
    }
    if (!on || !ent) return;
    const k = `${Math.ceil(out)}|${f.zone.dps}|${f.lang}`;
    if (k !== this.key) {
      this.key = k;
      setText(this.text, t('hud.zone.outside', { dps: f.zone.dps }));
      setText(this.dist, t('hud.zone.distance', { m: Math.ceil(out) }));
    }
    const ang = relativeBearing(ent.x, ent.z, ent.yaw, f.zone.center.x, f.zone.center.z);
    this.arrow.style.transform = `rotate(${Math.round((ang * 180) / Math.PI)}deg)`;
  }

  relabel(): void {
    this.key = '';
  }
}

/** Item name for pickup toasts. */
export function pickupName(id: string): string {
  const it = ITEM_BY_ID[id];
  return it ? tx(it.nameZh, it.nameEn) : gearName(id);
}

export function heroNameOf(id: string | undefined): string {
  return id && HERO_BY_ID[id] ? heroName(id) : id ?? '';
}

// ── 决斗 indicator ────────────────────────────────────────────────────────────

/** abilityState keys the sim sets on both duellists (sim/items/tricks.ts) */
export const DUEL_VS_KEY = 'item:juedou:vs';
export const DUEL_UNTIL_KEY = 'item:juedou:until';

/** The running duel of `me` (opponent id + seconds left), or null. */
export function duelState(me: { abilityState: Record<string, number> } | null | undefined, elapsed: number): { vs: EntityId; secs: number } | null {
  const st = me?.abilityState;
  if (!st) return null;
  const vs = st[DUEL_VS_KEY];
  const until = st[DUEL_UNTIL_KEY];
  if (typeof vs !== 'number' || typeof until !== 'number') return null;
  const secs = until - elapsed;
  return secs > 0 ? { vs, secs } : null;
}

export class DuelBar {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  private readonly secs: HTMLElement;
  private key = '';

  constructor(private readonly label: (id: EntityId) => string | null) {
    this.text = h('span', { class: 'dl-text' });
    this.secs = h('b', { class: 'dl-secs' });
    this.el = h('div', { class: 'hud-duel off' }, h('span', { class: 'sg-seal', style: '--sz:1.6em;--seal:#b3261e' }, h('span', null, '决')), this.text, this.secs);
  }

  update(f: HudFrame): void {
    const d = f.me && !f.me.dead ? duelState(f.me, f.elapsed) : null;
    const k = d ? `${d.vs}|${Math.ceil(d.secs)}|${f.lang}` : '';
    if (k === this.key) return;
    this.key = k;
    setClass(this.el, 'off', !d);
    if (!d) return;
    setText(this.text, t('hud.duel', { name: this.label(d.vs) ?? '?' }));
    setText(this.secs, t('common.seconds', { n: Math.ceil(d.secs) }));
    setClass(this.el, 'ending', d.secs <= 3);
  }

  relabel(): void {
    this.key = '';
  }
}
