// Persistent HUD panels: vitals (HP/shield/勾玉/dodges/gear/statuses), weapon
// & ammo, abilities + item slots, squad, top bar (role chip / zone / clock).
// Every update() diffs against cached values so a frame costs a few compares.
import type { AbilitySlot, PrivateHeroView, SquadOrderKind, StatusId } from '../../core/types';
import { ARMOR_BY_ID, HERO_BY_ID, ITEM_BY_ID, MOUNT_BY_ID, ROLE_BY_ID, WEAPON_BY_ID } from '../../data';
import type { AbilityDef } from '../../data/types';
import { h, setClass, setText } from '../dom';
import { colon, fmtTime, gearName, getLang, heroName, roleName, t, tx, type I18nKey } from '../i18n';
import { displayName } from '../../game/names';
import { abilityShort, itemShort } from '../short';
import { ORDER_GLYPH, ORDER_KEYS, ORDER_SEQUENCE, RARITY_COLOR, ROLE_GLYPH, kingdomColor, roleColor, statusInfo } from '../theme';
import { magatama, type PortraitCache } from '../widgets';
import { abilityReady, aliveCount, cooldownFraction, filledTicks, hpTicks, hudAbilities, maxDodgeCharges, zoneStatus, type AbilitySlotView } from './logic';
import type { HudFrame } from './types';

const r1 = (v: number): number => Math.round(v * 1000) / 1000;

/** Statuses whose remaining time means nothing to the player (刚烈 reflects for as long as the passive lasts). */
export const TIMERLESS_STATUSES: ReadonlySet<StatusId> = new Set<StatusId>(['thorns']);

// ── Vitals ───────────────────────────────────────────────────────────────────

export class VitalsPanel {
  readonly el: HTMLElement;
  private readonly portrait: HTMLElement;
  private readonly heroEl: HTMLElement;
  private readonly playerEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpLag: HTMLElement;
  private readonly shieldFill: HTMLElement;
  private readonly hpNum: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly mags: HTMLElement;
  private readonly dodges: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly statuses: HTMLElement;
  private heroId = '';
  private heroLang = '';
  private maxHp = -1;
  private hp = -1;
  private shield = -1;
  private lag = 1;
  private ticks = -1;
  private filled = -1;
  /** the hero's own maximum (base + passives); the pip row only grows past it while extra charges last */
  private dodgeBase = 2;
  private dodgeKey = '';
  private gearKey = '';
  private statusKey = '';
  private readonly statusEls = new Map<StatusId, { el: HTMLElement; num: HTMLElement; last: number }>();
  private readonly rawPlayerName: string;

  constructor(private readonly portraits: PortraitCache, playerName: string) {
    this.portrait = h('div', { class: 'v-portrait' });
    this.heroEl = h('span', { class: 'hero' });
    this.playerEl = h('span', { class: 'player' }, displayName(playerName, getLang()));
    this.rawPlayerName = playerName;
    this.hpFill = h('div', { class: 'fill hp' });
    this.hpLag = h('div', { class: 'fill lag' });
    this.shieldFill = h('div', { class: 'fill shield' });
    this.hpNum = h('div', { class: 'num' });
    this.bar = h('div', { class: 'v-hpbar' }, this.hpLag, this.hpFill, h('div', { class: 'segs' }), this.hpNum);
    this.mags = h('div', { class: 'v-mags' });
    this.dodges = h('div', { class: 'v-dodge', title: t('hud.dodge') });
    this.gear = h('div', { class: 'v-gear' });
    this.statuses = h('div', { class: 'v-status' });
    this.el = h('div', { class: 'hud-vitals' },
      this.statuses,
      h('div', { class: 'v-main' },
        this.portrait,
        h('div', { class: 'v-body' },
          h('div', { class: 'v-name' }, this.heroEl, this.playerEl),
          h('div', { class: 'v-shield' }, this.shieldFill),
          this.bar,
          h('div', { class: 'v-sub' }, this.mags, this.dodges, this.gear),
        ),
      ),
    );
  }

