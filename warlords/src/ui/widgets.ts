// Reusable DOM widgets: seals, kingdom badges, magatama rows, hero cards,
// form controls. Everything returns plain elements.
import type { Kingdom, RoleId } from '../core/types';
import { HERO_BY_ID } from '../data';
import { assetList, assetListSync } from '../game/assets';
import { portraitArtPath, portraitCropStyle, type PortraitCrop } from './art';
import { h, s, type Child } from './dom';
import { heroName, heroTitle, roleName, tx } from './i18n';
import { KINGDOM_GLYPH, ROLE_GLYPH, kingdomColor, roleColor, roleInk } from './theme';

export type SfxName = 'click' | 'hover' | 'confirm' | 'back' | 'flip' | 'error' | 'countdown' | 'reveal';

export function button(label: Child, onClick: (ev: MouseEvent) => void, opts: { cls?: string; sfx?: SfxName | 'none'; title?: string; disabled?: boolean; data?: Record<string, string> } = {}): HTMLButtonElement {
  const b = h('button', {
    class: `sg-btn ${opts.cls ?? ''}`.trim(),
    type: 'button',
    title: opts.title,
    disabled: opts.disabled,
    data: { ...(opts.data ?? {}), ...(opts.sfx ? { sfx: opts.sfx } : {}) },
  }, label);
  b.addEventListener('click', (ev) => {
    if (b.disabled) return;
    onClick(ev);
  });
  return b;
}

/** Red seal stamp with one glyph (optionally role-colored). */
export function seal(glyph: string, opts: { color?: string; size?: string; round?: boolean; claim?: boolean; title?: string } = {}): HTMLElement {
  const el = h('span', { class: `sg-seal${opts.round ? ' round' : ''}${opts.claim ? ' claim' : ''}`, title: opts.title }, h('span', null, glyph));
  if (opts.color) el.style.setProperty('--seal', opts.color);
  if (opts.size) el.style.setProperty('--sz', opts.size);
  return el;
}

export function roleSeal(role: RoleId, size?: string, claim = false): HTMLElement {
  return seal(ROLE_GLYPH[role] ?? '?', { color: claim ? roleInk(role) : roleColor(role), size, claim, title: roleName(role) });
}

export function kingdomBadge(k: Kingdom | undefined, size?: string): HTMLElement {
  const el = h('span', { class: 'sg-kd', title: k ?? '' }, h('span', null, k ? KINGDOM_GLYPH[k] ?? '?' : '?'));
  el.style.setProperty('--kc', kingdomColor(k));
  if (size) el.style.setProperty('--sz', size);
  return el;
}

const MAG_PATH = 'M13 2A7.5 7.5 0 0 1 20.5 9.5Q20 19 5 21.5Q10 17 6.3 13.4A7.5 7.5 0 0 1 13 2Z';

/** One 勾玉 icon. */
export function magatama(kind: 'full' | 'empty' | 'lord' = 'full'): SVGSVGElement {
  const cls = kind === 'full' ? 'sg-mag' : `sg-mag ${kind}`;
  return s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    s('path', { class: 'body', d: MAG_PATH }),
    s('circle', { class: 'hole', cx: 13, cy: 8.8, r: 2.3 }),
  );
}

/** Row of 勾玉: `count` full (+ `bonus` gold ones for the lord's extra HP). */
export function magatamaRow(count: number, bonus = 0, empty = 0): HTMLElement {
  const row = h('span', { class: 'sg-mags', aria: { label: `${count + bonus}` } });
  for (let i = 0; i < count; i++) row.appendChild(magatama('full'));
  for (let i = 0; i < bonus; i++) row.appendChild(magatama('lord'));
  for (let i = 0; i < empty; i++) row.appendChild(magatama('empty'));
  return row;
}

/** Stars for hero difficulty 1..3. */
export function difficultyStars(n: number): HTMLElement {
  const wrap = h('span', { class: 'sg-stars', aria: { label: String(n) } });
  for (let i = 1; i <= 3; i++) wrap.appendChild(h('span', { class: i <= n ? 'on' : 'off' }, '★'));
  return wrap;
}

// ── portraits ────────────────────────────────────────────────────────────────

