// Reusable DOM widgets: seals, kingdom badges, magatama rows, hero cards,
// form controls. Everything returns plain elements.
import type { Kingdom, RoleId } from '../core/types';
import { HERO_BY_ID } from '../data';
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

/** Memoizes deps.renderHeroPortrait and builds <img> layers with a calligraphy placeholder. */
export class PortraitCache {
  private cache = new Map<string, Promise<string>>();

  constructor(private readonly render: (heroId: string, size?: number) => Promise<string>) {}

  get(heroId: string, size = 256): Promise<string> {
    const key = `${heroId}@${size}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.render(heroId, size).catch((err: unknown) => {
        console.warn('[ui] portrait render failed', heroId, err);
        return '';
      });
      this.cache.set(key, p);
    }
    return p;
  }

  /** A `.portrait` layer: placeholder glyph now, image once rendered. */
  layer(heroId: string, size = 256): HTMLElement {
    const def = HERO_BY_ID[heroId];
    const glyph = def ? def.nameZh.slice(-1) : '?';
    const wrap = h('div', { class: 'portrait' }, h('div', { class: 'ph' }, glyph));
    void this.get(heroId, size).then((url) => {
      // tiny data URLs are the 1×1 stub — keep the placeholder
      if (!url || url.length < 200) return;
      const img = h('img', { alt: '', draggable: false });
      img.decoding = 'async';
      img.src = url;
      wrap.appendChild(img);
    });
    return wrap;
  }
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
  card.appendChild(portraits.layer(heroId, opts.size ?? 256));
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
      h('div', { class: 'nm' }, heroName(heroId)),
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