  update(f: HudFrame): void {
    const me = f.me;
    if (!me) return;
    if (me.heroId !== this.heroId || f.lang !== this.heroLang) {
      if (me.heroId !== this.heroId) this.portrait.replaceChildren(this.portraits.layer(me.heroId, 128));
      this.heroId = me.heroId;
      this.heroLang = f.lang;
      const def = HERO_BY_ID[me.heroId];
      setText(this.playerEl, displayName(this.rawPlayerName, f.lang));
      this.portrait.style.setProperty('--kc', kingdomColor(def?.kingdom));
      setText(this.heroEl, heroName(me.heroId));
      this.dodgeBase = maxDodgeCharges(me.heroId);
    }
    const maxHp = Math.max(1, me.maxHp);
    if (maxHp !== this.maxHp) {
      this.maxHp = maxHp;
      this.bar.style.setProperty('--seg', `${(100 / maxHp) * 100}%`);
    }
    const hp = Math.max(0, Math.round(me.hp));
    if (this.hp < 0) this.lag = Math.min(1, hp / maxHp);
    if (hp !== this.hp) {
      this.hp = hp;
      const frac = Math.min(1, hp / maxHp);
      this.hpFill.style.transform = `scaleX(${r1(frac)})`;
      setClass(this.bar, 'low', frac <= 0.25);
      setClass(this.bar, 'mid', frac > 0.25 && frac <= 0.5);
      setText(this.hpNum, `${hp} / ${Math.round(maxHp)}`);
      if (frac > this.lag) this.lag = frac;
    }
    // damage trail catches up after a short delay
    const target = Math.min(1, hp / maxHp);
    if (this.lag > target + 0.001) {
      this.lag = Math.max(target, this.lag - f.dt * 0.6);
      this.hpLag.style.transform = `scaleX(${r1(this.lag)})`;
    } else if (this.hpLag.style.transform !== `scaleX(${r1(target)})`) {
      this.lag = target;
      this.hpLag.style.transform = `scaleX(${r1(target)})`;
    }
    const shield = Math.round(me.shield);
    if (shield !== this.shield) {
      this.shield = shield;
      this.shieldFill.style.transform = `scaleX(${r1(Math.min(1, shield / maxHp))})`;
      setClass(this.shieldFill.parentElement as HTMLElement, 'on', shield > 0);
    }
    const ticks = hpTicks(maxHp);
    const filled = filledTicks(hp, maxHp);
    if (ticks !== this.ticks || filled !== this.filled) {
      this.ticks = ticks;
      this.filled = filled;
      const base = HERO_BY_ID[me.heroId]?.sgsHp ?? ticks;
      this.mags.replaceChildren(...Array.from({ length: ticks }, (_, i) => magatama(i >= filled ? 'empty' : i >= base ? 'lord' : 'full')));
    }
    const dodgeN = Math.max(0, me.dodgeCharges);
    const dodgeMax = Math.max(this.dodgeBase, dodgeN);
    const dk = `${dodgeN}/${dodgeMax}`;
    if (dk !== this.dodgeKey) {
      this.dodgeKey = dk;
      this.dodges.replaceChildren(...Array.from({ length: dodgeMax }, (_, i) => h('span', { class: `pip${i < dodgeN ? ' on' : ''}` }, '闪')));
    }
    const gk = `${me.armor ?? ''}|${me.mount ?? ''}|${f.lang}`;
    if (gk !== this.gearKey) {
      this.gearKey = gk;
      const chips: HTMLElement[] = [];
      if (me.armor) {
        const a = ARMOR_BY_ID[me.armor];
        chips.push(h('span', { class: 'gchip', style: `--gc:${a?.color ?? '#aaa'}`, title: `${t('hud.armor')}${colon()}${gearName(me.armor)}` }, gearName(me.armor)));
      }
      if (me.mount) {
        const m = MOUNT_BY_ID[me.mount];
        chips.push(h('span', { class: 'gchip', style: `--gc:${m?.color ?? '#aaa'}`, title: `${t('hud.mount')}${colon()}${gearName(me.mount)}` }, `${m?.type === 'defense' ? '+1' : '-1'} ${gearName(me.mount)}`));
      }
      this.gear.replaceChildren(...chips);
    }
    this.updateStatuses(me, f);
  }

