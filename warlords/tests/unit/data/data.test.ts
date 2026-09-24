import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { defaultSettings, type Kingdom, type StatusId } from '../../../src/core/types';
import {
  ABILITY_BY_ID,
  ABILITY_HERO,
  ARMORS,
  ARMOR_BY_ID,
  BARBARIAN_TROOP_IDS,
  BULLET_EVASION_CAP,
  HEROES,
  HERO_BY_ID,
  ITEMS,
  ITEM_BY_ID,
  KINGDOM_INFO,
  KINGDOM_TROOP,
  LOOT_TABLES,
  LORD_CANDIDATE_IDS,
  MOUNTS,
  MOUNT_BY_ID,
  ROLES,
  STATUS_HINTS,
  STATUS_HINT_BY_ID,
  TROOPS,
  TROOP_BY_ID,
  WEAPONS,
  WEAPON_BY_ID,
  heroAbility,
  heroPassives,
  isPassiveAbility,
  lootRarity,
  rollAirdropLoot,
  rollCrateLoot,
  rollLoot,
  rollRewardItems,
  timeToKill,
  weaponDps,
  type AbilityDef,
  type LootTableId,
  type Rarity,
  type WeaponDef,
} from '../../../src/data';

const SPEC_HERO_IDS: Record<Exclude<Kingdom, 'god'>, string[]> = {
  shu: ['liubei', 'guanyu', 'zhangfei', 'zhugeliang', 'zhaoyun', 'machao', 'huangyueying', 'huangzhong'],
  wei: ['caocao', 'simayi', 'xiahoudun', 'zhangliao', 'xuchu', 'guojia', 'zhenji', 'xiahouyuan'],
  wu: ['sunquan', 'ganning', 'lumeng', 'huanggai', 'zhouyu', 'daqiao', 'luxun', 'sunshangxiang'],
  qun: ['huatuo', 'lubu', 'diaochan', 'zhangjiao', 'yuanshao', 'menghuo'],
};
const SPEC_LORDS = ['liubei', 'caocao', 'sunquan', 'zhangjiao', 'yuanshao'];
const SPEC_SGS_WEAPONS = ['zhuge', 'qinggang', 'cixiong', 'hanbing', 'guding', 'qinglong', 'zhangba', 'guanshi', 'zhuque', 'fangtian', 'qilin'];
const SPEC_SIGNATURES = ['longdan', 'liegong', 'jinfan', 'xiaoji', 'taiping', 'wushuang', 'huben', 'qingnang'];
const SPEC_TROOP_WEAPONS = ['troop_rifle', 'troop_smg', 'troop_crossbow', 'troop_shotgun', 'troop_melee', 'turret_smg'];
const SPEC_ITEMS = [
  'sha', 'shan', 'tao', 'jiu', 'wuzhong', 'guohe', 'shunshou', 'juedou', 'jiedao', 'wuxie', 'nanman', 'wanjian',
  'taoyuan', 'wugu', 'huogong', 'tiesuo', 'lebusishu', 'bingliang', 'shandian', 'zhengbing',
];
const SPEC_ARMORS = ['bagua', 'renwang', 'tengjia', 'baiyin'];
const SPEC_MOUNTS = ['chitu', 'dawan', 'zixing', 'dilu', 'jueying', 'zhuahuang'];
const SPEC_TROOPS = [
  'shu_rifleman', 'wei_tiger', 'wu_crossbow', 'qun_raider', 'yellowTurban', 'yellowTurbanElite', 'barbarian', 'elephant',
  'shu_militia', 'wei_tigerGuard', 'qun_crossbowman', 'yellowTurbanWarrior',
];
/** Exhaustive at compile time: adding a StatusId without listing it here fails typecheck. */
const ALL_STATUS: Record<StatusId, true> = {
  stun: true, root: true, slow: true, haste: true, burn: true, freeze: true, poison: true, stealth: true,
  invuln: true, untargetable: true, dmgBoost: true, dmgTakenUp: true, dmgTakenDown: true, noReload: true,
  fireRateUp: true, reveal: true, charm: true, silence: true, disarm: true, dance: true, nullify: true,
  chained: true, marked: true, dodgeChance: true, regen: true, lifesteal: true, reflect: true, thorns: true,
  undodgeable: true, pierce: true, shield: true, drunk: true,
};

const hanCount = (s: string): number => (s.match(/\p{Script=Han}/gu) ?? []).length;
const HEX = /^#[0-9a-f]{6}$/i;

