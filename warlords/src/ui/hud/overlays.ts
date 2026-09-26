// In-match overlays: scoreboard (Tab), big map (M), claim / quick-chat wheel
// (T), pause menu (Esc).
import type { MapData } from '../../core/map';
import type { EntityId, ItemStack, PrivateHeroView, PublicPlayerView, RoleId } from '../../core/types';
import { ITEMS, ITEM_BY_ID, ROLE_BY_ID } from '../../data';
import { h, setClass, setText } from '../dom';
import { getLang, heroName, roleName, t, tx } from '../i18n';
import { displayName } from '../../game/names';
import { CLAIMABLE_ROLES, CLAIM_TEXT, QUICKCHAT, ROLE_GLYPH, cardTileVars, roleColor, roleInk } from '../theme';
import { itemShort } from '../short';
import { button, heroIcon, kingdomBadge, roleSeal, type PortraitCache } from '../widgets';
import { gearArt, roleCardPath } from '../cardArt';
import { artEl, artUrl, roleArt, roleCardBadge, setArt } from '../artIcons';
import { drawBigMap, type MarkerInput } from './minimap';

/**
 * Close button of an in-match overlay: the key that toggles it on desktop
 * (keycap, still clickable), a big ✕ on touch (`.sg-hud.touch` swaps them).
 */
export function overlayClose(key: string, onClose: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `hud-close ${cls}`.trim(), type: 'button', title: `${t('common.close')} (${key})`, aria: { label: t('common.close') } },
    h('span', { class: 'sg-key k' }, key),
    h('span', { class: 'x' }, '✕'),
  );
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClose();
  });
  return b;
}

// ── Scoreboard ───────────────────────────────────────────────────────────────

/** Is anyone but you and the bots in the match (someone whose ping means something)? */
export function hasRemotePlayers(players: readonly PublicPlayerView[], myEntity: EntityId | null): boolean {
  return players.some((p) => !p.isBot && p.entityId !== myEntity);
}