  private updateStatuses(me: PrivateHeroView, f: HudFrame): void {
    const list = me.statuses.filter((s) => s.id !== 'shield' && statusInfo(s.id)).slice(0, 10);
    const key = list.map((s) => s.id).join(',') + f.lang;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.statusEls.clear();
      this.statuses.replaceChildren(
        ...list.map((s) => {
          const info = statusInfo(s.id)!;
          const num = h('b');
          const el = h('div', { class: `st ${info.debuff ? 'debuff' : 'buff'}`, style: `--sc:${info.color}`, title: tx(info.zh, info.en) }, h('span', { class: 'g' }, info.glyph), num);
          this.statusEls.set(s.id, { el, num, last: -1 });
          return el;
        }),
      );
    }
    for (const s of list) {
      const rec = this.statusEls.get(s.id);
      if (!rec) continue;
      const secs = !TIMERLESS_STATUSES.has(s.id) && Number.isFinite(s.remaining) && s.remaining < 999 ? Math.ceil(s.remaining) : -1;
      if (secs !== rec.last) {
        rec.last = secs;
        setText(rec.num, secs >= 0 ? String(secs) : '');
        setClass(rec.el, 'expiring', secs >= 0 && secs <= 2);
      }
    }
  }

  relabel(): void {
    this.heroLang = '';
    this.gearKey = '';
    this.statusKey = '';
    this.dodges.title = t('hud.dodge');
  }
}

// ── Weapon ───────────────────────────────────────────────────────────────────

export class WeaponPanel {
  readonly el: HTMLElement;
  private readonly slots: HTMLElement[];
  private readonly nameEl: HTMLElement;
  private readonly cardEl: HTMLElement;
  private readonly magEl: HTMLElement;
  private readonly resEl: HTMLElement;
  private readonly reload: HTMLElement;
  private readonly reloadFill: HTMLElement;
  private readonly reloadLbl: HTMLElement;
  private key = '';
  private mag = -1;
  private res = -1;
  private reloading = false;

  constructor() {
    this.slots = [0, 1].map((i) => h('div', { class: 'wslot' }, h('span', { class: 'k' }, String(i + 1)), h('span', { class: 'n' })));
    this.nameEl = h('span', { class: 'w-name' });
    this.cardEl = h('span', { class: 'w-card' });
    this.magEl = h('span', { class: 'mag' });
    this.resEl = h('span', { class: 'res' });
    this.reloadFill = h('i');
    this.reloadLbl = h('span', null, t('hud.reloading'));
    this.reload = h('div', { class: 'w-reload' }, h('div', { class: 'track' }, this.reloadFill), this.reloadLbl);
    this.el = h('div', { class: 'hud-weapon' },
      h('div', { class: 'w-slots' }, ...this.slots),
      h('div', { class: 'w-main' },
        h('div', { class: 'w-title' }, this.nameEl, this.cardEl),
        h('div', { class: 'w-ammo' }, this.magEl, h('span', { class: 'sep' }, '/'), this.resEl),
        this.reload,
      ),
    );
  }