/** Where PortraitCache learns which painted portraits this deploy ships. */
export interface PortraitArtSource {
  /** true / false once the art listing is known, null before */
  has(path: string): boolean | null;
  /** resolves once the listing is known */
  ready(): Promise<unknown>;
}

function listingState(path: string): boolean | null {
  const files = assetListSync();
  return files ? files.has(path) : null;
}

/** The deploy's art listing (src/game/assets.ts): empty in the single-file build. */
export const shippedArt: PortraitArtSource = {
  has: listingState,
  ready: () => assetList(),
};

/** Every procedural portrait is rendered once, at this size; smaller uses (128 / 192 px) are CSS-scaled. */
export const PORTRAIT_SIZE = 256;

interface PortraitJob {
  id: string;
  prio: number;
  seq: number;
  resolve: (url: string) => void;
}

/**
 * Hero portraits for every screen: the painted portrait (assets/portraits/<id>.webp,
 * cropped per frame) when the deploy ships it, else the memoized procedural render
 * (deps.renderHeroPortrait). Both sit on a calligraphy placeholder until decoded.
 *
 * Procedural portraits are keyed by hero only (one render per hero, not one per
 * size) and rendered one at a time from a priority queue, so the cards a player
 * must choose from are drawn before the picks strip / other seats. Between two
 * renders the queue yields to the browser (a render is a synchronous WebGL draw
 * with shader compiles — back to back they froze hero select for the whole
 * countdown), and a layer only asks for its render once it scrolls into view.
 * Heroes with painted art never enter that queue.
 */
export class PortraitCache {
  private cache = new Map<string, Promise<string>>();
  private queue: PortraitJob[] = [];
  private running = 0;
  private seq = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private io: IntersectionObserver | null = null;
  private readonly lazy = new WeakMap<Element, () => void>();
  /** layers of a torn-down screen: a late art verdict / failed image must not start watching them */
  private readonly released = new WeakSet<Element>();
  /** listed art that failed to load (a deploy that dropped files): procedural from then on */
  private readonly broken = new Set<string>();
  /** art already shown once: later copies (lists rebuild often) appear without a fade */
  private readonly seen = new Set<string>();
  private readonly prefetched = new Set<string>();

  constructor(
    private readonly render: (heroId: string, size?: number) => Promise<string>,
    private readonly art: PortraitArtSource = shippedArt,
    private readonly concurrency = 1,
    /** ms to yield between two renders (input, rAF and timers run meanwhile) */
    private readonly gapMs = 30,
  ) {}

  /** The painted portrait is shipped (false: use the procedural one; null: listing not loaded yet). */
  artState(heroId: string): boolean | null {
    const path = portraitArtPath(heroId);
    return this.broken.has(path) ? false : this.art.has(path);
  }

  hasArt(heroId: string): boolean {
    return this.artState(heroId) === true;
  }

  /** Resolves once artState() is known for every hero. */
  whenKnown(): Promise<unknown> {
    return this.art.ready();
  }

  /** The art listing has loaded (artState() is never null). */
  known(): boolean {
    // any path answers null exactly while the listing is still loading
    return this.art.has(portraitArtPath('_')) !== null;
  }

  /** Warm the HTTP cache with painted portraits (low priority, nothing decoded) so a grid pops in at once. */
  prefetch(heroIds: readonly string[]): void {
    if (typeof Image === 'undefined') return;
    for (const id of heroIds) {
      const path = portraitArtPath(id);
      if (this.prefetched.has(path) || !this.hasArt(id)) continue;
      this.prefetched.add(path);
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.src = path;
    }
  }

  /** The procedural portrait data URL of a hero ('' when it could not be rendered). `size` is ignored (always PORTRAIT_SIZE). */
  get(heroId: string, _size?: number, priority = 0): Promise<string> {
    const hit = this.cache.get(heroId);
    if (hit) {
      this.bump(heroId, priority);
      return hit;
    }
    const p = new Promise<string>((resolve) => this.queue.push({ id: heroId, prio: priority, seq: this.seq++, resolve }));
    this.cache.set(heroId, p);
    this.pump();
    return p;
  }

