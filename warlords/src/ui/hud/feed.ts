// Kill feed (with role-reveal colors), center announcements, and chat log.
import type { Kingdom, RoleId } from '../../core/types';
import { h } from '../dom';
import { colon, gearName, getLang, heroName, roleName, t, tx } from '../i18n';
import { ROLE_GLYPH, kingdomColor, roleColor } from '../theme';
import type { PortraitCache } from '../widgets';
import { abilityIcon, gearIcon, setArt } from '../artIcons';
import { gearArt } from '../cardArt';
import { ARMOR_BY_ID, ITEM_BY_ID, MOUNT_BY_ID } from '../../data';
import type { KillCause } from './killcause';

/** The painted weapon / ability / card a kill was made with (null without art: the feed looks as before). */
export function causeIcon(cause: KillCause | null | undefined): HTMLElement | null {
  if (!cause) return null;
  return cause.kind === 'ability' ? abilityIcon(cause.id, 'kf-how') : gearIcon(cause.id, 'kf-how');
}

export interface FeedParty {
  name: string;
  heroId?: string;
  kingdom?: Kingdom;
  role?: RoleId;
}

// ── Kill feed ────────────────────────────────────────────────────────────────

/**
 * A row too long for the feed (English names: "Zhou Yu · Nameless 288 killed Lü Bu ·
 * Bot 2 [Rebel]") first drops the killer's player name, then the victim's: hero names
 * and the victim's revealed role always stay whole (UX-15). `clipped` is injectable for tests.
 */
export function fitFeedRow(row: HTMLElement, clipped: (row: HTMLElement) => boolean = namesClipped): void {
  if (!clipped(row)) return;
  row.classList.add('tight-k');
  if (!clipped(row)) return;
  row.classList.add('tight');
}

/** Any name in the row cut by an ellipsis (its content is wider than its box)? */
function namesClipped(row: HTMLElement): boolean {
  if (typeof row.querySelectorAll !== 'function') return false;
  for (const w of Array.from(row.querySelectorAll<HTMLElement>('.who'))) if (w.scrollWidth > w.clientWidth + 1) return true;
  return false;
}

export class KillFeed {
  readonly el: HTMLElement;
  private entries: { el: HTMLElement; until: number }[] = [];

  /** `portraits`: face avatars beside the names when the painted portraits ship */
  constructor(
    private readonly portraits: PortraitCache | null = null,
    private readonly max = 6,
  ) {
    this.el = h('div', { class: 'hud-feed', aria: { live: 'polite' } });
  }

  private party(p: FeedParty | null, cls: string): HTMLElement {
    if (!p) return h('span', { class: `who ${cls} zone` }, t('feed.zone'));
    const face = p.heroId && this.portraits?.hasArt(p.heroId) ? this.portraits.avatar(p.heroId, 'kf-ava') : null;
    const el = h('span', { class: `who ${cls}${face ? ' has-ava' : ''}` }, face, p.heroId ? heroName(p.heroId) : p.name, p.heroId && p.name ? h('small', null, p.name) : null);
    el.style.setProperty('--kc', kingdomColor(p.kingdom));
    return el;
  }

  /** "killer 斩 victim [role]" (killer null = zone / unknown). */
  push(killer: FeedParty | null, victim: FeedParty, opts: { downed?: boolean; mine?: boolean; aboutMe?: boolean; now: number; cause?: KillCause | null }): void {
    const role = victim.role;
    const roleEl = role
      ? h('span', { class: 'rseal', style: `--seal:${roleColor(role)}`, title: roleName(role) }, ROLE_GLYPH[role], h('small', null, roleName(role)))
      : null;
    const el = h('div', { class: `kf${opts.mine ? ' mine' : ''}${opts.aboutMe ? ' me' : ''}${opts.downed ? ' downed' : ''}` },
      this.party(killer, 'k'),
      killer ? causeIcon(opts.cause) : null,
      h('span', { class: `verb${getLang() === 'en' ? ' word' : ''}` }, t(opts.downed ? 'feed.down' : 'feed.kill')),
      this.party(victim, 'v'),
      roleEl,
    );
    this.el.appendChild(el);
    fitFeedRow(el);
    this.entries.push({ el, until: opts.now + (opts.mine || opts.aboutMe ? 10 : 7) });
    while (this.entries.length > this.max) this.entries.shift()?.el.remove();
  }

  /** A public claim (跳身份) toast in the feed. */
  pushClaim(who: FeedParty, role: RoleId, now: number): void {
    const el = h('div', { class: 'kf claim' },
      this.party(who, 'k'),
      h('span', { class: 'verb small' }, t('hud.claims', { role: '' }).trim()),
      h('span', { class: 'rseal claim', style: `--seal:${roleColor(role)}` }, ROLE_GLYPH[role], h('small', null, roleName(role))),
    );
    this.el.appendChild(el);
    fitFeedRow(el);
    this.entries.push({ el, until: now + 6 });
    while (this.entries.length > this.max) this.entries.shift()?.el.remove();
  }