  update(f: HudFrame): void {
    const me = f.me;
    if (!me) return;
    const w = me.weapons[me.activeSlot] ?? null;
    const def = w ? WEAPON_BY_ID[w.id] : undefined;
    const key = `${me.activeSlot}|${me.weapons.map((x) => x?.id ?? '').join(',')}|${f.lang}`;
    if (key !== this.key) {
      this.key = key;
      me.weapons.slice(0, 2).forEach((wi, i) => {
        const slot = this.slots[i];
        setClass(slot, 'active', i === me.activeSlot);
        setClass(slot, 'empty', !wi);
        setText(slot.lastElementChild as HTMLElement, wi ? gearName(wi.id) : '—');
        if (wi) {
          const wd = WEAPON_BY_ID[wi.id];
          slot.style.setProperty('--rc', wd ? RARITY_COLOR[wd.rarity] : '#aaa');
        }
      });
      setText(this.nameEl, w ? gearName(w.id) : t('hud.noWeapon'));
      setText(this.cardEl, def?.sgsCard ? `〔${def.sgsCard}〕` : '');
      this.el.style.setProperty('--rc', def ? RARITY_COLOR[def.rarity] : '#b9b2a2');
      this.mag = -1;
    }
    const mag = w?.mag ?? 0;
    const res = w?.reserve ?? 0;
    if (mag !== this.mag || res !== this.res) {
      this.mag = mag;
      this.res = res;
      setText(this.magEl, w ? String(mag) : '—');
      setText(this.resEl, w ? String(res) : '—');
      const size = def?.magSize ?? 1;
      setClass(this.magEl, 'low', !!w && mag <= Math.max(1, size * 0.25));
      setClass(this.magEl, 'empty', !!w && mag === 0);
    }
    const reloading = me.reloading > 0;
    if (reloading !== this.reloading) {
      this.reloading = reloading;
      setClass(this.reload, 'on', reloading);
    }
    if (reloading) {
      const total = def?.reloadTime ?? 2;
      const p = Math.max(0, Math.min(1, 1 - me.reloading / total));
      this.reloadFill.style.transform = `scaleX(${r1(p)})`;
    }
  }

  relabel(): void {
    this.key = '';
    this.reloadLbl.textContent = t('hud.reloading');
  }
}

// ── Abilities + items ────────────────────────────────────────────────────────

interface AbilityEl {
  view: AbilitySlotView;
  root: HTMLElement;
  cd: HTMLElement;
  num: HTMLElement;
  charges: HTMLElement;
  lastP: number;
  lastSecs: number;
  lastCharges: number;
  ready: boolean;
  recharging: boolean;
}

interface ItemEl {
  root: HTMLElement;
  glyph: HTMLElement;
  count: HTMLElement;
  name: HTMLElement;
  key: string;
}

export class AbilityBar {
  readonly el: HTMLElement;
  private readonly abilitiesEl: HTMLElement;
  private readonly itemsEl: HTMLElement;
  private abilities: AbilityEl[] = [];
  private items: ItemEl[] = [];
  private key = '';
  private silenced = false;

  constructor(private readonly onUse?: (slot: AbilitySlot | 'item', index?: number) => void) {
    this.abilitiesEl = h('div', { class: 'abilities' });
    this.itemsEl = h('div', { class: 'items' });
    this.el = h('div', { class: 'hud-abilities' }, this.abilitiesEl, h('div', { class: 'ab-sep' }), this.itemsEl);
    for (let i = 0; i < 4; i++) {
      const glyph = h('span', { class: 'g' });
      const count = h('b', { class: 'cnt' });
      const name = h('span', { class: 'nm' });
      const root = h('div', { class: 'item empty', data: { slot: i } }, h('span', { class: 'key' }, String(4 + i)), h('div', { class: 'card' }, glyph, name, count));
      root.addEventListener('click', () => this.onUse?.('item', i));
      this.items.push({ root, glyph, count, name, key: '' });
      this.itemsEl.appendChild(root);
    }
  }

