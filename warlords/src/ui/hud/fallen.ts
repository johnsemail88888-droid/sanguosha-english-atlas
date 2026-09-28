// Downed → revived / dead → spectating, the PUBG / Apex way:
//  - DownedPanel: the world drains of colour (heartbeat vignette), a big bleed-out bar with the
//    seconds, who is reviving you (the bleed-out is paused meanwhile) and how to get up: 酒 / 桃
//    keys, F to call for a 桃, crawling
//  - ReviveMarkers: a 救 marker with the distance over downed heroes you may save (a known ally,
//    or anyone who called for help — the call is public; hidden roles stay hidden)
//  - ReviveRing: the reviver's progress ring around the crosshair
//  - KnockStamp: 「击倒」 when your damage downs someone — distinct from the 斩 kill stamp
//  - DeathCard: 被 X 用 Y 击杀, the damage you took in the last 10 s by source, the killer's
//    remaining HP, your role now public; 继续观战 / 返回大厅
//  - SpectatePanel: whose view it is (HP, public role only), ◀ ▶ / ← → / mouse buttons, the recap
//    and 返回大厅 at hand; online you keep spectating until the match ends
import type { EntityId, PublicPlayerView, RoleId, ViewEntity } from '../../core/types';
import { VF_DOWNED } from '../../core/types';
import { ABILITY_BY_ID } from '../../data';
import { displayName } from '../../game/names';
import { h, setClass, setText } from '../dom';
import { gearName, heroName, roleName, tx } from '../i18n';
import { roleColor } from '../theme';
import { button, keyCap, roleSeal, type PortraitCache } from '../widgets';
import { causeIcon } from './feed';
import { bleedText, type DeathRecap, type DownedMarker } from './deathlog';
import type { KillCause } from './killcause';
import type { HudFrame } from './types';
import { viewport } from './viewport';

const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
const BLEED_TOTAL = 12;

function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): void {
  if (canAnimate) el.animate(frames, opts);
}

/** The weapon / ability / card name of a kill cause. */
export function causeName(c: KillCause | null | undefined): string {
  if (!c) return '';
  if (c.kind === 'ability') {
    const a = ABILITY_BY_ID[c.id];
    return a ? tx(a.nameZh, a.nameEn) : c.id;
  }
  return gearName(c.id);
}

function faceOf(portraits: PortraitCache | null, heroId: string | undefined, cls = ''): HTMLElement | null {
  return heroId && portraits?.hasArt(heroId) ? portraits.avatar(heroId, cls) : null;
}

// ── Downed ───────────────────────────────────────────────────────────────────

export interface DownedCtx {
  /** "hero·player" of an entity (current language) */
  label(id: EntityId): string | null;
  /** seconds since you last called for help (Infinity: never) */
  sinceCall: number;
}

