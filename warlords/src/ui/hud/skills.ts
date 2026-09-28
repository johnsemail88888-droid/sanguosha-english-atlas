// In-match skill clarity (the HUD side of data/skillInfo.ts):
//  - SkillTooltip: what a skill does, over the ability bar, while hovering its icon or
//    holding its key (the one-line summary, the key numbers, how to cast it);
//  - SkillAimHint: over the crosshair while a skill key is held — 「松开 Q 施放 → 孙权 · 右键取消」,
//    or what is missing (「孙权 20 米 · 太远（12 米内）」) when releasing now would do nothing;
//  - SkillCastTracker + SkillCastFeed: what a cast of yours did — 「青龙斩 命中 3」,
//    「义绝 → 张飞 · 沉默」, 「未命中」 — from the event stream;
//  - SelfCcBanner: what an enemy skill does to you — 「沉默 5.8 秒 · 不能放技能 ← 关羽「义绝」」;
//  - SkillReadyTips: the first time each skill is ready in a match, one line about it (the
//    first few matches with that hero).
import type { AbilitySlot, EntityId, GameEvent, StatusId } from '../../core/types';
import { ABILITY_BY_ID, ABILITY_HERO, HERO_BY_ID, ITEM_BY_ID, STATUS_HINT_BY_ID, isPassiveAbility } from '../../data';
import type { AbilityDef } from '../../data/types';
import { AIM_LABEL, skillAim, skillArea, skillLine, fmtNum } from '../../data/skillInfo';
import type { PreviewStatus } from '../../render/vfx/skillPreview';
import { h, setClass, setText } from '../dom';
import { aimTag, castHint, skillChips, skillLineEl } from '../skillCard';
import { abilityReady, hudAbilities } from './logic';
import type { HudFrame } from './types';

type Lang = 'zh' | 'en';
const SLOT_KEY: Record<AbilityDef['slot'], string> = { passive: '', q: 'Q', e: 'E', lord: 'G' };
const tr = (lang: Lang, zh: string, en: string): string => (lang === 'en' ? en : zh);
const nameOf = (def: AbilityDef, lang: Lang): string => (lang === 'en' ? def.nameEn : def.nameZh);

// ── tooltip ──────────────────────────────────────────────────────────────────

/** key-number chips in the HUD tooltip at most (skillStats puts what matters first) */
export const TOOLTIP_CHIPS = 5;

export class SkillTooltip {
  readonly el: HTMLElement;
  private key = '';

  constructor() {
    this.el = h('div', { class: 'hud-sktip', role: 'tooltip' });
  }

  /**
   * Show `def` (`held`: its key is down — the short form: no long rules, no "how to cast" (the
   * hint by the crosshair says it), see-through so the ground near you still shows).
   */
  show(def: AbilityDef, lang: Lang, held: boolean, lordOnly = false): void {
    const key = `${def.id}|${lang}|${held ? 1 : 0}`;
    if (key !== this.key) {
      this.key = key;
      const passive = isPassiveAbility(def);
      const k = SLOT_KEY[def.slot];
      const hint = passive ? tr(lang, '被动：满足条件时自动生效', 'Passive: works on its own') : castHint(def, k, lang);
      const parts: (HTMLElement | null)[] = [
        h('div', { class: 'tt-head' },
          h('span', { class: `tt-key k-${passive ? 'passive' : def.slot}` }, passive ? tr(lang, '被动', 'Passive') : k),
          h('span', { class: 'tt-name' }, nameOf(def, lang)),
          passive ? null : aimTag(def, lang),
        ),
        skillLineEl(def, lang),
        skillChips(def, lang, { max: TOOLTIP_CHIPS }),
        hint && !held ? h('div', { class: 'tt-hint' }, hint) : null,
        lordOnly ? h('div', { class: 'tt-hint' }, tr(lang, '主公技：只有主公能用', 'Lord skill: only the Lord can use it')) : null,
        held ? null : h('div', { class: 'tt-desc' }, lang === 'en' ? def.descEn : def.descZh),
      ];
      this.el.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
      setClass(this.el, 'held', held);
    }
    setClass(this.el, 'on', true);
  }

  hide(): void {
    setClass(this.el, 'on', false);
  }

  get shown(): boolean {
    return this.el.classList.contains('on');
  }
}

// ── held-skill hint by the crosshair ─────────────────────────────────────────

/** What the hint reads for a held skill: its name, what releasing does (or lacks), and how it reads. */
export interface AimHint {
  name: string;
  how: string;
  /** releasing now does nothing (red) */
  bad: boolean;
  /** it casts, but not quite as aimed (amber): past the range, nobody near 反间's target … */
  warn: boolean;
}

/** Names the hint needs: the picked unit and the one it is turned on (反间 / 离间). */
export interface AimNames {
  target?: string | null;
  link?: string | null;
}

/**
 * The hint's text for a held skill: how to cast it, or what it is still missing.
 * `st`: what releasing now would do (render/vfx/skillPreview.ts PreviewStatus; a bare
 * boolean: valid or not).
 */