export class Scoreboard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly table: HTMLElement;
  private lastKey = '';
  /** hero icons per player + hero, reused across rebuilds so avatars never re-decode / flicker */
  private readonly icons = new Map<string, HTMLElement>();

  /** `portraits`: face avatars in the hero column when the painted portraits ship */
  constructor(
    onClose: () => void = () => undefined,
    private readonly portraits: PortraitCache | null = null,
  ) {
    this.body = h('tbody');
    this.statsEl = h('div', { class: 'sb-stats' });
    this.titleEl = h('h2', { class: 'sg-h2' }, t('score.title'));
    this.table = h('table', { class: 'sg-table no-ping' }, this.headRow(), this.body);
    this.el = h('div', { class: 'hud-scoreboard sg-panel sg-corners', role: 'dialog', aria: { label: t('score.title') } },
      h('div', { class: 'sb-head' }, this.titleEl, this.statsEl, overlayClose('Tab', onClose, 'sb-close')),
      h('div', { class: 'sg-table-wrap' }, this.table),
    );
  }

  private headRow(): HTMLElement {
    return h('thead', null, h('tr', null,
      h('th', { class: 'num' }, '#'),
      h('th', null, t('score.hero')),
      h('th', null, t('score.player')),
      h('th', null, t('score.role')),
      h('th', null, t('score.claim')),
      h('th', { class: 'num' }, t('score.kills')),
      h('th', null, t('score.status')),
      h('th', { class: 'num' }, t('score.ping')),
    ));
  }

  update(players: readonly PublicPlayerView[], me: PrivateHeroView | null, myEntity: EntityId | null): void {
    // 延迟 only means something with other people on the line: no column in single player / alone with bots (UX-19)
    setClass(this.table, 'no-ping', !hasRemotePlayers(players, myEntity));
    const key = JSON.stringify([players.map((p) => [p.entityId, p.alive, p.downed, p.role, p.claim, p.kills, p.ping, p.name, p.heroId]), me?.stats, me?.role, me?.knownAllies, getLang()]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const allies = new Set(me?.knownAllies ?? []);
    // 影武者 ↔ 主公: only these two know about each other
    const allyChip = (p: PublicPlayerView): HTMLElement | null => {
      if (!allies.has(p.entityId)) return null;
      const label = me?.role === 'lord' ? t('score.decoy') : me?.role === 'double' ? t('score.trueLord') : t('score.ally');
      return h('span', { class: 'sg-chip ally' }, label);
    };
    this.body.replaceChildren(
      ...sorted.map((p) => {
        const isMe = p.entityId === myEntity;
        const role: RoleId | undefined = p.role ?? (isMe ? me?.role : undefined);
        const status = !p.alive ? 'dead' : p.downed ? 'downed' : 'alive';
        return h('tr', { class: `${isMe ? 'me' : ''} ${status}` },
          h('td', { class: 'num' }, String(p.seat + 1)),
          h('td', null, h('span', { class: 'hero-cell' }, this.heroIcon(p), heroName(p.heroId))),
          h('td', null, displayName(p.name, getLang()), p.isBot ? h('span', { class: 'sg-chip bot' }, t('common.bot')) : null, allyChip(p)),
          h('td', null, role ? h('span', { class: 'role-cell', style: `color:${roleInk(role)}` }, this.roleIcon(p.entityId, role), roleName(role)) : h('span', { class: 'sg-mute' }, t('score.hidden'))),
          h('td', null, p.claim ? h('span', { class: 'role-cell claim', style: `color:${roleInk(p.claim)}` }, roleSeal(p.claim, '1.4em', true), roleName(p.claim)) : '—'),
          h('td', { class: 'num' }, String(p.kills)),
          h('td', null, h('span', { class: `st ${status}` }, t(status === 'dead' ? 'score.dead' : status === 'downed' ? 'score.downed' : 'score.alive'))),
          h('td', { class: 'num' }, p.isBot ? '—' : p.ping !== undefined ? `${Math.round(p.ping)}` : '—'),
        );
      }),
    );
    const st = me?.stats;
    this.statsEl.replaceChildren(
      ...(st
        ? [
            h('span', null, t('score.yourStats')),
            h('span', null, h('b', null, String(st.kills)), t('stat.kills')),
            h('span', null, h('b', null, String(Math.round(st.damage))), t('stat.damage')),
            h('span', null, h('b', null, String(Math.round(st.healing))), t('stat.healing')),
            h('span', null, h('b', null, String(st.rescues)), t('stat.rescues')),
          ]
        : []),
    );
  }

  /** The revealed role: its painted card when the art ships (cached like the avatars: no re-decode), else the seal. */
  private roleIcon(entityId: EntityId, role: RoleId): HTMLElement {
    const key = `role|${entityId}|${role}`;
    let el = this.icons.get(key);
    if (!el) {
      el = roleCardBadge(role, () => roleSeal(role, '1.5em'), 'sb-card');
      this.icons.set(key, el);
    }
    return el;
  }

  private heroIcon(p: PublicPlayerView): HTMLElement {
    const key = `${p.entityId}|${p.heroId}|${p.kingdom ?? ''}`;
    let el = this.icons.get(key);
    if (!el) {
      el = this.portraits ? heroIcon(this.portraits, p.heroId, p.kingdom, '1.5em') : kingdomBadge(p.kingdom, '1.5em');
      this.icons.set(key, el);
    }
    return el;
  }

  relabel(): void {
    this.lastKey = '';
    setText(this.titleEl, t('score.title'));
    const table = this.body.parentElement;
    table?.firstElementChild?.replaceWith(this.headRow());
  }
}

// ── Big map ──────────────────────────────────────────────────────────────────

export class BigMap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly title: HTMLElement;
  private readonly legend: HTMLElement;
  private lastDraw = 0;
  private cssSize = 0;
  private readonly ro: ResizeObserver | null;

  constructor(private readonly map: MapData, onClose: () => void = () => undefined) {
    this.canvas = h('canvas', { class: 'bm-canvas' });
    this.title = h('h2', { class: 'sg-h2' });
    this.legend = h('div', { class: 'bm-legend' });
    this.el = h('div', { class: 'hud-bigmap sg-dark', role: 'dialog' },
      h('div', { class: 'bm-head' }, this.title, overlayClose('M', onClose, 'bm-close')),
      h('div', { class: 'bm-frame' }, this.canvas),
      this.legend,
    );
    this.ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            for (const e of entries) this.cssSize = Math.min(e.contentRect.width, e.contentRect.height);
            this.lastDraw = 0;
          })
        : null;
    this.ro?.observe(this.canvas);
    if (!this.ro) this.cssSize = 600;
    this.relabel();
  }

  dispose(): void {
    this.ro?.disconnect();
  }

  relabel(): void {
    setText(this.title, `${t('map.title')} · ${tx(this.map.nameZh, this.map.nameEn)}`);
    const item = (cls: string, label: string): HTMLElement => h('span', { class: 'lg' }, h('i', { class: cls }), label);
    this.legend.replaceChildren(
      item('you', t('map.legend.you')),
      item('squad', t('map.legend.squad')),
      item('lord', t('map.legend.lord')),
      item('known', t('map.legend.known')),
      item('drop', t('map.legend.airdrop')),
      item('zone', t('map.legend.zone')),
      item('next', t('map.legend.next')),
    );
    this.lastDraw = 0;
  }

  draw(m: MarkerInput, now: number): void {
    if (now - this.lastDraw < 0.1) return;
    this.lastDraw = now;
    if (!this.cssSize) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.max(64, Math.round(this.cssSize * dpr));
    if (this.canvas.width !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
    }
    drawBigMap(this.canvas, this.map, m, getLang());
  }
}

