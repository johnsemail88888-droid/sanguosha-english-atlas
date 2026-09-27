// In-match skill clarity (the HUD side of data/skillInfo.ts):
//  - SkillTooltip: what a skill does, over the ability bar, while hovering its icon or
//    holding its key (the one-line summary, the key numbers, how to cast it);
//  - SkillAimHint: under the crosshair while a skill key is held — 「松开 Q 施放 · 右键取消」,
//    or 「准星对准一名敌人」 when releasing now would find no target;
//  - SkillCastTracker + SkillCastFeed: what a cast of yours did — 「青龙斩 命中 3」,
//    「义绝 → 张飞 · 沉默」, 「未命中」 — from the event stream;
//  - SkillReadyTips: the first time each skill is ready in a match, one line about it (the
//    first few matches with that hero).
import type { AbilitySlot, EntityId, GameEvent, StatusId } from '../../core/types';
import { ABILITY_BY_ID, ABILITY_HERO, HERO_BY_ID, STATUS_HINT_BY_ID, isPassiveAbility } from '../../data';
import type { AbilityDef } from '../../data/types';
import { AIM_LABEL, skillAim, skillArea, skillLine, fmtNum } from '../../data/skillInfo';
import { h, setClass, setText } from '../dom';
import { aimTag, castHint, skillChips, skillLineEl } from '../skillCard';
import { abilityReady, hudAbilities } from './logic';
import type { HudFrame } from './types';

type Lang = 'zh' | 'en';
const SLOT_KEY: Record<AbilityDef['slot'], string> = { passive: '', q: 'Q', e: 'E', lord: 'G' };
const tr = (lang: Lang, zh: string, en: string): string => (lang === 'en' ? en : zh);
const nameOf = (def: AbilityDef, lang: Lang): string => (lang === 'en' ? def.nameEn : def.nameZh);

// ── tooltip ──────────────────────────────────────────────────────────────────

export class SkillTooltip {
  readonly el: HTMLElement;
  private key = '';

  constructor() {
    this.el = h('div', { class: 'hud-sktip', role: 'tooltip' });
  }

  /** Show `def` (`held`: its key is down — the short form, no long rules). */
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
        skillChips(def, lang),
        hint ? h('div', { class: 'tt-hint' }, hint) : null,
        lordOnly ? h('div', { class: 'tt-hint' }, tr(lang, '主公技：只有主公能用', 'Lord skill: only the Lord can use it')) : null,
        held ? null : h('div', { class: 'tt-desc' }, lang === 'en' ? def.descEn : def.descZh),
      ];
      this.el.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
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

// ── held-skill hint under the crosshair ──────────────────────────────────────

/** The hint's text for a held skill: how to cast it, or what it is still missing. */
export function aimHintText(def: AbilityDef, key: string, valid: boolean, lang: Lang): { name: string; how: string; bad: boolean } {
  const name = nameOf(def, lang);
  const area = skillArea(def);
  if (!valid && area?.kind === 'target') {
    const who = area.side === 'enemy' ? tr(lang, '一名敌人', 'an enemy') : tr(lang, '一名武将', 'a hero');
    return { name, how: tr(lang, `准星对准${who}（${fmtNum(area.range)} 米内）`, `Put the crosshair on ${who} (within ${fmtNum(area.range)} m)`), bad: true };
  }
  return { name, how: tr(lang, `松开 ${key} 施放 · 右键取消`, `Release ${key} to cast · right click cancels`), bad: false };
}

export class SkillAimHint {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly howEl: HTMLElement;
  private key = '';

  constructor() {
    this.nameEl = h('b');
    this.howEl = h('span', { class: 'how' });
    this.el = h('div', { class: 'hud-skaim', role: 'status' }, this.nameEl, this.howEl);
  }

  update(def: AbilityDef | null, valid: boolean, lang: Lang): void {
    const key = def ? `${def.id}|${valid ? 1 : 0}|${lang}` : '';
    if (key === this.key) return;
    this.key = key;
    setClass(this.el, 'on', !!def);
    if (!def) return;
    const t = aimHintText(def, SLOT_KEY[def.slot], valid, lang);
    setText(this.nameEl, t.name);
    setText(this.howEl, t.how);
    setClass(this.el, 'bad', t.bad);
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
 * Seconds after a cast during which hits / debuffs count for it: the skill's own
 * timing (delays, dashes, bolts, ticks), at least 0.8 s, at most 4 s.
 */
export function castWindow(def: AbilityDef): number {
  const p = def.params;
  let t = 0.6;
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

  /** Feed a batch; returns the results that changed (new or updated). */
  push(evs: readonly GameEvent[], me: { id: EntityId; heroId: string } | null, now: number, info: { isOwn(id: EntityId): boolean; isHero(id: EntityId): boolean }): CastResult[] {
    if (!me) return [];
    const changed = new Set<CastResult>();
    const gunHits = new Set<EntityId>();
    for (const ev of evs) if (ev.t === 'shot' && ev.src === me.id && ev.hit !== undefined) gunHits.add(ev.hit);
    for (const ev of evs) {
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
      o.res.missed = !o.res.self && o.res.units === 0 && o.res.statuses.length === 0 && o.res.target === undefined && (o.def.dtype !== undefined || skillArea(o.def) !== null);
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
  if (r.target !== undefined && targetName) return `→ ${targetName}`;
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
  private readonly tips: { el: HTMLElement; until: number }[] = [];
  private counts: Record<string, number> | null = null;

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
      } else if (now >= t.until - 0.6) t.el.classList.add('out');
    }
    if (!me || me.dead) return;
    const hk = `${me.heroId}|${me.role}`;
    if (hk !== this.heroKey) {
      // a new hero (or the Lord's G unlocked): its skills tip again once
      this.heroKey = hk;
      this.seen.clear();
    }
    for (const v of hudAbilities(HERO_BY_ID[me.heroId], me.role)) {
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
  }

  clear(): void {
    for (const t of this.tips) t.el.remove();
    this.tips.length = 0;
  }
}

/** The held slot's ability def for this hero (null: none held / not this hero's). */
export function heldDef(heroId: string | undefined, slot: AbilitySlot | null): AbilityDef | null {
  if (!heroId || !slot) return null;
  return HERO_BY_ID[heroId]?.abilities.find((a) => a.slot === slot) ?? null;
}