export function aimHintText(def: AbilityDef, key: string, st: PreviewStatus | boolean, lang: Lang, names: AimNames = {}): AimHint {
  const s: PreviewStatus = typeof st === 'boolean' ? { valid: st } : st;
  const name = nameOf(def, lang);
  const area = skillArea(def);
  const who = names.target ?? tr(lang, '目标', 'the target');
  const m = (v: number): string => tr(lang, `${Math.round(v)} 米`, `${Math.round(v)} m`);
  const cancel = tr(lang, '右键取消', 'right click cancels');
  if (!s.valid) {
    const bad = (how: string): AimHint => ({ name, how, bad: true, warn: false });
    if (area?.kind === 'target') {
      if (s.reason === 'far' && s.dist !== undefined) return bad(tr(lang, `${who} ${m(s.dist)} · 太远（${fmtNum(area.range)} 米内）`, `${who} ${m(s.dist)} · too far (within ${fmtNum(area.range)} m)`));
      if (s.reason === 'alone' && area.link) return bad(tr(lang, `${who} 身边 ${fmtNum(area.link.radius)} 米内无人可离间`, `Nobody within ${fmtNum(area.link.radius)} m of ${who} to turn it on`));
      // (结姻 takes a male hero only)
      const any = area.side === 'enemy' ? tr(lang, '一名敌人', 'an enemy') : area.maleOnly || def.params.maleOnly ? tr(lang, '一名男性武将', 'a male hero') : tr(lang, '一名武将', 'a hero');
      return bad(tr(lang, `准星对准${any}（${fmtNum(area.range)} 米内）`, `Put the crosshair on ${any} (within ${fmtNum(area.range)} m)`));
    }
    return bad(tr(lang, `现在松开不会施放 · ${cancel}`, `Releasing now does nothing · ${cancel}`));
  }
  const parts: string[] = [tr(lang, `松开 ${key} 施放`, `Release ${key} to cast`)];
  let warn = false;
  if (area?.kind === 'target') {
    if (s.reason === 'far' && s.dist !== undefined) {
      // aimed past the range, but the skill works without a target (青囊 on you, 宁教's free charge)
      warn = true;
      parts[0] = tr(lang, `${who} ${m(s.dist)} · 太远`, `${who} ${m(s.dist)} · too far`);
      parts.push(area.side === 'ally' ? tr(lang, `松开 ${key} 对自己施放`, `release ${key}: on yourself`) : tr(lang, `松开 ${key} 不指定目标`, `release ${key}: no target`));
    } else if (s.targetId !== undefined && names.target) {
      if (s.fallback === 'disarm') {
        warn = true;
        parts.push(tr(lang, `${names.target} 身边无人 → 改为缴械 ${fmtNum(def.params.disarm ?? 0)} 秒`, `nobody near ${names.target} → disarms it ${fmtNum(def.params.disarm ?? 0)} s`));
      } else parts.push(names.link ? `${names.target} → ${names.link}` : `→ ${names.target}`);
    }
  }
  if (s.clamped !== undefined) {
    warn = true;
    parts.unshift(tr(lang, `超出射程 · 落在 ${fmtNum(s.clamped)} 米处`, `Out of range · lands at ${fmtNum(s.clamped)} m`));
  }
  if (s.caught) parts.push(tr(lang, `范围内 ${s.caught} 人`, `${s.caught} in the area`));
  parts.push(cancel);
  return { name, how: parts.join(' · '), bad: false, warn };
}

export class SkillAimHint {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly howEl: HTMLElement;
  private key = '';
  /** a release that cast nothing keeps the hint up (red, shaken) until then */
  private holdUntil = 0;

  constructor() {
    this.nameEl = h('b');
    this.howEl = h('span', { class: 'how' });
    this.el = h('div', { class: 'hud-skaim', role: 'status' }, this.nameEl, this.howEl);
  }

  update(def: AbilityDef | null, st: PreviewStatus | boolean, lang: Lang, names: AimNames = {}, now = 0): void {
    if (!def && now < this.holdUntil) return;
    if (!def) {
      if (this.key !== '') {
        this.key = '';
        setClass(this.el, 'on', false);
      }
      return;
    }
    this.holdUntil = 0;
    this.render(aimHintText(def, SLOT_KEY[def.slot], st, lang, names));
  }

  /** The held skill was released with nothing to cast it on: say why for a moment, with a shake. */
  refused(def: AbilityDef, st: PreviewStatus, lang: Lang, names: AimNames, now: number): void {
    this.render(aimHintText(def, SLOT_KEY[def.slot], { ...st, valid: false }, lang, names));
    this.holdUntil = now + 1.1;
    if (typeof this.el.animate === 'function') {
      this.el.animate(
        [{ transform: 'translateX(-50%)' }, { transform: 'translateX(calc(-50% - 8px))' }, { transform: 'translateX(calc(-50% + 8px))' }, { transform: 'translateX(calc(-50% - 5px))' }, { transform: 'translateX(-50%)' }],
        { duration: 320, easing: 'ease-out' },
      );
    }
  }