// ── Claim / quick-chat wheel ─────────────────────────────────────────────────

export type WheelChoice = { kind: 'claim'; role: RoleId } | { kind: 'quick'; id: string };

export function wheelChoices(): WheelChoice[] {
  const claims: WheelChoice[] = CLAIMABLE_ROLES.map((role) => ({ kind: 'claim', role }));
  const quick: WheelChoice[] = QUICKCHAT.slice(0, 5).map((q) => ({ kind: 'quick', id: q.id }));
  return [...claims, ...quick];
}

export function wheelLabel(c: WheelChoice): string {
  if (c.kind === 'claim') {
    const txt = CLAIM_TEXT[c.role];
    return txt ? tx(txt.zh, txt.en) : roleName(c.role);
  }
  const q = QUICKCHAT.find((x) => x.id === c.id);
  return q ? tx(q.zh, q.en) : c.id;
}

export class Wheel {
  readonly el: HTMLElement;
  private choices: WheelChoice[] = wheelChoices();

  constructor(
    private readonly onPick: (c: WheelChoice) => void,
    private readonly onClose: () => void,
    private readonly isTouch: () => boolean = () => false,
  ) {
    this.el = h('div', { class: 'hud-wheel', role: 'dialog' });
    this.render();
  }

  render(): void {
    const n = this.choices.length;
    const items = this.choices.map((c, i) => {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      const b = h('button', {
        class: `wh-item ${c.kind}`,
        type: 'button',
        style: `--x:${(Math.cos(ang) * 50).toFixed(2)}%;--y:${(Math.sin(ang) * 50).toFixed(2)}%`,
        data: { index: i },
      },
        h('span', { class: 'num' }, String(i + 1)),
        c.kind === 'claim' ? h('span', { class: 'glyph', style: `--seal:${roleColor(c.role)}` }, ROLE_GLYPH[c.role]) : null,
        h('span', { class: 'lbl' }, wheelLabel(c)),
      );
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onPick(c);
      });
      return b;
    });
    const close = h('button', { class: 'wh-center', type: 'button', aria: { label: t('common.close') } }, h('span', { class: 'x' }, '✕'), h('span', { class: 'lbl' }, t('wheel.title')));
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onClose();
    });
    this.el.replaceChildren(h('div', { class: 'wh-ring' }, close, ...items), h('div', { class: 'wh-hint' }, t(this.isTouch() ? 'wheel.hintTouch' : 'wheel.hint')));
  }

  /** number key 1..n → choice */
  pickIndex(i: number): boolean {
    const c = this.choices[i];
    if (!c) return false;
    this.onPick(c);
    return true;
  }
}

// ── Pause menu ───────────────────────────────────────────────────────────────

export interface PauseActions {
  resume(): void;
  settings(): void;
  leave(): void;
  help(): void;
  /** online host only: end the match and bring everyone back to the lobby */
  endMatch?(): void;
}

export interface PauseContext {
  /** online match: the game keeps running behind the menu ("Menu", not "Paused") */
  online(): boolean;
  isHost(): boolean;
  /** your item slots (for the card guide) */
  items(): readonly (ItemStack | null)[];
  /** your role (the painted identity card reminder, when the art ships) */
  role?(): RoleId | undefined;
}

/** One card row of the 锦囊说明 list: glyph, name (+ count), one-line effect. */
export function cardRow(id: string, count?: number): HTMLElement {
  const def = ITEM_BY_ID[id];
  const glyph = h('span', { class: 'item-glyph', style: cardTileVars(def?.color ?? '#999999') }, def?.icon ?? id.slice(0, 1));
  // the card's painted emblem in a round frame when the art ships
  setArt(glyph, gearArt(id), { lazy: true });
  const el = h('li', { class: 'pc-card', data: { item: id } },
    glyph,
    h('div', { class: 'pc-text' },
      h('b', null, def ? tx(def.nameZh, def.nameEn) : id, count && count > 1 ? h('span', { class: 'cnt' }, ` ×${count}`) : null),
      h('span', { class: 'desc' }, def ? tx(def.descZh, def.descEn) : ''),
    ),
  );
  return el;
}

