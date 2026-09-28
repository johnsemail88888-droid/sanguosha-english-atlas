// Aim marks on the HUD (weapons spec C6 / C7 / C8), from the renderer's aim aids
// (render/aimAids.ts) and the local aim:
//  - the holdover ladder of lobbed rounds and arrows: a tick per range where
//    the round comes down that far under the crosshair (data/weaponFeel.ts
//    ballisticHold, to the pixel at the zoom on screen) — replaces the fixed
//    CSS drop ticks;
//  - the live impact diamond of launchers and drawn bows (draw ≥ 0.5): where
//    the round lands if fired now, with its distance; a grenade inside its
//    arming distance shows grey 「未上膛」 (it would not go off);
//  - third person: the blocked-shot mark where a wall stops the shot (the shot
//    leaves the hero's eye, not the camera behind the shoulder);
//  - 方天画戟 fully aimed: brackets on the (up to 3) units its rockets would lock;
//  - locked on by 方天 rockets: a red edge chevron toward the shooter and a
//    warning line until the lock ends (a dodge roll breaks it).
import type { EntityId, GameEvent } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import { ballisticHold, holdPx, isScopedBow } from '../../data/weaponFeel';
import { arrowSpeedMul, type AimAidsView } from '../../render/aimAids';
import { h, setClass, setText } from '../dom';
import { tx } from '../i18n';
import type { AimView } from './aim';
import { relativeBearing } from './logic';
import type { HudFrame } from './types';
import { viewport } from './viewport';

/** Ranges (m) on the holdover ladder: a grenade, a drawn bow (烈弓's scope reaches further), a snap shot. */
export function ladderMarks(def: WeaponDef, progress: number): number[] {
  if (def.class === 'launcher') return [20, 40, 60];
  if (def.class !== 'bow') return [];
  if (progress < 0.5) return [10, 20, 30];
  return isScopedBow(def) ? [30, 50, 75, 100] : [20, 40, 60];
}

export interface LadderTick {
  /** metres */
  d: number;
  /** pixels under the crosshair */
  px: number;
}

/**
 * The holdover ladder of this weapon now: each mark's pixel drop at the zoom on
 * screen for a round leaving at the current draw's speed (marks past the
 * round's reach are left off — xiaoji's arrow bursts at 60 m).
 */
export function ladderTicks(def: WeaponDef | undefined, progress: number, zoom: number, fov: number, screenH: number): LadderTick[] {
  const pr = def?.projectile;
  if (!def || !pr || !(pr.gravity > 0)) return [];
  const v = pr.speed * arrowSpeedMul(def, progress);
  const reach = v * pr.lifetime + 1;
  const out: LadderTick[] = [];
  for (const d of ladderMarks(def, progress)) {
    if (d > reach) continue;
    const th = ballisticHold(v, pr.gravity, d);
    if (!Number.isFinite(th)) continue;
    out.push({ d, px: holdPx(th, fov, zoom, screenH) });
  }
  return out;
}

/** Labels closer than this to the previous label (px) are left off (their ticks stay). */
export const LADDER_LABEL_GAP = 11;
/** A ladder whose farthest mark sits closer than this to the crosshair (px) is not drawn: the impact diamond carries the holdover. */
export const LADDER_MIN_PX = 18;

/** Which ladder ticks get a range label: one every LADDER_LABEL_GAP px at least, and always the last (farthest). */
export function ladderLabels(ticks: readonly LadderTick[]): boolean[] {
  const out = ticks.map(() => false);
  let last = -Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const room = ticks[i]!.px - last >= LADDER_LABEL_GAP;
    const final = i === ticks.length - 1;
    if (final && !room && i > 0) {
      // the farthest mark wins the space: drop the label before it
      for (let j = i - 1; j >= 0; j--) {
        if (out[j]) {
          out[j] = false;
          break;
        }
      }
      out[i] = true;
      break;
    }
    if (room || final) {
      out[i] = true;
      last = ticks[i]!.px;
    }
  }
  return out;
}

/** Seconds a lock warning lasts without its end event (no rocket flies longer). */
const LOCK_MAX = 4;

export class AimMarks {
  readonly el: HTMLElement;
  private readonly ladder: HTMLElement;
  private readonly diamond: HTMLElement;
  private readonly diamondLbl: HTMLElement;
  private readonly blocked: HTMLElement;
  private readonly locks: HTMLElement[] = [];
  private readonly warn: HTMLElement;
  private readonly warnArrow: HTMLElement;
  private readonly warnLine: HTMLElement;
  private ladderKey = '';
  private diamondKey = '';
  private warnKey = '';
  /** 方天 rockets homing on you: projectile → shooter, forget-after time */
  private readonly locksOnMe = new Map<EntityId, { src: EntityId; until: number }>();
  /** the crosshair should grey out (a wall eats the shot) */
  blockedNow = false;

  constructor() {
    this.ladder = h('div', { class: 'am-ladder' });
    this.diamondLbl = h('span', { class: 'lbl' });
    this.diamond = h('div', { class: 'am-impact' }, h('i', { class: 'dia' }), this.diamondLbl);
    this.blocked = h('div', { class: 'am-blocked' }, h('i'));
    for (let i = 0; i < 3; i++) this.locks.push(h('div', { class: 'am-lock' }, h('i'), h('i'), h('i'), h('i')));
    this.warnArrow = h('div', { class: 'lw-arrow' }, h('i'));
    this.warnLine = h('div', { class: 'lw-line' });
    this.warn = h('div', { class: 'am-lockwarn' }, h('div', { class: 'lw-edge' }), this.warnArrow, this.warnLine);
    this.el = h('div', { class: 'hud-aimmarks' }, this.ladder, this.diamond, this.blocked, ...this.locks, this.warn);
  }