  private build(me: PrivateHeroView, lang: string): void {
    const def = HERO_BY_ID[me.heroId];
    const views = hudAbilities(def, me.role);
    this.key = `${me.heroId}|${me.role}|${lang}`;
    this.abilities = views.map((v) => {
      const cd = h('i', { class: 'cd' });
      const num = h('b', { class: 'cdnum' });
      const charges = h('span', { class: 'charges' });
      const name = tx(v.def.nameZh, v.def.nameEn);
      const root = h('div', { class: `ab slot-${v.def.slot}`, title: `${name}\n${tx(v.def.descZh, v.def.descEn)}` },
        h('div', { class: 'ico' }, h('span', { class: `g${lang === 'en' ? ' en' : ''}` }, abilityShort(v.def, lang === 'en' ? 'en' : 'zh')), cd, num),
        v.key ? h('span', { class: 'key' }, v.key) : h('span', { class: 'key passive' }, t(v.def.slot === 'lord' ? 'hud.lord' : 'hud.passive')),
        charges,
      );
      if (v.active) root.addEventListener('click', () => this.onUse?.(v.def.slot as AbilitySlot));
      else root.classList.add('inert');
      return { view: v, root, cd, num, charges, lastP: -1, lastSecs: -1, lastCharges: -1, ready: true, recharging: false };
    });
    this.abilitiesEl.replaceChildren(...this.abilities.map((a) => a.root));
  }

  update(f: HudFrame): void {
    const me = f.me;
    if (!me) return;
    if (`${me.heroId}|${me.role}|${f.lang}` !== this.key) this.build(me, f.lang);
    const silenced = me.statuses.some((s) => s.id === 'silence' || s.id === 'stun' || s.id === 'dance');
    if (silenced !== this.silenced) {
      this.silenced = silenced;
      setClass(this.el, 'silenced', silenced);
    }
    for (const a of this.abilities) {
      if (!a.view.active) continue;
      const id = a.view.def.id;
      const rem = me.cooldowns[id] ?? 0;
      const ch = me.charges[id];
      const p = cooldownFraction(rem, a.view.def.cooldown);
      const pr = Math.round(p * 200) / 200;
      if (pr !== a.lastP) {
        a.lastP = pr;
        a.cd.style.setProperty('--p', String(pr));
      }
      const secs = rem > 0 ? Math.ceil(rem) : 0;
      if (secs !== a.lastSecs) {
        a.lastSecs = secs;
        setText(a.num, secs > 0 ? String(secs) : '');
      }
      const ready = abilityReady(a.view.def, rem, ch);
      if (ready !== a.ready) {
        a.ready = ready;
        setClass(a.root, 'cooling', !ready);
        if (ready) flashReady(a.root.firstElementChild);
      }
      // charges left but the next one is still recharging: thin ring, no dimming
      const recharging = ready && rem > 0;
      if (recharging !== a.recharging) {
        a.recharging = recharging;
        setClass(a.root, 'recharging', recharging);
      }
      const chN = ch === undefined ? -1 : ch;
      if (chN !== a.lastCharges) {
        a.lastCharges = chN;
        setText(a.charges, chN >= 0 && (a.view.def.charges ?? 0) > 1 ? String(chN) : '');
      }
    }
    for (let i = 0; i < this.items.length; i++) {
      const it = me.items[i] ?? null;
      const rec = this.items[i];
      const key = it ? `${it.id}:${it.count}:${f.lang}` : '';
      if (key === rec.key) continue;
      rec.key = key;
      setClass(rec.root, 'empty', !it);
      if (it) {
        const def = ITEM_BY_ID[it.id];
        setText(rec.glyph, def?.icon ?? gearName(it.id).slice(0, 1));
        setText(rec.name, itemShort(it.id, f.lang));
        rec.root.style.setProperty('--ic', def?.color ?? '#e8d8b0');
        rec.root.title = def ? `${tx(def.nameZh, def.nameEn)}\n${tx(def.descZh, def.descEn)}` : it.id;
        setText(rec.count, it.count > 1 ? String(it.count) : '');
      } else {
        setText(rec.glyph, '');
        setText(rec.name, '');
        setText(rec.count, '');
        rec.root.title = '';
      }
    }
  }

  relabel(): void {
    this.key = '';
    for (const it of this.items) it.key = '';
  }
}

/** Glow pulse when an ability comes off cooldown (WAAPI: no forced reflow). */
function flashReady(el: Element | null): void {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return;
  (el as HTMLElement).animate(
    [{ filter: 'brightness(1.9) drop-shadow(0 0 10px rgba(255, 230, 150, 0.95))' }, { filter: 'none' }],
    { duration: 600, easing: 'ease-out' },
  );
}

