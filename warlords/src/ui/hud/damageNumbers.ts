// Floating damage numbers (weapons spec C8). An SMG lands 12–14 hits a second:
// hits on one target within MERGE_WINDOW s add up in one number that pulses
// instead of a new number per bullet. Colours: body white, head gold (larger),
// armor-reduced pale blue with a small shield (armor matters), a dodge / 八卦
// grey 「闪」, a knock / kill red; your squad's hits smaller and green-grey.
import type { EntityId, Vec3 } from '../../core/types';
import { h } from '../dom';
import { tx } from '../i18n';
import { viewport } from './viewport';

const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  return canAnimate ? el.animate(frames, opts) : null;
}

/** Hits on one target this close together merge into one number (s). */
export const MERGE_WINDOW = 0.6;
/** A number shows this long after its last hit (s). */
const LIFE = 0.9;

export type DamageKind = 'normal' | 'head' | 'armor' | 'dodge' | 'kill' | 'squad' | 'blocked' | 'heal' | 'crit';

/** Which colour a merged number takes when hits of two kinds add up (the strongest tell wins). */
const RANK: Readonly<Record<DamageKind, number>> = { normal: 0, squad: 0, armor: 1, head: 2, crit: 2, kill: 3, dodge: 0, blocked: 0, heal: 0 };

/** The kind of a merged number: a kill stays red, a headshot gold, an armor hit blue, else the newest. */
export function mergeKind(prev: DamageKind, next: DamageKind): DamageKind {
  return RANK[next] >= RANK[prev] ? next : prev;
}

interface Floater {
  outer: HTMLElement;
  inner: HTMLElement;
  world: Vec3 | null;
  until: number;
  x: number;
  y: number;
  /** merge key (target + whose hit) and the running total */
  key: string;
  total: number;
  kind: DamageKind;
  lastHit: number;
  anim: Animation | null;
}

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
      this.pool.push({ outer, inner, world: null, until: 0, x: 0, y: 0, key: '', total: 0, kind: 'normal', lastHit: -99, anim: null });
    }
  }

  /**
   * A hit of yours (or your squad's) on `target`: merged into that target's
   * number while it is younger than MERGE_WINDOW, else a new one. A dodge
   * (「闪」) never merges.
   */
  hit(target: EntityId, amount: number, kind: DamageKind, world: Vec3 | null, now: number, mine = true): void {
    const key = `${target}|${mine ? 'me' : 'sq'}`;
    if (kind !== 'dodge') {
      const f = this.pool.find((p) => p.key === key && p.until > 0 && now - p.lastHit <= MERGE_WINDOW && p.kind !== 'dodge');
      if (f) {
        f.total += amount;
        f.kind = mergeKind(f.kind, kind);
        f.lastHit = now;
        if (world) f.world = world;
        this.paint(f, now, true);
        return;
      }
    }
    const f = this.take(world);
    f.key = key;
    f.total = amount;
    f.kind = kind;
    f.lastHit = now;
    this.paint(f, now, false);
  }

  /** A one-off number / word (a heal, 格挡, 免疫 …): never merged. */
  spawn(text: string, kind: DamageKind, world: Vec3 | null, now: number): void {
    const f = this.take(world);
    f.key = '';
    f.total = 0;
    f.kind = kind;
    f.lastHit = now;
    f.inner.textContent = text;
    f.inner.className = `n ${kind}`;
    f.until = now + LIFE;
    this.animate(f, false);
  }

  private take(world: Vec3 | null): Floater {
    const f = this.pool[this.next]!;
    this.next = (this.next + 1) % this.pool.length;
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
    return f;
  }

  private paint(f: Floater, now: number, merged: boolean): void {
    const text = f.kind === 'dodge' ? tx('闪', 'Dodge') : String(Math.round(f.total));
    f.inner.textContent = text;
    f.inner.className = `n ${f.kind}`;
    f.until = now + LIFE;
    this.animate(f, merged);
  }

  private animate(f: Floater, merged: boolean): void {
    f.anim?.cancel();
    const big = f.kind === 'head' || f.kind === 'crit' || f.kind === 'kill';
    // a merged hit: a quick pulse where the number already is, then the usual drift and fade
    f.anim = play(f.inner, merged
      ? [
          { opacity: 1, transform: `translate(-50%, -6px) scale(${big ? 1.35 : 1.18})` },
          { opacity: 1, transform: 'translate(-50%, -8px) scale(1)', offset: 0.15 },
          { opacity: 1, transform: 'translate(-50%, -22px) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translate(-50%, -34px) scale(0.9)' },
        ]
      : [
          { opacity: 0, transform: `translate(-50%, 0) scale(${big ? 1.7 : 1.3})` },
          { opacity: 1, transform: 'translate(-50%, -6px) scale(1)', offset: 0.15 },
          { opacity: 1, transform: 'translate(-50%, -22px) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translate(-50%, -34px) scale(0.9)' },
        ], { duration: LIFE * 1000, easing: 'ease-out', fill: 'forwards' });
  }

  update(now: number): void {
    for (const f of this.pool) {
      if (!f.until) continue;
      if (now > f.until) {
        f.until = 0;
        f.world = null;
        f.key = '';
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