  /** A 'lock' event (sim/lockWatch.ts): rockets locked on you start / stop the warning. */
  onLock(ev: Extract<GameEvent, { t: 'lock' }>, myId: EntityId | null, now: number): void {
    if (myId === null || ev.target !== myId) return;
    if (ev.on) this.locksOnMe.set(ev.proj, { src: ev.src, until: now + LOCK_MAX });
    else this.locksOnMe.delete(ev.proj);
  }

  /** Rockets are homing on you right now. */
  get lockedOn(): boolean {
    return this.locksOnMe.size > 0;
  }

  update(f: HudFrame, aim: AimView, aids: Readonly<AimAidsView> | null, fov: number): void {
    const me = f.me;
    const alive = !!me && !me.dead && !me.downed && !!f.myEnt;
    const def = alive ? aim.def : undefined;
    this.updateLadder(def, aim, fov);
    this.updateImpact(def, aim, aids);
    // third person: a wall between the hero's eye and the crosshair point
    const b = alive && aids?.blocked && !aim.scoped ? aids.blocked : null;
    this.blockedNow = !!b;
    setClass(this.blocked, 'on', !!b);
    if (b) this.blocked.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
    // 方天画戟: the units its rockets would lock
    const locks = alive && aids ? aids.locks : [];
    for (let i = 0; i < this.locks.length; i++) {
      const el = this.locks[i]!;
      const l = locks[i];
      setClass(el, 'on', !!l);
      if (l) el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`;
    }
    this.updateWarning(f);
  }

  private updateLadder(def: WeaponDef | undefined, aim: AimView, fov: number): void {
    const ticks = def ? ladderTicks(def, aim.progress, aim.zoom, fov, viewport().h) : [];
    // (a scoped bow's ladder shows once the lens is up; a plain bow's / a launcher's always) — not
    // when the whole ladder sits within LADDER_MIN_PX of the crosshair: its marks would pile onto
    // the target, and the impact diamond already shows the holdover
    const spread = ticks.length > 0 ? Math.abs(ticks[ticks.length - 1]!.px) : 0;
    const show = spread >= LADDER_MIN_PX && (!isScopedBow(def) || aim.scoped || aim.progress < 0.5);
    const kind = !def ? '' : aim.scoped ? 'scope' : def.class === 'bow' ? 'bow' : 'launcher';
    const key = show ? ticks.map((t) => `${t.d}:${Math.round(t.px)}`).join(',') + `|${kind}` : '';
    if (key === this.ladderKey) return;
    this.ladderKey = key;
    setClass(this.ladder, 'on', show);
    setClass(this.ladder, 'in-scope', show && aim.scoped);
    this.ladder.dataset.kind = kind;
    if (!show) {
      this.ladder.replaceChildren();
      return;
    }
    // a range label only where it has room (the last mark always): close marks keep just their tick
    const labelled = ladderLabels(ticks);
    this.ladder.replaceChildren(
      ...ticks.map((t, i) => {
        const el = h('i', { class: 'tk' }, h('b'), h('span', null, labelled[i] ? String(t.d) : ''));
        el.style.top = `${Math.round(t.px)}px`;
        el.style.setProperty('--w', String(1 - i * 0.16));
        return el;
      }),
    );
  }

  private updateImpact(def: WeaponDef | undefined, aim: AimView, aids: Readonly<AimAidsView> | null): void {
    const want = !!def && (def.class === 'launcher' || (def.class === 'bow' && aim.progress >= 0.5));
    const imp = want && aids ? aids.impact : null;
    setClass(this.diamond, 'on', !!imp);
    if (!imp || !def) {
      this.diamondKey = '';
      return;
    }
    this.diamond.style.transform = `translate(${Math.round(imp.x)}px, ${Math.round(imp.y)}px)`;
    // a grenade that would land inside its arming distance does not go off
    const arm = def.specialParams.armDist ?? 0;
    const unarmed = def.class === 'launcher' && arm > 0 && imp.dist < arm;
    // (inside a scope the rangefinder already reads the impact distance: no second number)
    const key = `${unarmed}|${Math.round(imp.dist)}|${imp.hit}|${aim.scoped}`;
    if (key === this.diamondKey) return;
    this.diamondKey = key;
    setClass(this.diamond, 'unarmed', unarmed);
    setClass(this.diamond, 'air', !imp.hit);
    setText(this.diamondLbl, unarmed ? tx('未上膛', 'Not armed') : aim.scoped ? '' : `${Math.round(imp.dist)} m`);
  }

  private updateWarning(f: HudFrame): void {
    let src: EntityId | null = null;
    for (const [id, l] of this.locksOnMe) {
      if (f.now > l.until) this.locksOnMe.delete(id);
      else src = l.src;
    }
    const me = f.myEnt;
    const on = src !== null && !!me && !!f.me && !f.me.dead;
    const key = on ? `${f.lang}|${this.locksOnMe.size}` : '';
    if (key !== this.warnKey) {
      this.warnKey = key;
      setClass(this.warn, 'on', on);
      setText(this.warnLine, on ? tx('⚠ 方天画戟锁定了你 · 翻滚甩开！', '⚠ Rockets locked on you — dodge roll!') : '');
    }
    if (!on || src === null || !me) return;
    const shooter = f.ents.find((e) => e.id === src);
    setClass(this.warnArrow, 'on', !!shooter);
    if (!shooter) return;
    const ang = relativeBearing(me.x, me.z, me.yaw, shooter.x, shooter.z);
    this.warnArrow.style.transform = `rotate(${Math.round((ang * 180) / Math.PI)}deg)`;
  }
}