  /**
   * Render these heroes before anything else still waiting (e.g. your options on
   * hero select). Heroes whose painted portrait ships are skipped — they need no render.
   * While the art listing is still loading nothing is queued for a hero yet (the
   * render would load its GLB + clips for a portrait that is never shown): the
   * decision waits for the listing.
   */
  prioritize(heroIds: readonly string[], priority = 10): void {
    const later: Array<[string, number]> = [];
    heroIds.forEach((id, i) => {
      const prio = priority - i * 1e-3;
      const state = this.artState(id);
      if (state === false) this.get(id, undefined, prio);
      else if (state === null) later.push([id, prio]);
    });
    if (!later.length) return;
    void this.whenKnown().then(() => {
      for (const [id, prio] of later) if (this.artState(id) === false) this.get(id, undefined, prio);
    });
  }

  /** Heroes waiting to be rendered, in the order they will be (tests / debugging). */
  pending(): string[] {
    return [...this.queue].sort((a, b) => b.prio - a.prio || a.seq - b.seq).map((j) => j.id);
  }

  private bump(heroId: string, priority: number): void {
    const job = this.queue.find((j) => j.id === heroId);
    if (job && priority > job.prio) job.prio = priority;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[bi];
        if (a.prio > b.prio || (a.prio === b.prio && a.seq < b.seq)) bi = i;
      }
      const job = this.queue.splice(bi, 1)[0];
      this.running++;
      let out: Promise<string>;
      try {
        out = this.render(job.id, PORTRAIT_SIZE);
      } catch (err) {
        out = Promise.reject(err);
      }
      out
        .catch((err: unknown) => {
          console.warn('[ui] portrait render failed', job.id, err);
          return '';
        })
        .then((url) => job.resolve(url))
        .finally(() => {
          this.running--;
          this.schedulePump();
        });
    }
  }

  /** The next render starts in a later task, never in the microtask chain of the last one. */
  private schedulePump(): void {
    if (this.pumpTimer !== null || !this.queue.length) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, this.gapMs);
  }

  private observer(): IntersectionObserver | null {
    if (this.io) return this.io;
    if (typeof IntersectionObserver === 'undefined') return null;
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.io?.unobserve(e.target);
          const start = this.lazy.get(e.target);
          this.lazy.delete(e.target);
          start?.();
        }
      },
      { rootMargin: '160px' },
    );
    return this.io;
  }

  /**
   * Stop watching the not-yet-rendered layers under `root` (a screen / the HUD
   * being torn down): an IntersectionObserver keeps its targets alive.
   */
  release(root: Element): void {
    const io = this.io;
    const layers = root.matches('.portrait') ? [root] : [];
    for (const el of root.querySelectorAll('.portrait')) layers.push(el);
    for (const el of layers) {
      this.released.add(el);
      if (!io || !this.lazy.has(el)) continue;
      this.lazy.delete(el);
      io.unobserve(el);
    }
  }

  /**
   * A `.portrait` layer: placeholder glyph now, image once decoded. `crop` frames the
   * painted portrait for the container (a 5:7 card, a round face avatar…); the
   * procedural render is already framed and ignores it (and is only rendered once the
   * layer comes into view, at `priority` in the render queue).
   */
  layer(heroId: string, _size = PORTRAIT_SIZE, crop: PortraitCrop = 'card', priority = 0): HTMLElement {
    const def = HERO_BY_ID[heroId];
    const glyph = def ? def.nameZh.slice(-1) : '?';
    const wrap = h('div', { class: 'portrait' }, h('div', { class: 'ph' }, glyph));
    const state = this.artState(heroId);
    if (state === true) this.showArt(wrap, heroId, crop, priority);
    else if (state === false) this.showRender(wrap, heroId, priority);
    else {
      void this.art.ready().then(() => {
        if (this.released.has(wrap)) return;
        if (this.hasArt(heroId)) this.showArt(wrap, heroId, crop, priority);
        else this.showRender(wrap, heroId, priority);
      });
    }
    return wrap;
  }

  /** Round face avatar in a kingdom ring — painted art only: callers keep their badge when !hasArt(). */
  avatar(heroId: string, cls = ''): HTMLElement {
    const el = h('span', { class: `sg-ava ${cls}`.trim(), aria: { hidden: 'true' } }, this.layer(heroId, 96, 'face'));
    el.style.setProperty('--kc', kingdomColor(HERO_BY_ID[heroId]?.kingdom));
    return el;
  }

  /** The procedural render, requested once the layer scrolls into view (at once when already cached). */
  private showRender(wrap: HTMLElement, heroId: string, priority: number): void {
    if (this.released.has(wrap)) return;
    const start = (): void => {
      void this.get(heroId, undefined, priority).then((url) => {
        // tiny data URLs are the 1×1 stub — keep the placeholder
        if (!url || url.length < 200) return;
        const img = h('img', { alt: '', draggable: false });
        img.decoding = 'async';
        img.src = url;
        wrap.appendChild(img);
      });
    };
    const io = this.cache.has(heroId) ? null : this.observer();
    if (io) {
      this.lazy.set(wrap, start);
      io.observe(wrap);
    } else start();
  }

  private showArt(wrap: HTMLElement, heroId: string, crop: PortraitCrop, priority: number): void {
    const path = portraitArtPath(heroId);
    const img = h('img', { class: 'art', alt: '', draggable: false, style: portraitCropStyle(heroId, crop) });
    img.decoding = 'async';
    if (!this.seen.has(path)) {
      img.classList.add('fade');
      img.addEventListener('load', () => {
        this.seen.add(path);
        img.classList.add('on');
      }, { once: true });
    }
    img.addEventListener('error', () => {
      this.broken.add(path);
      img.remove();
      wrap.classList.remove('art');
      this.showRender(wrap, heroId, priority);
    }, { once: true });
    img.src = path;
    wrap.classList.add('art');
    wrap.appendChild(img);
  }
}