export class PauseMenu {
  readonly el: HTMLElement;
  private mode: 'menu' | 'click' = 'menu';
  private showAll = false;

  constructor(private readonly actions: PauseActions, private readonly ctx: PauseContext = { online: () => false, isHost: () => true, items: () => [] }) {
    this.el = h('div', { class: 'hud-pause', role: 'dialog' });
    // in "click to play" mode a click anywhere grabs the pointer again
    this.el.addEventListener('click', () => {
      if (this.mode === 'click') this.actions.resume();
    });
    this.render();
  }

  setMode(mode: 'menu' | 'click'): void {
    this.mode = mode;
    this.render();
  }

  private cards(again = false): HTMLElement {
    const held = this.ctx.items().filter((s): s is ItemStack => !!s && !!ITEM_BY_ID[s.id]);
    const heldList = held.length
      ? h('ul', { class: 'pc-list held' }, held.map((s) => cardRow(s.id, s.count)))
      : h('p', { class: 'sg-mute pc-none' }, t('pause.cardsNone'));
    const allBtn = h('button', { class: 'pc-all-toggle', type: 'button', aria: { expanded: this.showAll } }, `${t('pause.cardsAll')} (${ITEMS.length}) ${this.showAll ? '▴' : '▾'}`);
    allBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.showAll = !this.showAll;
      // only the card panel changes (the menu box keeps its place and focus)
      section.replaceWith(this.cards(true));
    });
    const section = h('section', { class: `pm-cards sg-panel sg-corners${again ? ' static' : ''}`, aria: { label: t('pause.cards') } },
      h('h3', { class: 'sg-h3' }, t('pause.cards')),
      h('div', { class: 'pc-scroll' },
        h('div', { class: 'pc-sub' }, t('pause.cardsHeld')),
        heldList,
        allBtn,
        this.showAll ? h('ul', { class: 'pc-list all' }, ITEMS.map((it) => cardRow(it.id))) : null,
      ),
    );
    return section;
  }

  /** Your identity card and goal (only with the painted card art: the menu is unchanged without it). */
  private roleReminder(): HTMLElement | null {
    const role = this.ctx.role?.();
    if (!role || !artUrl(roleCardPath(role))) return null;
    const def = ROLE_BY_ID[role];
    let el: HTMLElement | null = null;
    // a file that fails to load takes the whole reminder away (the menu as it was)
    const card = h('span', { class: 'sg-rcard pm-rcard' }, artEl(roleArt(role), { onFail: () => el?.remove() }));
    el = h('div', { class: 'pm-role' },
      card,
      h('div', { class: 'pm-rtext' },
        h('span', { class: 'yr' }, t('roles.yourRole')),
        h('b', null, roleName(role)),
        def ? h('span', { class: 'goal' }, tx(def.goalZh, def.goalEn)) : null,
      ),
    );
    el.style.setProperty('--rc', roleColor(role));
    el.style.setProperty('--ri', roleInk(role));
    return el;
  }

  render(): void {
    if (this.mode === 'click') {
      const prompt = h('button', { class: 'click-prompt', type: 'button' }, h('span', { class: 'sg-seal', style: '--sz:2.4em' }, h('span', null, '战')), h('span', null, t('hud.clickToPlay')));
      this.el.replaceChildren(prompt);
      this.el.dataset.mode = 'click';
      return;
    }
    const online = this.ctx.online();
    this.el.dataset.mode = 'menu';
    this.el.dataset.online = String(online);
    this.el.replaceChildren(
      h('div', { class: 'pm-wrap' },
        h('div', { class: 'pm-box sg-panel sg-corners' },
          h('h2', { class: 'sg-h2 sg-title-bar' }, online ? t('pause.menu') : t('pause.title')),
          online ? h('p', { class: 'pm-note' }, h('span', { class: 'live' }), t('pause.onlineNote')) : null,
          this.roleReminder(),
          button(t('pause.resume'), () => this.actions.resume(), { cls: 'gold wide', sfx: 'confirm' }),
          button(t('pause.settings'), () => this.actions.settings(), { cls: 'dark wide' }),
          button(t('pause.controls'), () => this.actions.help(), { cls: 'dark wide' }),
          online && this.ctx.isHost() && this.actions.endMatch ? button(t('pause.endMatch'), () => this.actions.endMatch?.(), { cls: 'dark wide pm-end' }) : null,
          button(t('pause.leave'), () => this.actions.leave(), { cls: 'wide', sfx: 'back' }),
        ),
        this.cards(),
      ),
    );
  }
}

/** Short card label under an item glyph (HUD item bar / touch item slots). */
export function cardLabel(id: string): string {
  return itemShort(id, getLang());
}