  update(now: number): void {
    if (!this.entries.length) return;
    while (this.entries.length && this.entries[0].until < now) {
      const e = this.entries.shift();
      if (e) {
        e.el.classList.add('out');
        setTimeout(() => e.el.remove(), 400);
      }
    }
  }
}

// ── Announcements ────────────────────────────────────────────────────────────

type AnnKind = 'info' | 'warn' | 'big';

export class Announcer {
  readonly el: HTMLElement;
  private readonly bigEl: HTMLElement;
  private readonly infoEl: HTMLElement;
  private queue: { text: string; kind: AnnKind; sub?: string; icons: HTMLElement[] }[] = [];
  /** the newest info line (tests / harness) */
  lastInfo: { text: string; sub?: string } | null = null;
  private showingUntil = 0;
  private hideAt = 0;
  private infos: { el: HTMLElement; until: number }[] = [];

  constructor() {
    this.bigEl = h('div', { class: 'ann-big' });
    this.infoEl = h('div', { class: 'ann-info' });
    this.el = h('div', { class: 'hud-announce' }, this.bigEl, this.infoEl);
  }

  /** `art`: painted emblems / renders of what the line is about (loot), shown when the art ships */
  push(text: string, kind: AnnKind = 'info', sub?: string, now = performance.now() / 1000, art: readonly (HTMLElement | null)[] = []): void {
    const icons = art.filter((x): x is HTMLElement => !!x);
    if (kind === 'info') {
      // an info line may carry a second, smaller line (a card's one-line effect)
      const el = h('div', { class: `line${sub ? ' has-sub' : ''}${icons.length ? ' has-art' : ''}` },
        icons.length ? h('span', { class: 'ann-art' }, icons) : null,
        h('span', { class: 'main' }, text),
        sub ? h('span', { class: 'sub' }, sub) : null,
      );
      this.infoEl.appendChild(el);
      this.lastInfo = { text, sub };
      this.infos.push({ el, until: now + (sub ? 5.5 : 4) });
      while (this.infos.length > 3) this.infos.shift()?.el.remove();
      return;
    }
    // drop duplicates already queued
    if (this.queue.some((q) => q.text === text)) return;
    this.queue.push({ text, kind, sub, icons });
    if (this.queue.length > 4) this.queue.shift();
  }