/** A hero's face avatar when the painted portrait ships, else the kingdom badge (the procedural look). */
export function heroIcon(portraits: PortraitCache, heroId: string | undefined, kingdom: Kingdom | undefined, size?: string): HTMLElement {
  if (heroId && portraits.hasArt(heroId)) {
    const el = portraits.avatar(heroId);
    if (size) el.style.setProperty('--sz', size);
    return el;
  }
  return kingdomBadge(kingdom, size);
}

export interface HeroCardOpts {
  compact?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /** show +1 gold magatama (lord bonus) */
  lordBonus?: boolean;
  /** overlay stamp (e.g. "taken") */
  tag?: HTMLElement | null;
  size?: number;
  /** how a painted portrait is framed (default: the card's upper body) */
  crop?: PortraitCrop;
  /** procedural portrait render priority (your own options first) */
  priority?: number;
  onClick?: () => void;
}

/** 三国杀-style hero card: kingdom frame, 勾玉 HP, vertical name, 称号. */
export function heroCard(portraits: PortraitCache, heroId: string, opts: HeroCardOpts = {}): HTMLElement {
  const def = HERO_BY_ID[heroId];
  const card = h('div', {
    class: `sg-hcard${opts.compact ? ' compact' : ''}${opts.selected ? ' selected' : ''}${opts.disabled ? ' disabled' : ''}`,
    role: 'button',
    tabindex: opts.disabled ? -1 : 0,
    data: { hero: heroId },
    aria: { label: heroName(heroId), pressed: !!opts.selected, disabled: !!opts.disabled },
  });
  card.style.setProperty('--kc', kingdomColor(def?.kingdom));
  card.appendChild(portraits.layer(heroId, opts.size ?? PORTRAIT_SIZE, opts.crop, opts.priority ?? 0));
  card.appendChild(h('div', { class: 'shade' }));
  card.appendChild(
    h('div', { class: 'top' },
      kingdomBadge(def?.kingdom),
      def ? magatamaRow(def.sgsHp, opts.lordBonus ? 1 : 0) : null,
    ),
  );
  if (def?.lordCandidate) card.appendChild(h('span', { class: 'crown', title: tx('主公候选', 'Lord candidate') }, '♛'));
  card.appendChild(h('div', { class: 'vname' }, [...(def ? def.nameZh : heroId.slice(0, 4))].map((ch) => h('i', null, ch))));
  card.appendChild(
    h('div', { class: 'bottom' },
      h('div', { class: 'nm', style: `--nl:${textUnits(heroName(heroId)).toFixed(1)}` }, heroName(heroId)),
      h('div', { class: 'ttl' }, heroTitle(heroId)),
    ),
  );
  if (opts.tag) card.appendChild(h('div', { class: 'tag' }, opts.tag));
  if (opts.onClick) {
    const fire = (): void => {
      if (!card.classList.contains('disabled')) opts.onClick?.();
    };
    card.addEventListener('click', fire);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fire();
      }
    });
  }
  return card;
}

