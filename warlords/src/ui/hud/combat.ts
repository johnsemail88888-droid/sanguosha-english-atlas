// Combat feedback: floating damage numbers, damage direction arcs, interaction
// prompt, channel bar, outside-zone warning (the crosshair, hit markers and
// sights: ./aim.ts; downed / death / spectate: ./fallen.ts).
import type { EntityId, Vec3 } from '../../core/types';
import { HERO_BY_ID, ITEM_BY_ID } from '../../data';
import { h, setClass, setText } from '../dom';
import { gearName, getLang, heroName, t, tx, type I18nKey } from '../i18n';
import { displayName } from '../../game/names';
import { CRATE_NAME } from '../theme';
import { SquadFocusTracker, deriveInteract, distanceOutsideZone, relativeBearing, type InteractPrompt } from './logic';
import type { HudFrame } from './types';
import { viewport } from './viewport';
import type { PortraitCache } from '../widgets';
import { gearArt } from '../cardArt';
import { setArt } from '../artIcons';

const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): void {
  if (canAnimate) el.animate(frames, opts);
}

// (the crosshair, hit markers and sights live in ./aim.ts)

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

// ── Squad focus warning ──────────────────────────────────────────────────────

/** Who is focusing you, for the warning line: the Lord's guard, a named hero's squad, or wild units. */
export function squadFocusText(kind: 'lord' | 'hero' | 'wild', heroNameText: string): string {
  if (kind === 'lord') return tx('主公卫队正在攻击你！', 'The Lord’s guard is firing at you!');
  if (kind === 'hero') return tx(`${heroNameText}的部曲正在集火你！`, `${heroNameText}’s squad is focusing you!`);
  return tx('敌军正在集火你！', 'Enemy soldiers are focusing you!');
}

/**
 * A squad focusing you (「主公卫队正在攻击你」): red pulsing screen edges and a
 * line under the zone warning while ≥ 3 soldiers of one commander keep hitting
 * you — break line of sight, back off or use a 桃 before it is too late.
 */
export class SquadFocusWarning {
  readonly el: HTMLElement;
  private readonly text: HTMLElement;
  readonly tracker = new SquadFocusTracker();
  private on = false;
  private key = '';

  constructor() {
    this.text = h('span', { class: 'txt' });
    this.el = h('div', { class: 'hud-focuswarn' }, h('div', { class: 'edge' }), h('div', { class: 'line' }, h('b', null, '⚠'), this.text));
  }

  /** A troop / NPC / turret shot hit you. */
  note(shooter: EntityId, commander: EntityId | undefined, now: number): void {
    this.tracker.note(shooter, commander, now);
  }

  /** `who(commander)`: the commander's kind and hero name as the HUD knows them. */
  update(f: HudFrame, now: number, who: (commander: EntityId | undefined) => { kind: 'lord' | 'hero' | 'wild'; name: string }): void {
    const me = f.me;
    const focus = me && !me.dead ? this.tracker.current(now) : null;
    const on = !!focus;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
    }
    if (!focus) return;
    const w = who(focus.commander);
    const key = `${w.kind}|${w.name}|${f.lang}`;
    if (key !== this.key) {
      this.key = key;
      setText(this.text, squadFocusText(w.kind, w.name));
    }
    setClass(this.el, 'lord', w.kind === 'lord');
  }
}

// ── Interaction prompt + channel bar ─────────────────────────────────────────