  private render(t: AimHint): void {
    const key = `${t.name}|${t.how}|${t.bad ? 1 : 0}${t.warn ? 1 : 0}`;
    if (key === this.key) return;
    this.key = key;
    setClass(this.el, 'on', true);
    setText(this.nameEl, t.name);
    setText(this.howEl, t.how);
    setClass(this.el, 'bad', t.bad);
    setClass(this.el, 'warn', t.warn);
  }
}

// ── cast results ─────────────────────────────────────────────────────────────

export interface CastResult {
  /** one result per cast (the view updates it in place while hits come in) */
  seq: number;
  abilityId: string;
  /** distinct units hit by the skill's own damage */
  units: number;
  /** of which heroes */
  heroes: number;
  damage: number;
  /** debuffs it put on others: status → how many units */
  statuses: { id: StatusId; n: number }[];
  /** the unit a targeted skill was cast on */
  target?: EntityId;
  /** the window closed */
  done: boolean;
  /** closed with nothing to show for an area / damage skill */
  missed: boolean;
  /** a self skill (no area, no damage): the cast itself is the news */
  self: boolean;
}

interface OpenCast {
  def: AbilityDef;
  res: CastResult;
  until: number;
  units: Set<EntityId>;
  heroes: Set<EntityId>;
  statuses: Map<StatusId, Set<EntityId>>;
}

/**
 * A field that stays on the ground and works while units stand in it (八阵图, 火烧连营):
 * what it catches comes over its duration, not at the cast.
 */
export function lastingField(def: AbilityDef): boolean {
  const a = skillArea(def);
  const p = def.params;
  return !!a && (a.kind === 'circle' || a.kind === 'line') && (p.duration ?? 0) > 0 && !p.tickEvery;
}

/**
 * Seconds after a cast during which hits / debuffs count for it: the skill's own
 * timing (delays, dashes, bolts, ticks, the first seconds of a lasting field), at
 * least 0.8 s, at most 4 s.
 */
export function castWindow(def: AbilityDef): number {
  const p = def.params;
  let t = 0.6;
  if (lastingField(def)) t += Math.min(p.duration, 3);
  t += p.delay ?? 0;
  t += p.dashTime ?? p.leapTime ?? p.chargeTime ?? 0;
  if (p.bolts && p.interval) t += (p.bolts - 1) * p.interval;
  if (p.speed && p.lifetime) t += p.lifetime;
  else if (p.speed) t += 0.6;
  if (p.tickEvery && p.duration) t += p.duration;
  else if (p.interval && p.duration) t += p.duration;
  return Math.max(0.8, Math.min(4, t));
}

const isDebuff = (s: StatusId): boolean => !!STATUS_HINT_BY_ID[s]?.debuff;

/**
 * Turns the match's event stream into "what my cast did". A hit counts for the open cast
 * when it is mine, of the skill's damage type and not a gun hit (a shot of mine at that
 * unit in the same batch — unless the skill fires the held weapon, 夏侯渊 神速); debuffs
 * that land on others while the cast is open count too (status events carry no source).
 */
export class SkillCastTracker {
  private seq = 0;
  private open: OpenCast[] = [];

  /** Feed a batch (`now`: the match clock, so a slowed / paused sim keeps its windows); returns the results that changed. */
  push(evs: readonly GameEvent[], me: { id: EntityId; heroId: string } | null, now: number, info: { isOwn(id: EntityId): boolean; isHero(id: EntityId): boolean }): CastResult[] {
    if (!me) return [];
    const changed = new Set<CastResult>();
    const gunHits = new Set<EntityId>();
    for (const ev of evs) if (ev.t === 'shot' && ev.src === me.id && ev.hit !== undefined) gunHits.add(ev.hit);
    // casts first: the sim applies a skill's statuses / damage before it reports the cast
    // (activate() runs, then the world emits the 'ability' event) — same tick, same batch
    const ordered = [...evs.filter((e) => e.t === 'ability'), ...evs.filter((e) => e.t !== 'ability')];
    for (const ev of ordered) {
      switch (ev.t) {
        case 'ability': {
          if (ev.src !== me.id || ev.proc) break;
          const def = ABILITY_BY_ID[ev.ability];
          if (!def || isPassiveAbility(def) || ABILITY_HERO[def.id] !== me.heroId) break;
          const area = skillArea(def);
          const res: CastResult = { seq: ++this.seq, abilityId: def.id, units: 0, heroes: 0, damage: 0, statuses: [], done: false, missed: false, self: !area && def.dtype === undefined };
          if (ev.target !== undefined && ev.target !== me.id) res.target = ev.target;
          this.open.push({ def, res, until: now + castWindow(def), units: new Set(), heroes: new Set(), statuses: new Map() });
          if (res.target !== undefined || res.self) changed.add(res);
          break;
        }
        case 'hit': {
          if (ev.src !== me.id || ev.target === me.id || ev.blocked || !(ev.amount > 0) || info.isOwn(ev.target)) break;
          const o = this.latest((c) => c.def.dtype !== undefined && c.def.dtype === ev.dtype && (c.def.params.weaponHit === 1 || !gunHits.has(ev.target)));
          if (!o) break;
          o.units.add(ev.target);
          if (info.isHero(ev.target)) o.heroes.add(ev.target);
          o.res.units = o.units.size;
          o.res.heroes = o.heroes.size;
          o.res.damage += ev.amount;
          changed.add(o.res);
          break;
        }
        case 'status': {
          if (!ev.on || ev.target === me.id || !isDebuff(ev.status) || info.isOwn(ev.target) || ev.privateTo !== undefined) break;
          const o = this.latest(() => true);
          if (!o) break;
          let set = o.statuses.get(ev.status);
          if (!set) o.statuses.set(ev.status, (set = new Set()));
          set.add(ev.target);
          o.res.statuses = [...o.statuses].map(([id, s]) => ({ id, n: s.size }));
          changed.add(o.res);
          break;
        }
        default:
          break;
      }
    }
    return [...changed];
  }