/** Rough width of a label in em: CJK glyphs are 1 em, Latin ~0.6 em (fits long names on small cards). */
export function textUnits(text: string): number {
  let n = 0;
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.6;
  return Math.max(1, n);
}

// ── form controls ────────────────────────────────────────────────────────────

export function field(label: Child, control: HTMLElement, hint?: Child): HTMLElement {
  return h('div', { class: 'sg-field' }, h('span', { class: 'sg-label' }, label), control, hint ? h('div', { class: 'sg-hint' }, hint) : null);
}

export function segmented<T extends string | number>(
  options: readonly { value: T; label: Child; title?: string }[],
  value: T,
  onChange: (v: T) => void,
  opts: { disabled?: boolean; name?: string } = {},
): HTMLElement {
  const wrap = h('div', { class: 'sg-seg', role: 'group', aria: { label: opts.name ?? '' } });
  const btns: HTMLButtonElement[] = [];
  const set = (v: T): void => {
    btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === v)));
  };
  options.forEach((o) => {
    const b = h('button', { type: 'button', title: o.title, disabled: opts.disabled, data: { value: String(o.value) } }, o.label);
    b.addEventListener('click', () => {
      set(o.value);
      onChange(o.value);
    });
    btns.push(b);
    wrap.appendChild(b);
  });
  set(value);
  return wrap;
}

export function toggle(on: boolean, onChange: (v: boolean) => void, label?: string): HTMLButtonElement {
  const b = h('button', { class: 'sg-switch', type: 'button', role: 'switch', aria: { checked: on, label: label ?? '' } });
  let state = on;
  b.addEventListener('click', () => {
    state = !state;
    b.setAttribute('aria-checked', String(state));
    onChange(state);
  });
  return b;
}

export function slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  format: (v: number) => string = (v) => String(v),
  label?: string,
): HTMLElement {
  const input = h('input', { type: 'range', min, max, step, value: String(value), aria: { label: label ?? '' } });
  const out = h('output', null, format(value));
  const paint = (v: number): void => {
    input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
    out.textContent = format(v);
  };
  // knob, fill (--p) and label all follow the value the browser kept (clamped to min..max)
  const kept = Number(input.value);
  paint(Number.isFinite(kept) ? kept : value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onChange(v);
  });
  return h('div', { class: 'sg-range' }, input, out);
}

export function textInput(value: string, onChange: (v: string) => void, opts: { placeholder?: string; maxlength?: number; cls?: string; type?: string; label?: string } = {}): HTMLInputElement {
  const input = h('input', {
    class: `sg-input ${opts.cls ?? ''}`.trim(),
    type: opts.type ?? 'text',
    value,
    placeholder: opts.placeholder,
    maxlength: opts.maxlength,
    autocomplete: 'off',
    aria: { label: opts.label ?? opts.placeholder ?? '' },
  });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

export function tabs<T extends string>(items: readonly { id: T; label: Child }[], active: T, onSelect: (id: T) => void): HTMLElement {
  const bar = h('div', { class: 'sg-tabs', role: 'tablist' });
  const btns = items.map((it) => {
    const b = h('button', { class: 'sg-tab', type: 'button', role: 'tab', aria: { selected: it.id === active }, data: { tab: it.id } }, it.label);
    b.addEventListener('click', () => {
      btns.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      onSelect(it.id);
    });
    bar.appendChild(b);
    return b;
  });
  return bar;
}

export function keyCap(label: string): HTMLElement {
  return h('span', { class: 'sg-key' }, label);
}