export function interactText(p: InteractPrompt, lang: 'zh' | 'en', touch = false): { key: string; text: string; sub: string } {
  switch (p.kind) {
    case 'revive':
      // touch: no F key — the prompt names the button (which reads 救援 while a revive is in reach)
      return { key: '', text: t(touch ? 'hud.interact.reviveTouch' : 'hud.interact.revive', { name: `${heroName(p.heroId)}${p.name && p.name !== p.heroId ? `·${displayName(p.name, getLang())}` : ''}` }), sub: p.needPeach ? t('hud.interact.needPeach') : '' };
    case 'recall': {
      const name = `${heroName(p.heroId)}${p.name && p.name !== p.heroId ? `·${displayName(p.name, getLang())}` : ''}`;
      return {
        key: touch ? '' : 'F',
        text: touch ? tx('按住「招魂」召回 {name}', 'Hold Recall to call {name} back', { name }) : tx('按住 F 招魂 {name}', 'Hold F to call {name} back', { name }),
        sub: tx('5 秒 · 他将以 150 体力归来', '5 s · back with 150 HP'),
      };
    }
    case 'airdrop':
      return { key: 'F', text: t('hud.interact.airdrop'), sub: '' };
    case 'crate': {
      const n = CRATE_NAME[p.tier];
      return { key: 'F', text: `${tx('打开', 'Open')}${lang === 'en' ? ' ' : ''}${lang === 'en' ? n.en.toLowerCase() : n.zh}`, sub: '' };
    }
    case 'pickup':
      // the same gun you hold: F takes its rounds (none when your reserve is already full)
      if (p.ammo === 'full') return { key: '', text: gearName(p.itemId), sub: t('hud.interact.ammoFull') };
      if (p.ammo === 'take') return { key: 'F', text: t('hud.interact.ammo', { name: gearName(p.itemId) }), sub: '' };
      return { key: 'F', text: p.swap ? t('hud.interact.swap', { name: gearName(p.itemId) }) : t('hud.interact.pickup', { name: gearName(p.itemId) }), sub: '' };
    case 'full': {
      // COMBAT-7: F swaps the card for slot 4–7's (dropped at your feet); the discard binding for any other slot
      const hint = t(touch ? 'hud.interact.fullHintTouch' : 'hud.interact.fullHint');
      if (p.swapSlot < 0) return { key: '', text: gearName(p.itemId), sub: t('hud.interact.full') };
      return { key: 'F', text: t('hud.interact.swapCard', { name: gearName(p.itemId), slot: String(4 + p.swapSlot), old: gearName(p.swapId) }), sub: `${t('hud.interact.full')} · ${hint}` };
    }
    case 'selfRevive':
      return { key: '', text: t('hud.interact.selfRevive', { key: String(4 + p.slot) }), sub: '' };
  }
}

export class InteractPromptView {
  readonly el: HTMLElement;
  private readonly keyEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly subEl: HTMLElement;
  /** the painted weapon / card / armor / mount on offer (empty without art) */
  private readonly artEl: HTMLElement;
  private key = '';

  constructor(private readonly onTap?: () => void) {
    this.keyEl = h('span', { class: 'sg-key' });
    this.textEl = h('span', { class: 'txt' });
    this.subEl = h('span', { class: 'sub' });
    this.artEl = h('span', { class: 'ip-art' });
    this.el = h('div', { class: 'hud-interact off' }, this.keyEl, this.artEl, this.textEl, this.subEl);
    this.el.addEventListener('click', () => this.onTap?.());
  }

  update(f: HudFrame): InteractPrompt | null {
    const derived = deriveInteract(f.me, f.myEnt, f.ents);
    // the downed overlay already explains self-revive
    const p = derived?.kind === 'selfRevive' ? null : derived;
    const k = p ? `${p.kind}|${'targetId' in p ? p.targetId : ''}|${'itemId' in p ? p.itemId : ''}|${p.kind === 'revive' ? p.needPeach : ''}|${p.kind === 'full' ? `${p.swapSlot}:${p.swapId}` : ''}|${f.lang}|${f.touch}` : '';
    if (k !== this.key) {
      this.key = k;
      setClass(this.el, 'off', !p);
      if (p) {
        const txt = interactText(p, f.lang, f.touch);
        const keyLabel = f.touch ? '' : txt.key;
        setText(this.keyEl, keyLabel);
        setClass(this.keyEl, 'sg-hidden', !keyLabel);
        setText(this.textEl, txt.text);
        setText(this.subEl, txt.sub);
        setClass(this.subEl, 'sg-hidden', !txt.sub);
        setClass(this.el, 'warn', (p.kind === 'full' && p.swapSlot < 0) || (p.kind === 'revive' && p.needPeach));
        setClass(this.el, 'swapcard', p.kind === 'full' && p.swapSlot >= 0);
        const ref = p.kind === 'pickup' || p.kind === 'full' ? gearArt(p.itemId) : null;
        setArt(this.artEl, ref);
        setClass(this.artEl, 'weapon', ref?.shape === 'weapon');
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