/** Icon glyph for an ability: its first two characters. */
export function glyphFor(def: AbilityDef): string {
  return def.nameZh.slice(0, 2);
}

/** Squad order button label: 随 / 守 / 攻 / 冲 in Chinese, Follow / Hold / Attack / Charge in English. */
export function orderLabel(o: SquadOrderKind): string {
  return getLang() === 'en' ? t(`hud.order.${o}` as I18nKey) : ORDER_GLYPH[o];
}

// ── Squad ────────────────────────────────────────────────────────────────────

export class SquadPanel {
  readonly el: HTMLElement;
  private readonly pips: HTMLElement;
  private readonly orderEl: HTMLElement;
  private readonly orders: Map<SquadOrderKind, HTMLElement> = new Map();
  private key = '';
  private order: SquadOrderKind | '' = '';
  private readonly pipEls: HTMLElement[] = [];
  private readonly titleEl: HTMLElement;
  private lang = '';

  constructor(onOrder?: (o: SquadOrderKind) => void) {
    this.pips = h('div', { class: 'sq-pips' });
    this.orderEl = h('span', { class: 'sq-order' });
    this.titleEl = h('span', { class: 'sq-title' }, t('hud.squad'));
    const orderRow = h('div', { class: 'sq-orders' });
    for (const o of ORDER_SEQUENCE) {
      const b = h('span', { class: 'o', title: t(`hud.order.${o}` as I18nKey), data: { order: o } }, h('span', { class: 'k' }, ORDER_KEYS[o]), h('span', { class: 'ol' }, orderLabel(o)));
      b.addEventListener('click', () => onOrder?.(o));
      this.orders.set(o, b);
      orderRow.appendChild(b);
    }
    this.el = h('div', { class: 'hud-squad' }, h('div', { class: 'sq-head' }, this.titleEl, this.orderEl), this.pips, orderRow);
  }

  update(f: HudFrame): void {
    const me = f.me;
    if (!me) return;
    if (f.lang !== this.lang) {
      this.lang = f.lang;
      setClass(this.el, 'en', f.lang === 'en');
      for (const [o, el] of this.orders) setText(el.lastElementChild as HTMLElement, orderLabel(o));
    }
    const key = me.squad.map((s) => s.id).join(',');
    if (key !== this.key) {
      this.key = key;
      this.pipEls.length = 0;
      if (!me.squad.length) {
        this.pips.replaceChildren(h('span', { class: 'none' }, t('hud.squadEmpty')));
      } else {
        this.pips.replaceChildren(
          ...me.squad.map(() => {
            const fill = h('i');
            const pip = h('span', { class: 'pip' }, fill);
            this.pipEls.push(fill);
            return pip;
          }),
        );
      }
    }
    me.squad.forEach((s, i) => {
      const fill = this.pipEls[i];
      if (!fill) return;
      const p = r1(Math.max(0, Math.min(1, s.hp / Math.max(1, s.maxHp))));
      const tr = `scaleY(${p})`;
      if (fill.style.transform !== tr) {
        fill.style.transform = tr;
        setClass(fill.parentElement as HTMLElement, 'hurt', p < 0.4);
        setClass(fill.parentElement as HTMLElement, 'dead', p <= 0);
      }
    });
    const o = me.order.kind;
    if (o !== this.order) {
      this.order = o;
      setText(this.orderEl, t(`hud.order.${o}` as I18nKey));
      for (const [k, el] of this.orders) setClass(el, 'on', k === o);
      if (typeof this.el.animate === 'function') {
        this.el.animate([{ boxShadow: '0 0 0 2px #7fe09a, 0 0 14px rgba(127, 224, 154, 0.7)' }, { boxShadow: '0 0 0 0 rgba(127, 224, 154, 0)' }], { duration: 500, easing: 'ease-out' });
      }
    }
  }