  /** Close the casts whose window ran out; returns them (missed ones flagged). */
  tick(now: number): CastResult[] {
    const out: CastResult[] = [];
    this.open = this.open.filter((o) => {
      if (now < o.until) return true;
      o.res.done = true;
      // (a control field nobody walked into yet is no miss: it stays on the ground)
      const verdict = o.def.dtype !== undefined || (skillArea(o.def) !== null && !lastingField(o.def));
      o.res.missed = !o.res.self && o.res.units === 0 && o.res.statuses.length === 0 && o.res.target === undefined && verdict;
      out.push(o.res);
      return false;
    });
    return out;
  }

  private latest(ok: (c: OpenCast) => boolean): OpenCast | undefined {
    for (let i = this.open.length - 1; i >= 0; i--) if (ok(this.open[i])) return this.open[i];
    return undefined;
  }
}

/** The result as one line: 「命中 3（武将 1）」, 「→ 张飞」, 「未命中」, 「生效 7 秒」. */
export function castResultText(r: CastResult, lang: Lang, targetName: string | null): string {
  const def = ABILITY_BY_ID[r.abilityId];
  if (r.target !== undefined && targetName) {
    // 反间 with nobody near its target disarms it instead of charming it: say why
    const fellBack = r.abilityId === 'zhouyu_fanjian' && r.statuses.some((s) => s.id === 'disarm') && !r.statuses.some((s) => s.id === 'charm');
    return `→ ${targetName}${fellBack ? tr(lang, '（附近无人可打）', ' (nobody near it to attack)') : ''}`;
  }
  if (r.units > 0) {
    const heroes = r.heroes > 0 && r.heroes < r.units ? tr(lang, `（武将 ${r.heroes}）`, ` (${r.heroes} hero${r.heroes > 1 ? 'es' : ''})`) : '';
    return tr(lang, `命中 ${r.units}${heroes}`, `${r.units} hit${heroes}`);
  }
  if (r.missed) return tr(lang, '未命中', 'missed');
  if (r.self && def) {
    const d = def.params.duration ?? def.params.lifetime;
    return d ? tr(lang, `生效 ${fmtNum(d)} 秒`, `active ${fmtNum(d)} s`) : tr(lang, '生效', 'done');
  }
  return '';
}

export class SkillCastFeed {
  readonly el: HTMLElement;
  private readonly rows = new Map<number, { el: HTMLElement; until: number }>();

  constructor(private readonly targetName: (id: EntityId) => string | null) {
    this.el = h('div', { class: 'hud-skfeed', aria: { live: 'polite' } });
  }

