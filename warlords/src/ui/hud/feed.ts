// Kill feed (with role-reveal colors), center announcements, and chat log.
import type { Kingdom, RoleId } from '../../core/types';
import { h } from '../dom';
import { heroName, roleName, t } from '../i18n';
import { ROLE_GLYPH, kingdomColor, roleColor } from '../theme';

export interface FeedParty {
  name: string;
  heroId?: string;
  kingdom?: Kingdom;
  role?: RoleId;
}

// ── Kill feed ────────────────────────────────────────────────────────────────

export class KillFeed {
  readonly el: HTMLElement;
  private entries: { el: HTMLElement; until: number }[] = [];

  constructor(private readonly max = 6) {
    this.el = h('div', { class: 'hud-feed', aria: { live: 'polite' } });
  }

  private party(p: FeedParty | null, cls: string): HTMLElement {
    if (!p) return h('span', { class: `who ${cls} zone` }, t('hud.zoneDeath'));
    const el = h('span', { class: `who ${cls}` }, p.heroId ? heroName(p.heroId) : p.name, p.heroId && p.name ? h('small', null, p.name) : null);
    el.style.setProperty('--kc', kingdomColor(p.kingdom));
    return el;
  }

  /** "killer 斩 victim [role]" (killer null = zone / unknown). */
  push(killer: FeedParty | null, victim: FeedParty, opts: { downed?: boolean; mine?: boolean; aboutMe?: boolean; now: number }): void {
    const role = victim.role;
    const roleEl = role
      ? h('span', { class: 'rseal', style: `--seal:${roleColor(role)}`, title: roleName(role) }, ROLE_GLYPH[role], h('small', null, roleName(role)))
      : null;
    const el = h('div', { class: `kf${opts.mine ? ' mine' : ''}${opts.aboutMe ? ' me' : ''}${opts.downed ? ' downed' : ''}` },
      this.party(killer, 'k'),
      h('span', { class: 'verb' }, opts.downed ? '倒' : '斩'),
      this.party(victim, 'v'),
      roleEl,
    );
    this.el.appendChild(el);
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
  private queue: { text: string; kind: AnnKind; sub?: string }[] = [];
  private showingUntil = 0;
  private hideAt = 0;
  private infos: { el: HTMLElement; until: number }[] = [];

  constructor() {
    this.bigEl = h('div', { class: 'ann-big' });
    this.infoEl = h('div', { class: 'ann-info' });
    this.el = h('div', { class: 'hud-announce' }, this.bigEl, this.infoEl);
  }

  push(text: string, kind: AnnKind = 'info', sub?: string, now = performance.now() / 1000): void {
    if (kind === 'info') {
      const el = h('div', { class: 'line' }, text);
      this.infoEl.appendChild(el);
      this.infos.push({ el, until: now + 4 });
      while (this.infos.length > 3) this.infos.shift()?.el.remove();
      return;
    }
    // drop duplicates already queued
    if (this.queue.some((q) => q.text === text)) return;
    this.queue.push({ text, kind, sub });
    if (this.queue.length > 4) this.queue.shift();
  }

  update(now: number): void {
    if (now >= this.showingUntil) {
      const next = this.queue.shift();
      if (next) {
        this.bigEl.replaceChildren(h('div', { class: `msg ${next.kind}` }, h('span', { class: 't' }, next.text), next.sub ? h('span', { class: 's' }, next.sub) : null));
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

  constructor(private readonly onSend: (text: string) => void, private readonly onClose: () => void) {
    this.log = h('div', { class: 'log', role: 'log' });
    this.input = h('input', { class: 'sg-input dark', maxlength: 120, autocomplete: 'off', placeholder: t('chat.placeholder'), aria: { label: t('lobby.chat') } });
    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const text = this.input.value.trim();
        this.input.value = '';
        if (text) this.onSend(text.slice(0, 120));
        this.onClose();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.input.value = '';
        this.onClose();
      }
    });
    // keep game keys from leaking while typing
    this.input.addEventListener('keyup', (ev) => ev.stopPropagation());
    this.el = h('div', { class: 'hud-chat' }, this.log, h('div', { class: 'input-row' }, this.input));
  }

  add(line: HudChatLine, now: number): void {
    // de-duplicate the same message arriving from both the session and the event stream
    const key = `${line.from}|${line.text}`;
    this.recent = this.recent.filter((r) => now - r.at < 1.5);
    if (this.recent.some((r) => r.key === key)) return;
    this.recent.push({ key, at: now });
    const el = h('div', { class: `line k-${line.kind ?? 'chat'}` }, line.from ? h('b', { style: line.color ? `color:${line.color}` : '' }, `${line.from}：`) : null, h('span', null, line.text));
    this.log.appendChild(el);
    this.lines.push({ el, at: now });
    while (this.lines.length > 40) this.lines.shift()?.el.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.el.classList.toggle('open', on);
    if (on) {
      this.input.placeholder = t('chat.placeholder');
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