function expectUnique(ids: string[], what: string): void {
  const seen = new Set<string>();
  const dups = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  expect(dups, `duplicate ${what} ids`).toEqual([]);
}

/** Walk any data value; report NaN / Infinity / negative numbers with their path. */
function badNumbers(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) out.push(`${path}=${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => badNumbers(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) badNumbers(v, `${path}.${k}`, out);
  }
}

/** Params that mean "this deals damage": such abilities/items must declare `dtype` (and vice versa). */
const DAMAGE_KEYS = ['damage', 'shotDamage', 'explodeDamage', 'fieldDps', 'dps', 'burnDps', 'bonusSlash', 'reflectFrac', 'loserDamage'];
const dealsDamage = (params: Record<string, number>): boolean => DAMAGE_KEYS.some((k) => params[k] !== undefined);

/**
 * Most damage one cast can put on ONE target (all charges, every counted hit, one full fire field),
 * before the owner's passives. Line blasts (`blasts`) hit each unit once (heroes.ts header).
 */
function castDamage(p: Record<string, number>, charges = 1): number {
  const period = p.tickEvery ?? p.interval;
  const hits = p.bolts ?? p.arrows ?? p.shots ?? (p.duration !== undefined && period ? Math.floor(p.duration / period) : 1);
  const perHit = (p.damage ?? p.shotDamage ?? 0) + (p.explodeDamage ?? 0);
  const field = (p.fieldDps ?? 0) * (p.fieldTime ?? 0) + (p.dps ?? 0) * (p.duration ?? 0) + (p.burnDps ?? 0) * (p.burnTime ?? 0);
  return (perHit * hits + field) * charges;
}

/**
 * Every passive with a `mul` param must be classified here: which of the owner's abilities it
 * multiplies (worst case — conditions like 赤胆's low HP or 突袭's back-stab assumed met).
 */
const PASSIVE_DAMAGE_MUL: Record<string, (a: AbilityDef) => boolean> = {
  guanyu_wusheng: (a) => a.dtype === 'melee' || a.dtype === 'fire' || a.dtype === 'explosive',
  huanggai_chidan: (a) => a.dtype === 'fire' || a.dtype === 'explosive',
  zhangjiao_guidao: (a) => a.dtype === 'thunder',
  huangzhong_liegong: () => true,
  zhangliao_liaolai: () => true,
  zhaoyun_longdan: (a) => a.params.weaponHit === 1, // weapon damage only
};

function passiveMul(heroId: string, a: AbilityDef): number {
  return heroPassives(heroId).reduce((m, p) => (PASSIVE_DAMAGE_MUL[p.id]?.(a) ? m * (p.params.mul ?? 1) : m), 1);
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
const alphaHead = (w: WeaponDef): number => (w.damage * w.headshotMul + (w.projectile?.explodeDamage ?? 0)) * w.pellets;

describe('ids', () => {
  it('are unique within every table', () => {
    expectUnique(HEROES.map((h) => h.id), 'hero');
    expectUnique(HEROES.flatMap((h) => h.abilities.map((a) => a.id)), 'ability');
    expectUnique(WEAPONS.map((w) => w.id), 'weapon');
    expectUnique(TROOPS.map((t) => t.id), 'troop');
    expectUnique(ROLES.map((r) => r.id), 'role');
    // spawnLoot() takes items, armors and mounts through one `itemId` field
    expectUnique([...ITEMS, ...ARMORS, ...MOUNTS].map((x) => x.id), 'item/armor/mount');
  });

  it('match the spec lists exactly', () => {
    const byKingdom = (k: Kingdom) => HEROES.filter((h) => h.kingdom === k).map((h) => h.id);
    for (const [k, ids] of Object.entries(SPEC_HERO_IDS)) expect(byKingdom(k as Kingdom)).toEqual(ids);
    expect(HEROES).toHaveLength(30);
    expect(ITEMS.map((i) => i.id).sort()).toEqual([...SPEC_ITEMS].sort());
    expect(ARMORS.map((a) => a.id).sort()).toEqual([...SPEC_ARMORS].sort());
    expect(MOUNTS.map((m) => m.id).sort()).toEqual([...SPEC_MOUNTS].sort());
    expect(TROOPS.map((t) => t.id).sort()).toEqual([...SPEC_TROOPS].sort());
    for (const id of ['pistol', 'carbine', 'smg', ...SPEC_SGS_WEAPONS, ...SPEC_SIGNATURES, ...SPEC_TROOP_WEAPONS]) {
      expect(WEAPON_BY_ID[id], `weapon ${id}`).toBeDefined();
    }
  });

  it('lookup maps are consistent with the arrays', () => {
    expect(Object.keys(HERO_BY_ID)).toHaveLength(HEROES.length);
    expect(Object.keys(WEAPON_BY_ID)).toHaveLength(WEAPONS.length);
    expect(Object.keys(ITEM_BY_ID)).toHaveLength(ITEMS.length);
    expect(Object.keys(ARMOR_BY_ID)).toHaveLength(ARMORS.length);
    expect(Object.keys(MOUNT_BY_ID)).toHaveLength(MOUNTS.length);
    expect(Object.keys(TROOP_BY_ID)).toHaveLength(TROOPS.length);
    for (const [aid, hid] of Object.entries(ABILITY_HERO)) {
      expect(HERO_BY_ID[hid].abilities).toContain(ABILITY_BY_ID[aid]);
    }
  });
});

describe('heroes', () => {
  it('kingdom counts are Shu 8, Wei 8, Wu 8, Qun 6', () => {
    const count = (k: Kingdom) => HEROES.filter((h) => h.kingdom === k).length;
    expect([count('shu'), count('wei'), count('wu'), count('qun'), count('god')]).toEqual([8, 8, 8, 6, 0]);
  });

  it('references resolve (signature weapon, troop type of own kingdom)', () => {
    for (const h of HEROES) {
      expect(WEAPON_BY_ID[h.signatureWeapon], `${h.id} signatureWeapon`).toBeDefined();
      expect(WEAPON_BY_ID[h.signatureWeapon].class, `${h.id} signature is not a troop melee weapon`).not.toBe('melee');
      const troop = TROOP_BY_ID[h.troopType];
      expect(troop, `${h.id} troopType`).toBeDefined();
      expect(troop.kingdom).toBe(h.kingdom);
      expect(h.troopType).toBe(KINGDOM_TROOP[h.kingdom]);
    }
  });

  it('every hero has passive + q + e; lords have exactly one lord skill', () => {
    expect([...LORD_CANDIDATE_IDS].sort()).toEqual([...SPEC_LORDS].sort());
    for (const h of HEROES) {
      const slots = h.abilities.map((a) => a.slot);
      const n = (s: string) => slots.filter((x) => x === s).length;
      expect(n('passive'), `${h.id} passives`).toBeGreaterThanOrEqual(1);
      expect(n('passive'), `${h.id} passives`).toBeLessThanOrEqual(2);
      expect(n('q'), `${h.id} q`).toBe(1);
      expect(n('e'), `${h.id} e`).toBe(1);
      expect(n('lord'), `${h.id} lord`).toBe(h.lordCandidate ? 1 : 0);
      expect(heroAbility(h.id, 'q')?.slot).toBe('q');
      expect(heroPassives(h.id)).toHaveLength(n('passive'));
      for (const a of h.abilities) expect(a.id.startsWith(`${h.id}_`), `${a.id} prefixed by hero id`).toBe(true);
    }
  });

  it('actives have cooldowns in range, passives have none', () => {
    for (const h of HEROES) {
      for (const a of h.abilities) {
        // passives — and passive-style lord skills such as 袁绍 血裔 — have no cooldown or targeting
        if (a.slot === 'passive' || (a.slot === 'lord' && a.cooldown === undefined)) {
          expect(a.cooldown, `${a.id}`).toBeUndefined();
          expect(a.targeting, `${a.id}`).toBeUndefined();
          expect(a.charges, `${a.id}`).toBeUndefined();
          continue;
        }
        expect(a.cooldown, `${a.id} cooldown`).toBeDefined();
        const [lo, hi] = a.slot === 'q' ? [6, 30] : [12, 45];
        expect(a.cooldown!, `${a.id} cooldown`).toBeGreaterThanOrEqual(lo);
        expect(a.cooldown!, `${a.id} cooldown`).toBeLessThanOrEqual(hi);
        expect(a.targeting, `${a.id} targeting`).toBeDefined();
        expect(a.aiHint, `${a.id} aiHint`).toBeDefined();
        if (a.charges !== undefined) expect(a.charges).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('texts are present, bilingual and within length limits', () => {
    for (const h of HEROES) {
      for (const s of [h.nameZh, h.nameEn, h.titleZh, h.titleEn, h.bioZh, h.bioEn, h.playstyleZh, h.playstyleEn]) {
        expect(s.trim().length, `${h.id} text`).toBeGreaterThan(0);
      }
      expect(h.quotesZh.length, `${h.id} quotes`).toBeGreaterThanOrEqual(2);
      expect(h.quotesZh.length, `${h.id} quotes`).toBeLessThanOrEqual(3);
      expect(h.quotesEn?.length, `${h.id} quotesEn`).toBe(h.quotesZh.length);
      for (const a of h.abilities) {
        expect(hanCount(a.descZh), `${a.id} descZh "${a.descZh}"`).toBeLessThanOrEqual(42);
        expect(hanCount(a.descZh), `${a.id} descZh`).toBeGreaterThan(5);
        expect(a.descEn.length, `${a.id} descEn "${a.descEn}"`).toBeLessThanOrEqual(130);
        expect(a.nameZh.length && a.nameEn.length && a.sgsSkill.length, `${a.id} names`).toBeTruthy();
      }
    }
  });

  it('every number in a description is a param or a cooldown/charge value', () => {
    // Guards against text drifting away from the tunables the implementation reads.
    const drift: string[] = [];
    for (const h of HEROES) {
      for (const a of h.abilities) {
        // 1 is allowed as a plain count word ("1 item", "1 次")
        const allowed = new Set<number>([1, ...Object.values(a.params), a.cooldown ?? -1, a.charges ?? -1]);
        for (const v of Object.values(a.params)) {
          allowed.add(Math.round(v * 100)); // 0.3 → "30%"
          allowed.add(Math.round((v - 1) * 100)); // 1.3 → "+30%"
          allowed.add(Math.round((1 - v) * 100)); // 0.7 → "-30%"
        }
        if (a.params.chance1 !== undefined) [60, 50, 40, 30].forEach((x) => allowed.add(x));
        for (const text of [a.descZh, a.descEn]) {
          for (const n of (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)) {
            if (!allowed.has(n)) drift.push(`${a.id}: ${n} in "${text}"`);
          }
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('stats are sane: HP, speed, hard CC and temporary summons', () => {
    for (const h of HEROES) {
      expect(h.maxHp).toBe(h.sgsHp * 100);
      expect(h.speedMul).toBeGreaterThanOrEqual(0.9);
      expect(h.speedMul).toBeLessThanOrEqual(1.15);
      expect([0, 1, 2]).toContain(h.troopBonus);
      // passive `troopBonus` params only mirror HeroDef.troopBonus (never applied twice)
      const mirrored = h.abilities.reduce((n, a) => n + (a.slot === 'passive' ? (a.params.troopBonus ?? 0) : 0), 0);
      expect(mirrored, `${h.id} troopBonus mirror`).toBe(h.troopBonus);
      for (const a of h.abilities) {
        for (const key of ['stun', 'stunHero']) {
          if (a.params[key] !== undefined) expect(a.params[key], `${a.id}.${key} ≤ 1.5 s on heroes`).toBeLessThanOrEqual(1.5);
        }
        if (a.params.bolts !== undefined && a.params.stun !== undefined) {
          const stunned = Math.min(a.params.bolts, a.params.stunBolts ?? a.params.bolts);
          expect(stunned * a.params.stun, `${a.id} chained stun`).toBeLessThanOrEqual(1.5);
          // re-stunning before the previous stun wears off would chain hard CC past the cap
          if (stunned > 1) expect(a.params.interval, `${a.id} stun gap`).toBeGreaterThan(a.params.stun + 0.5);
        }
        // anything that adds units is either a temporary summon or a capped recruit
        if ((a.aiHint === 'summon' && a.params.count !== undefined) || a.params.recruit !== undefined) {
          const temporary = (a.params.lifetime ?? 0) > 0;
          const capped = a.params.overCap !== undefined;
          expect(temporary || capped, `${a.id} must be temporary or capped`).toBe(true);
          if (temporary) expect(a.params.lifetime).toBeLessThanOrEqual(40);
        }
        // summons and deployables may not be up more than 80 % of the time (so 集智 can't chain
        // two permanent turrets out of maxActive)
        if (a.aiHint === 'summon' && a.params.lifetime !== undefined && a.cooldown) {
          expect(a.params.lifetime / a.cooldown, `${a.id} summon uptime`).toBeLessThanOrEqual(0.8);
        }
        if (a.params.duration !== undefined && a.slot !== 'passive') {
          expect(a.params.duration, `${a.id} duration`).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  it('every damaging ability declares its damage type (and only those do)', () => {
    for (const h of HEROES) {
      for (const a of h.abilities) {
        expect(a.dtype !== undefined, `${a.id} dtype iff it deals damage (${Object.keys(a.params).join(',')})`).toBe(dealsDamage(a.params));
        if (a.params.weaponHit !== undefined) expect(a.dtype, `${a.id} weapon hits are bullets`).toBe('normal');
      }
    }
  });

  it('no single cast one-shots a full-HP 3-HP hero, even with the owner\'s passives', () => {
    const muls = new Set(Object.keys(PASSIVE_DAMAGE_MUL));
    for (const h of HEROES) {
      for (const p of heroPassives(h.id)) {
        if (p.params.mul !== undefined) expect(muls.has(p.id), `${p.id}: classify its mul in PASSIVE_DAMAGE_MUL`).toBe(true);
      }
    }
    const rows = HEROES.flatMap((h) =>
      h.abilities
        .filter((a) => !isPassiveAbility(a) && a.dtype !== undefined)
        .map((a) => {
          const base = castDamage(a.params, a.charges ?? 1);
          const mul = passiveMul(h.id, a);
          return { ability: a.id, dtype: a.dtype, cd: a.cooldown, base: Math.round(base), passiveMul: mul, burst: Math.round(base * mul) };
        }),
    );
    // eslint-disable-next-line no-console
    console.table(rows);
    for (const r of rows) {
      expect(r.base, `${r.ability} recognised by castDamage`).toBeGreaterThan(0);
      expect(r.burst, `${r.ability} burst`).toBeLessThan(300);
    }
    // 酒 must stay weapon-only, otherwise single-hit abilities (辕门射戟, 百步穿杨) double past the cap
    expect(ITEM_BY_ID.jiu.params.weaponOnly).toBe(1);
  });

  it('passive lord skills are marked by having no cooldown and are capped', () => {
    for (const h of HEROES) {
      for (const a of h.abilities) {
        expect(isPassiveAbility(a), a.id).toBe(a.slot === 'passive' || a.cooldown === undefined);
        if (a.slot === 'lord' && a.cooldown === undefined) {
          expect(a.descZh.startsWith('被动主公技'), `${a.id} says it is passive`).toBe(true);
          expect(a.descEn.startsWith('Passive lord skill'), `${a.id} says it is passive`).toBe(true);
          if (a.params.hpPerQun !== undefined) {
            expect(a.params.maxQun, `${a.id} max HP bonus is capped`).toBeDefined();
            expect(a.params.hpPerQun * a.params.maxQun).toBeLessThanOrEqual(150);
          }
        }
      }
    }
  });

  it('a Lord squad never exceeds 8 soldiers (base + hero bonus + Lord +2 + lord skill)', () => {
    const base = defaultSettings().troopsPerHero;
    for (const h of HEROES.filter((x) => x.lordCandidate)) {
      const lordSkill = heroAbility(h.id, 'lord');
      const squad = base + h.troopBonus + 2 + (lordSkill?.params.squadBonus ?? 0);
      expect(squad, `${h.id} Lord squad`).toBeLessThanOrEqual(8);
    }
  });

  it('scouting reveals are private except the public mark', () => {
    for (const id of ['zhugeliang_guanxing', 'simayi_langgu']) expect(ABILITY_BY_ID[id].params.privateReveal, id).toBe(1);
    expect(ABILITY_BY_ID.guojia_guimou.params.privateReveal).toBeUndefined();
  });

  it('bullet evasion sources stay under the documented cap', () => {
    expect(BULLET_EVASION_CAP).toBeLessThanOrEqual(0.5);
    const sources = [ARMOR_BY_ID.bagua.params.chance, ABILITY_BY_ID.zhenji_qingguo.params.chance, ABILITY_BY_ID.zhugeliang_bazhen.params.dodge];
    for (const p of sources) expect(p).toBeLessThan(BULLET_EVASION_CAP);
  });

  it('no hero wears a crown: the crown is the Lord marker (RENDER draws it from VF_LORD)', () => {
    for (const h of HEROES) expect(h.visual.headgear, h.id).not.toBe('crown');
  });

  it('visuals are complete and silhouettes distinct', () => {
    const silhouettes = new Set<string>();
    for (const h of HEROES) {
      const v = h.visual;
      for (const c of [v.skin, v.hair, v.primary, v.secondary, v.accent, ...(v.face ? [v.face] : [])]) {
        expect(c, `${h.id} color`).toMatch(HEX);
      }
      expect(v.artPromptEn.length, `${h.id} artPrompt`).toBeGreaterThan(60);
      silhouettes.add(`${v.headgear}|${v.body}|${v.beard}|${[...v.extras].sort().join(',')}|${v.mount ?? ''}`);
    }
    expect(silhouettes.size).toBe(HEROES.length);
  });
});

describe('weapons', () => {
  it('lootability matches the spec', () => {
    for (const id of ['pistol', 'carbine', 'smg', ...SPEC_SGS_WEAPONS]) expect(WEAPON_BY_ID[id].lootable, id).toBe(true);
    for (const id of [...SPEC_SIGNATURES, ...SPEC_TROOP_WEAPONS]) expect(WEAPON_BY_ID[id].lootable, id).toBe(false);
  });

  it('fields are consistent', () => {
    for (const w of WEAPONS) {
      expect(w.damage, w.id).toBeGreaterThan(0);
      expect(w.fireRate, w.id).toBeGreaterThan(0);
      expect(w.magSize, w.id).toBeGreaterThanOrEqual(1);
      expect(w.pellets, w.id).toBeGreaterThanOrEqual(1);
      expect(w.maxRange, w.id).toBeGreaterThanOrEqual(w.falloffStart);
      expect(w.spreadHip, w.id).toBeGreaterThanOrEqual(w.spreadAds);
      expect(w.adsZoom, w.id).toBeGreaterThanOrEqual(1);
      expect(w.model.length, w.id).toBeGreaterThan(0);
      expect(w.model.bodyColor, w.id).toMatch(HEX);
      expect(w.model.accentColor, w.id).toMatch(HEX);
      expect(w.melee !== undefined, `${w.id} melee iff class melee`).toBe(w.class === 'melee');
      if (['launcher', 'bow'].includes(w.class)) expect(w.projectile, `${w.id} projectile`).toBeDefined();
      if (w.special !== 'none') expect(Object.keys(w.specialParams).length, `${w.id} specialParams`).toBeGreaterThan(0);
      if (w.class !== 'melee') expect(w.reloadTime, w.id).toBeGreaterThan(0);
    }
  });

  it('no weapon kills a full-HP 3-HP hero with one trigger pull, even on a headshot', () => {
    for (const w of WEAPONS) {
      const splash = w.projectile?.explodeDamage ?? 0;
      const alpha = (w.damage * w.headshotMul + splash) * w.pellets;
      expect(alpha, `${w.id} alpha damage`).toBeLessThan(300);
    }
  });

  it('no weapon deals 300+ headshot damage within 0.5 s (double-barrel bursts included)', () => {
    for (const w of WEAPONS) {
      const shots = Math.min(w.magSize, Math.floor(0.5 * w.fireRate) + 1);
      expect(shots * alphaHead(w), `${w.id} 0.5 s burst`).toBeLessThan(300);
    }
  });

  it('higher rarity never means less base DPS within a lootable weapon class', () => {
    const loot = WEAPONS.filter((w) => w.lootable);
    for (const a of loot) {
      for (const b of loot) {
        if (a.class !== b.class || RARITY_RANK[a.rarity] >= RARITY_RANK[b.rarity]) continue;
        expect(weaponDps(a), `${a.id} (${a.rarity}) vs ${b.id} (${b.rarity})`).toBeLessThanOrEqual(weaponDps(b));
      }
    }
  });

  it('hits the TTK anchor and keeps player weapons in a DPS band', () => {
    const carbine = timeToKill(WEAPON_BY_ID.carbine, 400);
    expect(carbine).toBeGreaterThan(2.3);
    expect(carbine).toBeLessThan(2.7);
    const rows = WEAPONS.filter((w) => !w.id.startsWith('troop_') && !w.id.startsWith('npc_') && w.id !== 'turret_smg').map((w) => ({
      id: w.id,
      class: w.class,
      rarity: w.rarity,
      loot: w.lootable ? 'yes' : 'sig',
      dps: Math.round(weaponDps(w)),
      ttk300: +timeToKill(w, 300).toFixed(2),
      ttk400: +timeToKill(w, 400).toFixed(2),
      ttk500: +timeToKill(w, 500).toFixed(2),
    }));
    // eslint-disable-next-line no-console
    console.table(rows);
    for (const r of rows) {
      // burst DPS band for sustained-fire weapons (2-shell / 2-volley weapons are judged by TTK)
      if (WEAPON_BY_ID[r.id].magSize >= 3) {
        expect(r.dps, `${r.id} dps`).toBeGreaterThanOrEqual(90);
        expect(r.dps, `${r.id} dps`).toBeLessThanOrEqual(260);
      }
      expect(r.ttk400, `${r.id} TTK 400`).toBeGreaterThanOrEqual(1.2);
      expect(r.ttk400, `${r.id} TTK 400`).toBeLessThanOrEqual(5.5);
    }
    // troops: effective squad DPS stays well under a hero's
    const troopRows = TROOPS.map((t) => ({
      id: t.id,
      weapon: t.weapon,
      hp: t.hp,
      effDps: +(weaponDps(WEAPON_BY_ID[t.weapon]) * t.accuracy).toFixed(1),
    }));
    // eslint-disable-next-line no-console
    console.table(troopRows);
    for (const r of troopRows) expect(r.effDps, r.id).toBeLessThan(50);
  });
});

describe('items, armor, mounts', () => {
  it('items have single-glyph icons, colors and sane usage fields', () => {
    for (const i of ITEMS) {
      expect([...i.icon], `${i.id} icon`).toHaveLength(1);
      expect(i.color, i.id).toMatch(HEX);
      expect(i.maxStack, i.id).toBeGreaterThanOrEqual(1);
      expect(Object.keys(i.params).length, `${i.id} params`).toBeGreaterThan(0);
      if (i.params.range !== undefined) expect(i.params.range, `${i.id} range mirrors params`).toBe(i.range);
      if (['point', 'enemy', 'ally', 'direction'].includes(i.targeting)) expect(i.range, `${i.id} range`).toBeGreaterThan(0);
    }
  });

  it('damaging items declare a damage type and stay under the burst cap', () => {
    for (const i of ITEMS) {
      expect(i.dtype !== undefined, `${i.id} dtype iff it deals damage`).toBe(dealsDamage(i.params));
      // 闪电 is a slow wandering cloud (outrun it), not burst: judge it per strike
      const burst = i.id === 'shandian' ? i.params.damage : castDamage(i.params);
      if (i.dtype) expect(burst, `${i.id} burst`).toBeLessThan(300);
    }
  });

  it('armor and mounts follow the spec shape', () => {
    for (const a of ARMORS) {
      expect(a.special).toBe(a.id);
      expect(a.bulletReduction).toBeLessThan(1);
    }
    for (const m of MOUNTS) {
      if (m.type === 'offense') {
        expect(m.speedMul).toBeGreaterThanOrEqual(1.3);
        expect(m.damageTakenMul).toBe(1);
      } else {
        expect(m.speedMul).toBeLessThanOrEqual(1.2);
        expect(m.damageTakenMul).toBeLessThan(1);
      }
    }
  });

  it('troop weapons and special id lists resolve', () => {
    for (const t of TROOPS) {
      expect(WEAPON_BY_ID[t.weapon], `${t.id} weapon`).toBeDefined();
      expect(WEAPON_BY_ID[t.weapon].lootable).toBe(false);
      expect(t.melee, `${t.id} melee flag`).toBe(WEAPON_BY_ID[t.weapon].class === 'melee');
    }
    for (const id of Object.values(KINGDOM_TROOP)) expect(TROOP_BY_ID[id]).toBeDefined();
    for (const id of BARBARIAN_TROOP_IDS) expect(TROOP_BY_ID[id]).toBeDefined();
  });
});

describe('statuses and labels', () => {
  it('every StatusId has exactly one hint', () => {
    expect(STATUS_HINTS.map((s) => s.id).sort()).toEqual((Object.keys(ALL_STATUS) as StatusId[]).sort());
    for (const id of Object.keys(ALL_STATUS) as StatusId[]) {
      const hint = STATUS_HINT_BY_ID[id];
      expect([...hint.icon], `${id} icon`).toHaveLength(1);
      expect(hint.color).toMatch(HEX);
    }
  });

  it('kingdom info covers every kingdom', () => {
    for (const k of ['wei', 'shu', 'wu', 'qun', 'god'] as Kingdom[]) {
      expect(KINGDOM_INFO[k].id).toBe(k);
      expect(KINGDOM_INFO[k].color).toMatch(HEX);
    }
    expect(KINGDOM_INFO.shu.color).toBe('#c0392b');
    expect(KINGDOM_INFO.wei.color).toBe('#2e5fa8');
    expect(KINGDOM_INFO.wu.color).toBe('#2e8b57');
    expect(KINGDOM_INFO.qun.color).toBe('#8a8a8a');
  });
});

describe('loot', () => {
  it('every entry resolves to a def of its kind, weapons are lootable', () => {
    for (const [table, entries] of Object.entries(LOOT_TABLES)) {
      expect(entries.length, table).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.weight, `${table}:${e.id}`).toBeGreaterThan(0);
        expect(lootRarity(e.kind, e.id), `${table}:${e.kind}:${e.id}`).toBeDefined();
        if (e.kind === 'weapon') expect(WEAPON_BY_ID[e.id].lootable, `${table}:${e.id}`).toBe(true);
      }
      expectUnique(entries.map((e) => `${e.kind}:${e.id}`), `${table} entry`);
    }
    expect(LOOT_TABLES.reward.every((e) => e.kind === 'item')).toBe(true);
    // every item and lootable weapon can actually be found somewhere
    const all = new Set(Object.values(LOOT_TABLES).flat().map((e) => e.id));
    for (const i of ITEMS) expect(all.has(i.id), `item ${i.id} obtainable`).toBe(true);
    for (const w of WEAPONS.filter((x) => x.lootable)) expect(all.has(w.id), `weapon ${w.id} obtainable`).toBe(true);
    for (const x of [...ARMORS, ...MOUNTS]) expect(all.has(x.id), `${x.id} obtainable`).toBe(true);
  });

  it('rollLoot is deterministic, sized and duplicate-free', () => {
    const a = rollLoot('tier2', new Rng(42), 3);
    const b = rollLoot('tier2', new Rng(42), 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(new Set(a.map((d) => d.id)).size).toBe(3);
    expect(rollLoot('tier1', new Rng(1), 0)).toEqual([]);
    // exhausting a small table refills instead of failing
    expect(rollLoot([{ kind: 'item', id: 'tao', weight: 1 }], new Rng(3), 3)).toHaveLength(3);
  });

  it('respects weights and filters', () => {
    const rng = new Rng(7);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const [d] = rollLoot('ground', rng, 1);
      counts[d.id] = (counts[d.id] ?? 0) + 1;
    }
    expect(counts.sha).toBeGreaterThan(counts.tao); // 16 vs 7
    expect(counts.tao).toBeGreaterThan(counts.qinggang ?? 0); // 7 vs 0.7
    const epics = rollLoot('airdrop', new Rng(9), 5, { kinds: ['weapon'], minRarity: 'epic' });
    for (const d of epics) {
      expect(d.kind).toBe('weapon');
      expect(['epic', 'legendary']).toContain(lootRarity(d.kind, d.id));
    }
    for (const id of rollRewardItems(new Rng(11), 20, 'rare')) expect(ITEM_BY_ID[id].rarity).not.toBe('common');
  });

  it('crate and airdrop compositions follow the spec', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = new Rng(seed);
      const t1 = rollCrateLoot(1, rng);
      expect(t1.length).toBeGreaterThanOrEqual(1);
      expect(t1.length).toBeLessThanOrEqual(2);
      const t2 = rollCrateLoot(2, rng);
      expect(t2.length).toBeGreaterThanOrEqual(2);
      expect(t2.length).toBeLessThanOrEqual(3);
      expect(t2[0].kind).toBe('weapon');
      expect(lootRarity('weapon', t2[0].id)).not.toBe('common');
      for (const drop of [rollCrateLoot(3, rng), rollAirdropLoot(rng)]) {
        expect(drop.map((d) => d.kind)).toEqual(['weapon', expect.stringMatching(/^(armor|mount)$/), 'item', 'item']);
        expect(['epic', 'legendary']).toContain(lootRarity('weapon', drop[0].id));
      }
    }
  });

  it('table ids are the documented set', () => {
    expect(Object.keys(LOOT_TABLES).sort()).toEqual((['tier1', 'tier2', 'tier3', 'airdrop', 'ground', 'reward'] as LootTableId[]).sort());
  });
});

describe('numbers', () => {
  it('no NaN, Infinity or negative numbers anywhere in content data', () => {
    const bad: string[] = [];
    badNumbers(HEROES, 'HEROES', bad);
    badNumbers(WEAPONS, 'WEAPONS', bad);
    badNumbers(ITEMS, 'ITEMS', bad);
    badNumbers(ARMORS, 'ARMORS', bad);
    badNumbers(MOUNTS, 'MOUNTS', bad);
    badNumbers(TROOPS, 'TROOPS', bad);
    badNumbers(LOOT_TABLES, 'LOOT_TABLES', bad);
    expect(bad).toEqual([]);
  });
});