  update(now: number): void {
    if (now >= this.showingUntil) {
      const next = this.queue.shift();
      if (next) {
        this.bigEl.replaceChildren(
          h('div', { class: `msg ${next.kind}` },
            h('span', { class: 't' }, next.text),
            next.sub ? h('span', { class: 's' }, next.sub) : null,
            next.icons.length ? h('span', { class: 'ann-art' }, next.icons) : null,
          ),
        );
        this.bigEl.classList.add('show');
        const msg = this.bigEl.firstElementChild as HTMLElement | null;
        if (msg && typeof msg.animate === 'function') {
          msg.animate([{ opacity: 0, transform: 'scale(1.15)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 350, easing: 'ease-out' });
        }
        this.showingUntil = now + (next.kind === 'big' ? 3 : 2.6);
        this.hideAt = this.showingUntil - 0.35;
      } else if (this.bigEl.classList.contains('show') && now >= this.hideAt) {
        this.bigEl.classList.remove('show');
      }
    } else if (!this.queue.length && now >= this.hideAt && this.bigEl.classList.contains('show')) {
      this.bigEl.classList.remove('show');
    }
    while (this.infos.length && this.infos[0].until < now) {
      const e = this.infos.shift();
      e?.el.remove();
    }
  }
}

// ── Pickups ──────────────────────────────────────────────────────────────────

/**
 * What you just got, as compact lines (emblem + name) stacked just above the item bar —
 * never over the crosshair, and without the card text (that stays in the card's
 * tooltip, the long-press info and the 锦囊说明 in the menu) (COMBAT-8). The same
 * card again within a few seconds counts up on its line (×2) instead of a new one.
 */
export class PickupStrip {
  readonly el: HTMLElement;
  private rows: { id: string; el: HTMLElement; n: number; count: HTMLElement; until: number }[] = [];

  constructor(
    private readonly max = 4,
    /** seconds a line stays */
    private readonly ttl = 3.2,
  ) {
    this.el = h('div', { class: 'hud-pickups', aria: { live: 'polite' } });
  }

  push(id: string, now: number): void {
    const same = this.rows.find((r) => r.id === id && r.until > now);
    if (same) {
      same.n++;
      same.count.textContent = `×${same.n}`;
      same.until = now + this.ttl;
      // newest at the bottom, next to the bar
      this.el.appendChild(same.el);
      this.rows = [...this.rows.filter((r) => r !== same), same];
      return;
    }
    const count = h('b', { class: 'pk-n' });
    const el = h('div', { class: 'pk-row', data: { item: id } }, pickupIcon(id), h('span', { class: 'pk-t' }, t('hud.pickup', { name: pickupLabel(id) })), count);
    this.el.appendChild(el);
    this.rows.push({ id, el, n: 1, count, until: now + this.ttl });
    while (this.rows.length > this.max) this.rows.shift()?.el.remove();
  }

  update(now: number): void {
    while (this.rows.length && this.rows[0].until < now) {
      const r = this.rows.shift();
      if (!r) break;
      r.el.classList.add('out');
      setTimeout(() => r.el.remove(), 300);
    }
  }

  /** the lines shown now (tests / harness) */
  lines(): string[] {
    return this.rows.map((r) => r.el.textContent ?? '');
  }
}

/** A card / armor / mount / weapon name for the pickup line. */
function pickupLabel(id: string): string {
  const it = ITEM_BY_ID[id];
  return it ? tx(it.nameZh, it.nameEn) : gearName(id);
}

/** The emblem (its glyph until the art loads, or without art), or a weapon's render when it ships. */
function pickupIcon(id: string): HTMLElement | null {
  const ref = gearArt(id);
  if (ref?.shape === 'weapon') return gearIcon(id, 'pk-w');
  const def = ITEM_BY_ID[id] ?? ARMOR_BY_ID[id] ?? MOUNT_BY_ID[id];
  if (!def) return null;
  const glyph = ITEM_BY_ID[id]?.icon ?? def.nameZh.slice(0, 1);
  const tile = h('span', { class: 'pk-ico', style: `--ic:${def.color}` }, glyph);
  setArt(tile, ref, { first: true });
  return tile;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface HudChatLine {
  from: string;
  text: string;
  kind?: 'chat' | 'quick' | 'system' | 'claim';
  color?: string;
}

export class ChatBox {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly log: HTMLElement;
  private lines: { el: HTMLElement; at: number }[] = [];
  private recent: { key: string; at: number }[] = [];
  private open = false;

  private readonly sendBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;

  constructor(
    private readonly onSend: (text: string) => void,
    private readonly onClose: () => void,
    private readonly isTouch: () => boolean = () => false,
  ) {
    this.log = h('div', { class: 'log', role: 'log' });
    this.input = h('input', { class: 'sg-input dark', maxlength: 120, autocomplete: 'off', placeholder: t('chat.placeholder'), aria: { label: t('lobby.chat') } });
    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.submit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.input.value = '';
        this.onClose();
      }
    });
    // keep game keys from leaking while typing
    this.input.addEventListener('keyup', (ev) => ev.stopPropagation());
    // touch: explicit Send and ✕ (no Enter / Esc keys on a phone keyboard to rely on)
    this.sendBtn = h('button', { class: 'chat-send', type: 'button' }, t('lobby.send'));
    this.sendBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.submit();
    });
    this.closeBtn = h('button', { class: 'chat-close', type: 'button', aria: { label: t('common.close') }, title: t('common.close') }, '✕');
    this.closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.input.value = '';
      this.onClose();
    });
    this.el = h('div', { class: 'hud-chat' }, this.log, h('div', { class: 'input-row' }, this.input, this.sendBtn, this.closeBtn));
  }

  private submit(): void {
    const text = this.input.value.trim();
    this.input.value = '';
    if (text) this.onSend(text.slice(0, 120));
    this.onClose();
  }

  add(line: HudChatLine, now: number): void {
    // de-duplicate the same message arriving from both the session and the event stream
    const key = `${line.from}|${line.text}`;
    this.recent = this.recent.filter((r) => now - r.at < 1.5);
    if (this.recent.some((r) => r.key === key)) return;
    this.recent.push({ key, at: now });
    const el = h('div', { class: `line k-${line.kind ?? 'chat'}` }, line.from ? h('b', { style: line.color ? `color:${line.color}` : '' }, `${line.from}${colon()}`) : null, h('span', null, line.text));
    this.log.appendChild(el);
    this.lines.push({ el, at: now });
    while (this.lines.length > 40) this.lines.shift()?.el.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.el.classList.toggle('open', on);
    if (on) {
      this.input.placeholder = t(this.isTouch() ? 'chat.placeholderTouch' : 'chat.placeholder');
      this.sendBtn.textContent = t('lobby.send');
      this.input.focus();
      this.log.scrollTop = this.log.scrollHeight;
    } else this.input.blur();
  }

  update(now: number): void {
    if (this.open) return;
    for (const l of this.lines) {
      const old = now - l.at > 10;
      if (old !== l.el.classList.contains('old')) l.el.classList.toggle('old', old);
    }
  }
}