  relabel(): void {
    this.key = '';
    this.order = '';
    this.lang = '';
    setText(this.titleEl, t('hud.squad'));
    for (const [k, el] of this.orders) el.title = t(`hud.order.${k}` as I18nKey);
  }
}

// ── Top bar: role chip, clock, alive count, zone timer ───────────────────────

export class TopBar {
  readonly el: HTMLElement;
  private readonly roleChip: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly alive: HTMLElement;
  private readonly zonePhase: HTMLElement;
  private readonly zoneText: HTMLElement;
  private readonly zoneBox: HTMLElement;
  private roleKey = '';
  private clockSecs = -1;
  private aliveN = -1;
  private zoneKey = '';

  constructor(private readonly bountyName: (id: number) => string) {
    this.roleChip = h('div', { class: 'role-chip' });
    this.clock = h('span', { class: 'clock' });
    this.alive = h('span', { class: 'alive' });
    this.zonePhase = h('span', { class: 'zphase' });
    this.zoneText = h('span', { class: 'ztext' });
    this.zoneBox = h('div', { class: 'hud-zone' }, this.zonePhase, this.zoneText);
    this.el = h('div', { class: 'hud-top' },
      this.roleChip,
      h('div', { class: 'hud-topcenter' }, this.zoneBox, h('div', { class: 'match-info' }, this.clock, h('span', { class: 'dot' }, '·'), this.alive)),
    );
  }

  update(f: HudFrame): void {
    const me = f.me;
    const role = me?.role;
    const rk = `${role ?? ''}|${me?.bountyTargetId ?? ''}|${f.lang}`;
    if (rk !== this.roleKey) {
      this.roleKey = rk;
      if (role) {
        const def = ROLE_BY_ID[role];
        const s = h('span', { class: 'sg-seal', style: `--seal:${roleColor(role)};--sz:1.9em` }, h('span', null, ROLE_GLYPH[role]));
        this.roleChip.replaceChildren(
          s,
          h('div', { class: 'rc-text' },
            h('b', null, roleName(role)),
            h('span', { class: 'goal' }, def ? tx(def.goalZh, def.goalEn) : ''),
            me?.bountyTargetId !== undefined ? h('span', { class: 'bounty' }, t('hud.bountyTarget', { name: this.bountyName(me.bountyTargetId) })) : null,
          ),
        );
        this.roleChip.style.setProperty('--rc', roleColor(role));
      } else this.roleChip.replaceChildren();
    }
    const secs = Math.floor(f.elapsed);
    if (secs !== this.clockSecs) {
      this.clockSecs = secs;
      setText(this.clock, fmtTime(secs));
      const zs = zoneStatus(f.zone, f.elapsed);
      const zk = `${f.zone.phase}|${zs.kind}|${Math.ceil(zs.secs)}|${f.lang}`;
      if (zk !== this.zoneKey) {
        this.zoneKey = zk;
        setText(this.zonePhase, f.zone.phase > 0 ? t('hud.zone.phase', { n: f.zone.phase }) : '');
        setClass(this.zonePhase, 'sg-hidden', f.zone.phase <= 0);
        setText(this.zoneText, zs.kind === 'wait' ? t('hud.zone.wait', { t: fmtTime(zs.secs) }) : zs.kind === 'shrink' ? t('hud.zone.shrink', { t: fmtTime(zs.secs) }) : t('hud.zone.final'));
        setClass(this.zoneBox, 'shrinking', zs.kind === 'shrink');
        setClass(this.zoneBox, 'soon', zs.kind === 'wait' && zs.secs <= 10);
      }
    }
    const n = aliveCount(f.players);
    if (n !== this.aliveN) {
      this.aliveN = n;
      setText(this.alive, t('hud.alive', { n: `${n}/${f.players.length}` }));
    }
  }

  relabel(): void {
    this.roleKey = '';
    this.zoneKey = '';
    this.aliveN = -1;
    this.clockSecs = -1;
  }
}