  show(r: CastResult, lang: Lang, now: number): void {
    const def = ABILITY_BY_ID[r.abilityId];
    if (!def) return;
    const res = castResultText(r, lang, r.target !== undefined ? this.targetName(r.target) : null);
    const st = r.statuses.map((s) => {
      const hint = STATUS_HINT_BY_ID[s.id];
      return h('span', { class: 'st', style: `--sc:${hint?.color ?? '#9a7ad0'}` }, h('i', null, hint?.icon ?? '·'), `${hint ? tr(lang, hint.nameZh, hint.nameEn) : s.id}${s.n > 1 ? ` ×${s.n}` : ''}`);
    });
    if (!res && !st.length) return;
    let row = this.rows.get(r.seq);
    if (!row) {
      row = { el: h('div', { class: 'sf' }), until: 0 };
      this.rows.set(r.seq, row);
      this.el.prepend(row.el);
      // at most three lines: the oldest go first
      while (this.rows.size > 3) {
        const [k, v] = this.rows.entries().next().value as [number, { el: HTMLElement }];
        v.el.remove();
        this.rows.delete(k);
      }
    }
    row.until = now + (r.done ? 1.6 : 2.2);
    setClass(row.el, 'miss', r.missed);
    const resEl = h('span', { class: 'res' });
    // the count stands out: 命中 <em>3</em>
    const m = /^(.*?)(\d+)(.*)$/.exec(res);
    if (m && r.units > 0) resEl.append(m[1], h('em', null, m[2]), m[3]);
    else resEl.textContent = res;
    row.el.replaceChildren(h('span', { class: 'nm' }, nameOf(def, lang)), ...(res ? [resEl] : []), ...st);
    if (typeof row.el.animate === 'function' && !r.done) row.el.animate([{ transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }

  update(now: number): void {
    for (const [k, v] of this.rows) {
      if (now < v.until) continue;
      v.el.remove();
      this.rows.delete(k);
    }
  }

  clear(): void {
    this.rows.clear();
    this.el.replaceChildren();
  }
}

// ── what enemy skills do to you ──────────────────────────────────────────────

/** Control effects on you, most binding first: the banner names the first one you have. */
export const SELF_CC_ORDER: readonly StatusId[] = ['stun', 'freeze', 'dance', 'charm', 'silence', 'disarm', 'root'];
/** Softer debuffs: a short notice when one lands (what it does, who did it), no lasting banner. */
const SELF_SOFT: ReadonlySet<StatusId> = new Set<StatusId>(['chained', 'marked', 'dmgTakenUp', 'slow', 'burn', 'poison', 'reveal']);
/** params / words by which a skill or card can put a status on you (to tell which cast it came from) */
const STATUS_CAUSE: Readonly<Partial<Record<StatusId, { keys: readonly string[]; words: readonly string[] }>>> = {
  stun: { keys: ['stun', 'stunHero'], words: ['眩晕'] },
  freeze: { keys: ['freezeTime'], words: ['冰冻'] },
  dance: { keys: [], words: ['跳舞', '乐不思蜀'] },
  charm: { keys: [], words: ['魅惑'] },
  silence: { keys: ['silence'], words: ['沉默'] },
  disarm: { keys: ['disarm'], words: ['缴械'] },
  root: { keys: ['root'], words: ['定身'] },
  slow: { keys: ['slow'], words: ['减速'] },
  chained: { keys: [], words: ['连环'] },
  burn: { keys: ['burnDps', 'burnTime'], words: ['燃烧', '火'] },
  dmgTakenUp: { keys: ['takenMul'], words: ['受到伤害', '易伤'] },
  reveal: { keys: [], words: ['暴露', '看穿'] },
};
/** seconds a cast at / around you can still be the source of a status that lands */
const SOURCE_WINDOW = 1.5;
const SOFT_NOTICE_SECONDS = 2.6;
const HIT_NOTICE_SECONDS = 2.2;

/** A skill cast or a card used by someone else, remembered for a moment. */
interface IncomingCast {
  src: EntityId;
  /** an ability id, or (`card`) an item id */
  id: string;
  card: boolean;
  at: number;
  target?: EntityId;
  pos?: { x: number; z: number };
}

/** Where something that hit you came from: 「关羽「义绝」」. */
export interface CcSource {
  src: EntityId;
  id: string;
  card: boolean;
}

type Pos = { x: number; z: number };

/**
 * Could this cast have reached you (at `me`)? Its target was you, or you stand where its area
 * would be (a ring around the caster, a circle at its point, a cone / line / dash from it, an
 * area around its target) — a generous check: it only picks among the casts of the last moment.
 */
function mayReach(c: IncomingCast, meId: EntityId, me: Pos, posOf: (id: EntityId) => Pos | null): boolean {
  if (c.target === meId) return true;
  if (c.card) return false;
  const def = ABILITY_BY_ID[c.id];
  if (!def) return false;
  const a = skillArea(def);
  const near = (p: Pos | null | undefined, r: number): boolean => !!p && Math.hypot(p.x - me.x, p.z - me.z) <= r;
  const from = posOf(c.src);
  switch (a?.kind) {
    case 'ring':
      return near(from, a.radius + 2);
    case 'circle':
      return near(c.pos, a.radius + 2);
    case 'target':
      return a.radius !== undefined && near(c.target !== undefined ? posOf(c.target) : null, a.radius + 2);
    case 'cone':
      return near(from, a.range + 2);
    case 'line':
      return near(from, (a.reach || a.start + a.length) + (a.endRadius ?? 0) + 2);
    case 'dash':
      return near(from, a.length + (a.endRadius ?? 0) + a.width + 3);
    default:
      // a self skill with an aura (咆哮's slow): around its caster
      return near(from, (def.params.radius ?? 8) + 2);
  }
}

/** Can this skill / card put `status` on someone (its params or its rules say so)? */
function causes(c: IncomingCast, status: StatusId): boolean {
  const cause = STATUS_CAUSE[status];
  if (c.card) {
    const it = ITEM_BY_ID[c.id];
    return !!it && !!cause && cause.words.some((w) => it.nameZh.includes(w) || (it.descZh ?? '').includes(w));
  }
  const def = ABILITY_BY_ID[c.id];
  if (!def || !cause) return false;
  return cause.keys.some((k) => (def.params[k] ?? 0) > 0) || cause.words.some((w) => def.descZh.includes(w));
}

/** What the banner shows: a control effect (with its bar), a softer debuff, or a skill hit. */
export interface SelfCcView {
  kind: 'cc' | 'soft' | 'hit';
  icon: string;
  color: string;
  text: string;
  /** the bar: time left / full time (cc only; -1: no bar) */
  frac: number;
}

/**
 * What enemy skills are doing to you (the logic of SelfCcBanner, no DOM): while a control
 * effect holds you, 「沉默 5.8 秒 · 不能放技能、用锦囊 ← 关羽「义绝」」 over a draining bar; a
 * softer debuff or a skill's damage gets a short notice (「连环 … ← 貂蝉「连环计」」,
 * 「张角「雷击」 −77」). The source is the skill cast at you (or around you) the moment the
 * status landed, read from the event stream (status events carry no source).
 */
export class SelfCcModel {
  private recent: IncomingCast[] = [];
  /** where each status on you came from (kept while it lasts) */
  private readonly sources = new Map<StatusId, CcSource>();
  /** the longest time left seen for each control effect (the bar's full width) */
  private readonly totals = new Map<StatusId, number>();
  /** the short notice: a soft debuff or a skill hit */
  private notice: { status?: StatusId; source: CcSource | null; amount: number; until: number } | null = null;

  constructor(private readonly nameOf: (id: EntityId) => string | null) {}

  /** Feed a batch of events (`now`: the match clock; `posOf`: where a unit stands). */
  ingest(evs: readonly GameEvent[], meId: EntityId | null, now: number, posOf: (id: EntityId) => Pos | null): void {
    if (meId === null) return;
    this.recent = this.recent.filter((c) => now - c.at <= SOURCE_WINDOW + 3);
    // casts first: a skill's statuses / damage land in the same batch as its cast
    for (const ev of evs) {
      if (ev.t === 'ability') {
        if (ev.src === meId || ev.proc || (ev.privateTo !== undefined && ev.privateTo !== meId)) continue;
        const def = ABILITY_BY_ID[ev.ability];
        if (!def || isPassiveAbility(def)) continue;
        this.recent.push({ src: ev.src, id: ev.ability, card: false, at: now, ...(ev.target !== undefined ? { target: ev.target } : {}), ...(ev.pos ? { pos: { x: ev.pos.x, z: ev.pos.z } } : {}) });
      } else if (ev.t === 'itemUse' && ev.who !== meId && ev.target === meId) {
        this.recent.push({ src: ev.who, id: ev.item, card: true, at: now, target: ev.target });
      }
    }
    const me = posOf(meId);
    for (const ev of evs) {
      if (ev.t === 'status' && ev.target === meId) {
        if (!ev.on) {
          this.sources.delete(ev.status);
          this.totals.delete(ev.status);
          continue;
        }
        if (!STATUS_HINT_BY_ID[ev.status]?.debuff) continue;
        const src = me ? this.sourceFor(ev.status, meId, me, now, posOf) : null;
        if (src) this.sources.set(ev.status, src);
        else this.sources.delete(ev.status);
        if (SELF_SOFT.has(ev.status)) this.notice = { status: ev.status, source: src, amount: 0, until: now + SOFT_NOTICE_SECONDS };
      } else if (ev.t === 'hit' && ev.target === meId && ev.src !== undefined && ev.src !== meId && !ev.blocked && ev.amount > 0) {
        // a skill's own damage (its damage type, from a cast of that unit a moment ago)
        const src = ev.src;
        const c = [...this.recent].reverse().find((x) => !x.card && x.src === src && ABILITY_BY_ID[x.id]?.dtype === ev.dtype && now - x.at <= castWindow(ABILITY_BY_ID[x.id]));
        if (!c) continue;
        const n = this.notice;
        if (n && !n.status && n.source && n.source.src === c.src && n.source.id === c.id && now < n.until) {
          n.amount += ev.amount;
          n.until = now + HIT_NOTICE_SECONDS;
        } else this.notice = { source: { src: c.src, id: c.id, card: false }, amount: ev.amount, until: now + HIT_NOTICE_SECONDS };
      }
    }
  }

  /** The cast a status on you came from: one aimed at you, else the latest one whose area covers you and that can cause it. */
  sourceFor(status: StatusId, meId: EntityId, me: Pos, now: number, posOf: (id: EntityId) => Pos | null): CcSource | null {
    const fresh = this.recent.filter((c) => now - c.at <= SOURCE_WINDOW);
    for (let i = fresh.length - 1; i >= 0; i--) if (fresh[i].target === meId && causes(fresh[i], status)) return pick(fresh[i]);
    for (let i = fresh.length - 1; i >= 0; i--) if (causes(fresh[i], status) && mayReach(fresh[i], meId, me, posOf)) return pick(fresh[i]);
    // a cast at you that the words do not tie to it (a proc of its rules): still the likeliest
    for (let i = fresh.length - 1; i >= 0; i--) if (fresh[i].target === meId) return pick(fresh[i]);
    return null;
  }

  /** What to show now (null: nothing). */
  view(me: { statuses: readonly { id: StatusId; remaining: number }[]; dead: boolean } | null, now: number, lang: Lang): SelfCcView | null {
    let cc: { id: StatusId; remaining: number } | undefined;
    if (me && !me.dead) {
      for (const id of SELF_CC_ORDER) {
        cc = me.statuses.find((s) => s.id === id && s.remaining !== 0);
        if (cc) break;
      }
      // (forget the full time of an effect that is gone)
      for (const id of [...this.totals.keys()]) if (!me.statuses.some((s) => s.id === id)) this.totals.delete(id);
    }
    if (this.notice && now >= this.notice.until) this.notice = null;
    if (cc) {
      const hint = STATUS_HINT_BY_ID[cc.id];
      const timed = cc.remaining > 0 && cc.remaining < 999;
      const total = Math.max(this.totals.get(cc.id) ?? 0, timed ? cc.remaining : 0);
      this.totals.set(cc.id, total);
      const secs = timed ? tr(lang, ` ${cc.remaining.toFixed(1)} 秒`, ` ${cc.remaining.toFixed(1)} s`) : '';
      const text = `${tr(lang, hint.nameZh, hint.nameEn)}${secs} · ${tr(lang, hint.effectZh ?? '', hint.effectEn ?? '')}${this.fromText(this.sources.get(cc.id) ?? null, lang)}`;
      return { kind: 'cc', icon: hint.icon, color: hint.color, text, frac: timed && total > 0 ? cc.remaining / total : 1 };
    }
    const n = this.notice;
    if (!n || !me || me.dead) return null;
    if (n.status) {
      const hint = STATUS_HINT_BY_ID[n.status];
      return { kind: 'soft', icon: hint.icon, color: hint.color, text: `${tr(lang, hint.nameZh, hint.nameEn)} · ${tr(lang, hint.effectZh ?? '', hint.effectEn ?? '')}${this.fromText(n.source, lang)}`, frac: -1 };
    }
    return n.source ? { kind: 'hit', icon: tr(lang, '伤', '!'), color: '#ff6a4a', text: `${this.sourceName(n.source, lang)} −${Math.round(n.amount)}`, frac: -1 } : null;
  }

  clear(): void {
    this.recent = [];
    this.sources.clear();
    this.totals.clear();
    this.notice = null;
  }

  /** 「关羽「义绝」」 (a soldier's or summon's own name when it is no hero's skill) */
  private sourceName(s: CcSource, lang: Lang): string {
    const who = this.nameOf(s.src) ?? '?';
    const what = s.card ? ITEM_BY_ID[s.id] : ABILITY_BY_ID[s.id];
    return what ? `${who}${tr(lang, `「${what.nameZh}」`, ` · ${what.nameEn}`)}` : who;
  }

  private fromText(s: CcSource | null, lang: Lang): string {
    return s ? ` ← ${this.sourceName(s, lang)}` : '';
  }
}

/** Under the crosshair: what an enemy skill is doing to you (SelfCcModel), a pill with a draining bar. */
export class SelfCcBanner {
  readonly el: HTMLElement;
  readonly model: SelfCcModel;
  private readonly iconEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private key = '';

  constructor(nameOf: (id: EntityId) => string | null) {
    this.model = new SelfCcModel(nameOf);
    this.iconEl = h('i');
    this.textEl = h('span', { class: 'tx' });
    this.barEl = h('span', { class: 'bar' });
    this.el = h('div', { class: 'hud-selfcc', role: 'status', aria: { live: 'polite' } }, this.iconEl, this.textEl, h('span', { class: 'track' }, this.barEl));
  }

  ingest(evs: readonly GameEvent[], meId: EntityId | null, now: number, posOf: (id: EntityId) => Pos | null): void {
    this.model.ingest(evs, meId, now, posOf);
  }

  update(me: { statuses: readonly { id: StatusId; remaining: number }[]; dead: boolean } | null, now: number, lang: Lang): void {
    const v = this.model.view(me, now, lang);
    if (!v) {
      if (this.key !== '') {
        this.key = '';
        setClass(this.el, 'on', false);
      }
      return;
    }
    // (the bar moves every frame: set apart from the text)
    if (v.frac >= 0) this.barEl.style.transform = `scaleX(${Math.max(0, Math.min(1, v.frac)).toFixed(3)})`;
    const key = `${v.kind}|${v.icon}|${v.text}`;
    if (key === this.key) return;
    this.key = key;
    setClass(this.el, 'on', true);
    for (const k of ['cc', 'soft', 'hit'] as const) setClass(this.el, k, k === v.kind);
    this.el.style.setProperty('--sc', v.color);
    setText(this.iconEl, v.icon);
    setText(this.textEl, v.text);
  }

  clear(): void {
    this.model.clear();
    this.key = '';
    setClass(this.el, 'on', false);
  }
}

const pick = (c: IncomingCast): CcSource => ({ src: c.src, id: c.id, card: c.card });

// ── first-ready tips ─────────────────────────────────────────────────────────

export const SKILL_TIPS_KEY = 'sgwl.sktips.v1';
/** matches in which each skill still gets its first-ready tip */
export const SKILL_TIP_MATCHES = 3;
const TIP_SECONDS = 8;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** How many matches already showed each skill's tip. */
export function readTipCounts(s: Pick<Storage, 'getItem'> | null = store()): Record<string, number> {
  try {
    const v = JSON.parse(s?.getItem(SKILL_TIPS_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeTipCounts(c: Record<string, number>): void {
  try {
    store()?.setItem(SKILL_TIPS_KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: the tips simply show again */
  }
}

/** The tip line of a skill: key, name, what it does, how to cast it. */
export function readyTip(def: AbilityDef, lang: Lang): { key: string; name: string; line: string; how: string } {
  const passive = isPassiveAbility(def);
  const key = passive ? tr(lang, '被动', 'Passive') : SLOT_KEY[def.slot];
  const aim = skillAim(def);
  let how = '';
  if (!passive) how = aim === 'self' ? tr(lang, `按 ${key}`, `press ${key}`) : tr(lang, `按住 ${key} 看范围`, `hold ${key} to aim`);
  else how = AIM_LABEL.passive[lang === 'en' ? 1 : 0];
  return { key, name: nameOf(def, lang), line: skillLine(def, lang), how };
}

/**
 * The first time each of your skills is ready in a match (passives: when the match
 * starts), a one-line tip above the ability bar — in the first SKILL_TIP_MATCHES matches
 * with that skill.
 */
export class SkillReadyTips {
  readonly el: HTMLElement;
  private heroKey = '';
  private readonly seen = new Set<string>();
  /** this hero's HUD skills (built once per hero / role) */
  private views: ReturnType<typeof hudAbilities> = [];
  private readonly tips: { el: HTMLElement; until: number }[] = [];
  private counts: Record<string, number> | null = null;
  /** measured height (px) of the tips shown, -1: to measure again */
  private h = 0;

  constructor() {
    this.el = h('div', { class: 'hud-sktips', aria: { live: 'polite' } });
  }

  update(f: HudFrame): void {
    const me = f.me;
    const now = f.now;
    for (let i = this.tips.length - 1; i >= 0; i--) {
      const t = this.tips[i];
      if (now >= t.until) {
        t.el.remove();
        this.tips.splice(i, 1);
        this.h = -1;
      } else if (now >= t.until - 0.6) t.el.classList.add('out');
    }
    if (!me || me.dead) return;
    const hk = `${me.heroId}|${me.role}`;
    if (hk !== this.heroKey) {
      // a new hero (or the Lord's G unlocked): its skills tip again once
      this.heroKey = hk;
      this.seen.clear();
      this.views = hudAbilities(HERO_BY_ID[me.heroId], me.role);
    }
    if (this.seen.size >= this.views.length) return;
    for (const v of this.views) {
      const id = v.def.id;
      if (this.seen.has(id)) continue;
      const ready = !v.active || abilityReady(v.def, me.cooldowns[id] ?? 0, me.charges[id]);
      if (!ready) continue;
      this.seen.add(id);
      this.counts ??= readTipCounts();
      const n = this.counts[id] ?? 0;
      if (n >= SKILL_TIP_MATCHES) continue;
      this.counts[id] = n + 1;
      writeTipCounts(this.counts);
      this.add(readyTip(v.def, f.lang), v.def.slot, now + TIP_SECONDS + this.tips.length * 0.8);
    }
  }

  private add(t: ReturnType<typeof readyTip>, slot: AbilityDef['slot'], until: number): void {
    const el = h('div', { class: 'tip' }, h('span', { class: `k k-${slot}` }, t.key), h('b', null, t.name), h('span', { class: 'ln' }, t.line), t.how ? h('span', { class: 'how' }, t.how) : null);
    this.el.appendChild(el);
    this.tips.push({ el, until });
    while (this.tips.length > 4) this.tips.shift()!.el.remove();
    this.h = -1;
  }

  /** Height (px) of the tips shown now (0: none), measured only when they change. */
  height(): number {
    if (this.h < 0) this.h = this.tips.length ? this.el.offsetHeight : 0;
    return this.h;
  }

  clear(): void {
    for (const t of this.tips) t.el.remove();
    this.tips.length = 0;
    this.h = -1;
  }
}

/** The held slot's ability def for this hero (null: none held / not this hero's). */
export function heldDef(heroId: string | undefined, slot: AbilitySlot | null): AbilityDef | null {
  if (!heroId || !slot) return null;
  return HERO_BY_ID[heroId]?.abilities.find((a) => a.slot === slot) ?? null;
}