export class DownedPanel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly state: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly secs: HTMLElement;
  private readonly rescueRow: HTMLElement;
  private readonly rescueText: HTMLElement;
  private readonly rescueFill: HTMLElement;
  private readonly hints: HTMLElement;
  private on = false;
  private key = '';
  private secsShown = '';

  constructor() {
    this.title = h('div', { class: 'dn-ttl' });
    this.state = h('div', { class: 'dn-state' });
    this.fill = h('i', { class: 'dn-fill' });
    this.secs = h('b', { class: 'dn-secs' });
    this.rescueText = h('span', { class: 'dn-rtxt' });
    this.rescueFill = h('i');
    this.rescueRow = h('div', { class: 'dn-rescue sg-hidden' }, this.rescueText, h('div', { class: 'dn-rtrack' }, this.rescueFill));
    this.hints = h('div', { class: 'dn-hints' });
    this.el = h('div', { class: 'hud-fallen-downed' },
      h('div', { class: 'dn-tint' }),
      h('div', { class: 'dn-box' },
        h('div', { class: 'dn-head' }, this.title, this.state),
        h('div', { class: 'dn-bar' }, h('div', { class: 'dn-track' }, this.fill), this.secs),
        this.rescueRow,
        this.hints,
      ),
    );
  }

  update(f: HudFrame, ctx: DownedCtx): void {
    const me = f.me;
    const on = !!me && me.downed && !me.dead;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
      this.key = '';
    }
    if (!on || !me) return;
    const rem = Math.max(0, me.downedRemaining);
    const s = bleedText(rem);
    if (s !== this.secsShown) {
      this.secsShown = s;
      setText(this.secs, tx('{s} 秒', '{s} s', { s }));
    }
    this.fill.style.transform = `scaleX(${Math.min(1, rem / BLEED_TOTAL).toFixed(3)})`;
    const rescue = me.rescue;
    // eating your own 桃: your own channel (the bleed-out keeps running — C3-6)
    const selfRevive = !rescue && me.channel?.revive === me.entityId ? me.channel : null;
    const progress = rescue ? rescue.progress : selfRevive ? selfRevive.progress : 0;
    if (rescue || selfRevive) this.rescueFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress)).toFixed(3)})`;
    const jiu = me.items.findIndex((it) => it?.id === 'jiu');
    const tao = me.items.findIndex((it) => it?.id === 'tao');
    const called = ctx.sinceCall < 3 ? 2 : ctx.sinceCall < 15 ? 1 : 0;
    const k = `${f.lang}|${f.touch}|${rescue ? rescue.by : ''}|${selfRevive ? 1 : 0}|${jiu}|${tao}|${called}|${rem < 4 ? 1 : 0}|${me.squad.length > 0 ? 1 : 0}`;
    if (k === this.key) return;
    this.key = k;
    setText(this.title, tx('倒地', 'DOWNED'));
    setText(
      this.state,
      rescue ? tx('救援中 · 失血已暂停', 'Being revived · bleed-out paused') : selfRevive ? tx('自救中', 'Getting up') : rem < 4 ? tx('即将阵亡！', 'Bleeding out!') : tx('失血中', 'Bleeding out'),
    );
    setClass(this.el, 'saving', !!rescue);
    setClass(this.el, 'critical', !rescue && rem < 4);
    setClass(this.rescueRow, 'sg-hidden', !rescue && !selfRevive);
    if (rescue) setText(this.rescueText, tx('{name} 正在救你', '{name} is reviving you', { name: ctx.label(rescue.by) ?? '?' }));
    else if (selfRevive) setText(this.rescueText, tx('正在吃「桃」自救…', 'Eating your Peach…'));
    const rows: HTMLElement[] = [];
    const row = (key: string, text: string, cls = ''): void => {
      rows.push(h('div', { class: `dn-hint ${cls}`.trim() }, key && !f.touch ? keyCap(key) : null, h('span', null, text)));
    };
    if (jiu >= 0) row(String(4 + jiu), tx('饮「酒」立刻起身', 'Drink Wine: back up at once'), 'good');
    if (tao >= 0) row(String(4 + tao), tx('吃「桃」自救（需 1.5 秒，趁早）', 'Eat your Peach (takes 1.5 s: do not wait)'), 'good');
    if (called === 2) row('F', tx('已呼救：附近的人会在地图上看到你', 'Help called: nearby players see you on the map'), 'done');
    else row('F', f.touch ? tx('点「呼救」喊「需要桃！」（你的位置会暴露）', 'Tap Call: “I need a Peach!” (shows where you are)') : tx('呼救「需要桃！」（你的位置会暴露）', 'Call “I need a Peach!” (shows where you are)'));
    row(f.touch ? '' : 'WASD', tx('爬向掩体 · 中弹会加速失血', 'Crawl to cover · hits drain the bleed-out'), 'dim');
    // your squad still fights: point them at whoever is on you
    if (me.squad.length > 0 && !f.touch) row(tx('中键', 'MMB'), tx('标记敌人，部曲集火', 'Mark an enemy: your squad focuses him'), 'dim');
    this.hints.replaceChildren(...rows);
  }

  relabel(): void {
    this.key = '';
    this.secsShown = '';
  }
}

// ── Revive markers (world) ───────────────────────────────────────────────────

interface MarkEl {
  el: HTMLElement;
  dist: HTMLElement;
  name: HTMLElement;
  id: EntityId;
  shown: boolean;
  cls: string;
  txt: string;
}

export class ReviveMarkers {
  readonly el: HTMLElement;
  private readonly pool: MarkEl[] = [];

  constructor(
    private readonly project: ((p: { x: number; y: number; z: number }) => { x: number; y: number } | null) | undefined,
    private readonly label: (id: EntityId) => string | null,
  ) {
    this.el = h('div', { class: 'hud-rv-marks' });
  }

  update(marks: readonly DownedMarker[], lang: string): void {
    const n = this.project ? Math.min(marks.length, 6) : 0;
    const vp = viewport();
    for (let i = 0; i < n; i++) {
      const m = marks[i];
      // above the downed hero's (low) nameplate
      const p = this.project!({ x: m.x, y: m.y + 1.7, z: m.z });
      const el = this.slot(i);
      const inside = !!p && p.x > -40 && p.y > -40 && p.x < vp.w + 40 && p.y < vp.h + 40;
      if (!inside || !p) {
        this.show(el, false);
        continue;
      }
      this.show(el, true);
      el.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      const cls = `rv-mark${m.reviving ? ' reviving' : ''}${m.ally ? ' ally' : ''}${m.called && !m.reviving ? ' called' : ''}`;
      if (cls !== el.cls) {
        el.cls = cls;
        el.el.className = cls;
      }
      const d = `${Math.round(m.dist)}m`;
      const txt = `${m.id}|${lang}|${m.reviving ? 1 : 0}|${d}`;
      if (txt !== el.txt) {
        el.txt = txt;
        setText(el.dist, m.reviving ? tx('救援中', 'Reviving') : d);
        if (el.id !== m.id) {
          el.id = m.id;
          setText(el.name, this.label(m.id) ?? '');
        }
      }
    }
    for (let i = n; i < this.pool.length; i++) this.show(this.pool[i], false);
  }

  relabel(): void {
    for (const m of this.pool) {
      m.txt = '';
      m.id = -1;
    }
  }

  private slot(i: number): MarkEl {
    let m = this.pool[i];
    if (!m) {
      const dist = h('b', { class: 'rv-dist' });
      const name = h('span', { class: 'rv-name' });
      const el = h('div', { class: 'rv-mark' }, h('span', { class: 'rv-ico' }, h('span', null, '救')), dist, name);
      el.style.display = 'none';
      this.el.appendChild(el);
      m = { el, dist, name, id: -1, shown: false, cls: 'rv-mark', txt: '' };
      this.pool[i] = m;
    }
    return m;
  }

  private show(m: MarkEl, on: boolean): void {
    if (m.shown === on) return;
    m.shown = on;
    m.el.style.display = on ? '' : 'none';
  }
}

// ── Reviver's progress ring ──────────────────────────────────────────────────

const RING_R = 30;
const RING_C = 2 * Math.PI * RING_R;

export class ReviveRing {
  readonly el: HTMLElement;
  private readonly fg: SVGCircleElement;
  private readonly text: HTMLElement;
  private readonly pct: HTMLElement;
  private on = false;
  private key = '';

  constructor(private readonly label: (id: EntityId) => string | null) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 72 72');
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('class', 'bg');
    this.fg = document.createElementNS(NS, 'circle');
    this.fg.setAttribute('class', 'fg');
    for (const c of [bg, this.fg]) {
      c.setAttribute('cx', '36');
      c.setAttribute('cy', '36');
      c.setAttribute('r', String(RING_R));
      svg.appendChild(c);
    }
    this.fg.setAttribute('stroke-dasharray', RING_C.toFixed(1));
    this.pct = h('b', { class: 'rr-pct' });
    this.text = h('div', { class: 'rr-txt' });
    this.el = h('div', { class: 'hud-rv-ring' }, h('div', { class: 'rr-wrap' }, svg, this.pct), this.text);
  }

  /** true while the ring shows (the HUD hides the plain channel bar meanwhile) */
  update(f: HudFrame): boolean {
    const me = f.me;
    const ch = me && !me.dead && !me.downed ? me.channel : null;
    const target = ch?.revive;
    const on = target !== undefined && target !== me?.entityId;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
      this.key = '';
    }
    if (!on || !ch || target === undefined) return false;
    const p = Math.max(0, Math.min(1, ch.progress));
    this.fg.setAttribute('stroke-dashoffset', (RING_C * (1 - p)).toFixed(1));
    setText(this.pct, `${Math.round(p * 100)}%`);
    const k = `${target}|${f.lang}`;
    if (k !== this.key) {
      this.key = k;
      setText(this.text, tx('救援 {name} · 别松手', 'Reviving {name} · keep holding', { name: this.label(target) ?? '?' }));
    }
    return true;
  }

  relabel(): void {
    this.key = '';
  }
}

// ── 击倒 stamp ────────────────────────────────────────────────────────────────

export class KnockStamp {
  readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly sub: HTMLElement;

  constructor() {
    this.label = h('span', { class: 'lbl' });
    this.sub = h('span', { class: 'sub' });
    this.el = h('div', { class: 'hud-knockstamp' }, h('span', { class: 'ks-seal' }, h('span', null, '倒')), this.label, this.sub);
  }

  show(victim: string): void {
    setText(this.label, tx('击倒 {name}', 'Knocked {name}', { name: victim }));
    setText(this.sub, tx('补刀，或等他失血', 'Finish him, or let him bleed out'));
    play(this.el, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.8)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.15 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' },
    ], { duration: 1400, easing: 'ease-out' });
  }
}

// ── Death recap card ─────────────────────────────────────────────────────────

export interface DeathCardInput {
  recap: DeathRecap;
  /** your role (now public) */
  role: RoleId | undefined;
  /** the killer's hero + public view as it was at the moment of death (null: the zone / nobody) */
  killer: { id: EntityId; heroId?: string; hp: number; maxHp: number; role?: RoleId; claim?: RoleId; dist: number | null } | null;
  label(id: EntityId): string | null;
  heroOf(id: EntityId): string | undefined;
  /** online: the match goes on without you (keep spectating till the end) */
  online: boolean;
}

export class DeathCard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private open = false;
  private last: DeathCardInput | null = null;

  constructor(
    private readonly portraits: PortraitCache | null,
    private readonly onSpectate: () => void,
    private readonly onLeave: () => void,
  ) {
    this.body = h('div', { class: 'dc-body' });
    this.el = h('div', { class: 'hud-deathcard sg-dark sg-corners', role: 'dialog' }, this.body);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get hasRecap(): boolean {
    return this.last !== null;
  }

  show(inp: DeathCardInput): void {
    this.last = inp;
    this.render();
    this.setOpen(true);
    // (opacity only: where the card sits is up to the CSS — a side card, or a centred sheet on phones)
    play(this.el, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  }

  /** reopen the last recap (spectate panel's 死亡回顾) */
  reopen(): void {
    if (!this.last) return;
    this.render();
    this.setOpen(true);
  }

  hide(): void {
    this.setOpen(false);
  }

  /** a new life (revived after all, a new match): forget it */
  reset(): void {
    this.last = null;
    this.setOpen(false);
  }

  relabel(): void {
    if (this.open) this.render();
  }

  private setOpen(on: boolean): void {
    this.open = on;
    setClass(this.el, 'on', on);
  }

  private render(): void {
    const inp = this.last;
    if (!inp) return;
    const r = inp.recap;
    const k = inp.killer;
    const killerName = k ? inp.label(k.id) ?? '?' : '';
    const how = causeName(r.cause);
    // headline: 被 X 用 Y 击杀 / 倒在烽火圈里 / 失血而亡
    let line: string;
    if (k) line = how ? tx('被 {k} 用「{w}」击杀', 'Killed by {k} with {w}', { k: killerName, w: how }) : tx('被 {k} 击杀', 'Killed by {k}', { k: killerName });
    else if (r.rows.some((x) => x.zone)) line = tx('倒在了烽火圈外', 'Fell to the beacon fire zone');
    else line = tx('失血而亡', 'Bled out');
    const head = h('div', { class: 'dc-head' },
      h('div', { class: 'dc-ttl' }, tx('阵亡', 'ELIMINATED')),
      inp.role ? h('div', { class: 'dc-role' }, h('span', null, tx('你的身份已公开', 'Your role is now public')), roleSeal(inp.role, '1.5em'), h('b', { style: `color:${roleColor(inp.role)}` }, roleName(inp.role))) : null,
    );
    const killerBox = h('div', { class: 'dc-killer' },
      k ? faceOf(this.portraits, k.heroId, 'dc-ava') : null,
      h('div', { class: 'dc-kinfo' },
        h('div', { class: 'dc-line' }, line, k && r.cause ? causeIcon(r.cause) : null),
        k ? this.killerStats(k) : null,
        r.downedBy !== null && r.downedBy !== k?.id ? h('div', { class: 'dc-sub' }, tx('先被 {n} 击倒', 'Knocked down first by {n}', { n: inp.label(r.downedBy) ?? '?' })) : null,
      ),
    );
    const rows = r.rows.slice(0, 5).map((row) => {
      const name = row.src !== null ? inp.label(row.src) ?? '?' : row.zone ? tx('烽火圈', 'The zone') : tx('其他', 'Other');
      const hero = row.src !== null ? inp.heroOf(row.src) : undefined;
      const tags: HTMLElement[] = [];
      if (row.src !== null && row.src === r.killer) tags.push(h('span', { class: 'dc-tag kill' }, tx('击杀', 'kill')));
      if (row.src !== null && row.src === r.downedBy) tags.unshift(h('span', { class: 'dc-tag knock' }, tx('击倒', 'knock')));
      const causes = row.causes.slice(0, 2).map((c) => causeName(c)).filter(Boolean).join(' · ');
      const detail = tx('{n} 次命中', '{n} hits', { n: row.hits }) + (row.heads ? tx(' · 爆头 {h}', ' · {h} headshots', { h: row.heads }) : '');
      const el = h('div', { class: 'dc-row' },
        faceOf(this.portraits, hero, 'dc-rava'),
        h('div', { class: 'dc-who' }, h('span', { class: 'n' }, name, ...tags), h('small', null, causes ? `${causes} · ${detail}` : detail)),
        h('b', { class: 'dc-dmg' }, String(row.total)),
      );
      return el;
    });
    const recap = h('div', { class: 'dc-recap' },
      h('div', { class: 'dc-rhead' }, h('span', null, tx('最近 {s} 秒受到的伤害', 'Damage taken, last {s} s', { s: r.window })), h('b', null, tx('共 {n}', 'Total {n}', { n: r.total }))),
      rows.length ? h('div', { class: 'dc-rows' }, ...rows) : h('div', { class: 'dc-none' }, tx('（没有记录）', '(nothing recorded)')),
    );
    const spectate = button(h('span', null, tx('继续观战', 'Keep spectating'), ' ', keyCap('Space')), () => this.onSpectate(), { cls: 'gold small' });
    const leave = button(tx('返回大厅', 'Back to lobby'), () => this.onLeave(), { cls: 'dark small' });
    const note = h('div', { class: 'dc-note' },
      inp.online
        ? tx('对局仍在进行：你可以一直观战到结束，身份依旧保密。', 'The match goes on: spectate until it ends. Hidden roles stay hidden.')
        : tx('←/→ 或鼠标左/右键切换观战对象', '←/→ or left/right mouse button to switch view'),
    );
    this.body.replaceChildren(head, killerBox, recap, h('div', { class: 'dc-actions' }, spectate, leave), note);
  }

  private killerStats(k: NonNullable<DeathCardInput['killer']>): HTMLElement {
    const frac = k.maxHp > 0 ? Math.max(0, Math.min(1, k.hp / k.maxHp)) : 0;
    const role = k.role ? h('span', { class: 'dc-krole', style: `color:${roleColor(k.role)}` }, roleName(k.role)) : k.claim ? h('span', { class: 'dc-krole claim' }, tx('自称{r}', 'claims {r}', { r: roleName(k.claim) })) : h('span', { class: 'dc-krole unknown' }, tx('身份未知', 'role hidden'));
    return h('div', { class: 'dc-kstats' },
      h('span', null, tx('对方剩余体力', 'Their HP')),
      h('span', { class: 'dc-hp' }, h('i', { style: `transform:scaleX(${frac.toFixed(3)})` })),
      h('b', null, `${Math.max(0, Math.round(k.hp))}/${Math.round(k.maxHp)}`),
      role,
      k.dist !== null ? h('span', { class: 'dc-dist' }, `${Math.round(k.dist)}m`) : null,
    );
  }
}

// ── Spectate panel ───────────────────────────────────────────────────────────

/** Who killed you (the panel marks him when you watch him). */
export type KillerRef = { entityId: EntityId } | { zone: true } | null;

export class SpectatePanel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly face: HTMLElement;
  private readonly who: HTMLElement;
  private readonly tag: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly role: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly recapBtn: HTMLButtonElement;
  private on = false;
  private key = '';
  private hpKey = '';
  killer: KillerRef = null;

  constructor(
    private readonly cycle: (dir: 1 | -1) => void,
    private readonly label: (id: EntityId) => string | null,
    private readonly portraits: PortraitCache | null,
    private readonly onRecap: () => void,
    private readonly onLeave: () => void,
  ) {
    this.title = h('div', { class: 'sp-ttl' });
    this.face = h('span', { class: 'sp-face' });
    this.who = h('span', { class: 'sp-who' });
    this.tag = h('span', { class: 'sp-tag sg-hidden' });
    this.hpFill = h('i');
    this.hpText = h('small', { class: 'sp-hpt' });
    this.role = h('span', { class: 'sp-role' });
    this.hint = h('div', { class: 'sp-hint' });
    const prev = h('button', { class: 'sg-btn small dark sp-nav', type: 'button', title: tx('上一位', 'Previous') }, '◀');
    const next = h('button', { class: 'sg-btn small dark sp-nav', type: 'button', title: tx('下一位', 'Next') }, '▶');
    prev.addEventListener('click', () => this.cycle(-1));
    next.addEventListener('click', () => this.cycle(1));
    this.recapBtn = button(tx('死亡回顾', 'Death recap'), () => this.onRecap(), { cls: 'dark small' });
    const leave = button(tx('返回大厅', 'Back to lobby'), () => this.onLeave(), { cls: 'dark small' });
    this.el = h('div', { class: 'hud-spectate2' },
      this.title,
      h('div', { class: 'sp-main' },
        prev,
        h('div', { class: 'sp-target' }, this.face, h('div', { class: 'sp-col' }, h('div', { class: 'sp-line' }, this.who, this.tag, this.role), h('div', { class: 'sp-hp' }, h('span', { class: 'sp-track' }, this.hpFill), this.hpText))),
        next,
      ),
      h('div', { class: 'sp-foot' }, this.hint, this.recapBtn, leave),
    );
  }

  update(f: HudFrame, cardOpen: boolean, hasRecap: boolean): void {
    const on = !!f.me?.dead;
    if (on !== this.on) {
      this.on = on;
      setClass(this.el, 'on', on);
      this.key = '';
    }
    if (!on) return;
    setClass(this.el, 'behind-card', cardOpen);
    let target: PublicPlayerView | undefined;
    for (const p of f.players) {
      if (p.entityId === f.spectateId) {
        target = p;
        break;
      }
    }
    const ent: ViewEntity | undefined = target ? f.ents.find((e) => e.id === target!.entityId) : undefined;
    const killerId = this.killer && 'entityId' in this.killer ? this.killer.entityId : null;
    const role = target?.role ?? ent?.role;
    const k = `${f.lang}|${f.touch}|${target?.entityId ?? -1}|${killerId}|${role ?? ''}|${target?.claim ?? ''}|${hasRecap}|${ent ? ent.flags & VF_DOWNED : 0}`;
    if (k !== this.key) {
      this.key = k;
      setText(this.title, tx('你已阵亡 · 观战中', 'You have fallen · spectating'));
      setText(this.who, target ? `${heroName(target.heroId)}·${displayName(target.name, f.lang)}` : tx('没有可观战的武将', 'Nobody left to watch'));
      const isKiller = target !== undefined && target.entityId === killerId;
      setText(this.tag, isKiller ? tx('击杀你的人', 'your killer') : '');
      setClass(this.tag, 'sg-hidden', !isKiller);
      // public roles only (the Lord, the dead, a claim) — a spectator learns nothing hidden
      this.role.replaceChildren(
        ...(role ? [roleSeal(role, '1.2em'), h('span', { style: `color:${roleColor(role)}` }, roleName(role))] : target?.claim ? [h('span', { class: 'claim' }, tx('自称{r}', 'claims {r}', { r: roleName(target.claim) }))] : []),
      );
      const heroId = target?.heroId ?? '';
      if (this.face.dataset.hero !== heroId) {
        this.face.dataset.hero = heroId;
        const fc = faceOf(this.portraits, heroId || undefined);
        this.face.replaceChildren(...(fc ? [fc] : []));
      }
      setText(this.hint, f.touch ? tx('点 ◀ ▶ 切换', 'Tap ◀ ▶ to switch') : tx('←/→ 或鼠标左/右键切换', '←/→ or left/right click to switch'));
      setClass(this.recapBtn, 'sg-hidden', !hasRecap);
    }
    const hp = ent ? `${Math.ceil(ent.hp)}/${ent.maxHp}${ent.flags & VF_DOWNED ? tx(' · 倒地', ' · downed') : ''}` : '';
    if (hp !== this.hpKey) {
      this.hpKey = hp;
      setText(this.hpText, hp);
      this.hpFill.style.transform = `scaleX(${ent && ent.maxHp > 0 ? Math.max(0, Math.min(1, ent.hp / ent.maxHp)).toFixed(3) : '0'})`;
    }
  }

  relabel(): void {
    this.key = '';
    this.hpKey = '';
  }
}

/** The killer as the death card shows him: public information only. */
export function killerSnapshot(id: EntityId | undefined, ents: readonly ViewEntity[], players: readonly PublicPlayerView[], from: { x: number; z: number } | undefined): DeathCardInput['killer'] {
  if (id === undefined) return null;
  const e = ents.find((x) => x.id === id);
  const p = players.find((x) => x.entityId === id);
  if (!e && !p) return null;
  return {
    id,
    heroId: p?.heroId ?? (e?.kind === 'hero' ? e.sub : undefined),
    hp: e?.hp ?? 0,
    maxHp: e?.maxHp ?? 0,
    role: p?.role ?? e?.role,
    claim: p?.claim ?? e?.claim,
    dist: e && from ? Math.hypot(e.x - from.x, e.z - from.z) : null,
  };
}

