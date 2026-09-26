// Generates docs/HEROES.md — the bilingual player-facing hero guide — from the
// content data. Kept in the test tree so it never ends up in the game bundle.
import { defaultSettings } from '../../../src/core/types';
import {
  ABILITY_SLOT_INFO,
  ARMORS,
  DAMAGE_TYPE_INFO,
  HEROES,
  ITEMS,
  ITEM_KIND_INFO,
  KINGDOM_INFO,
  MOUNTS,
  RARITY_INFO,
  TROOP_BY_ID,
  WEAPONS,
  WEAPON_BY_ID,
  WEAPON_CLASS_INFO,
  isPassiveAbility,
  timeToKill,
  weaponDps,
  type AbilityDef,
  type HeroDef,
} from '../../../src/data';

const KINGDOMS = ['shu', 'wei', 'wu', 'qun'] as const;
const SLOT_ORDER: AbilityDef['slot'][] = ['passive', 'q', 'e', 'lord'];

/** Markdown table cells must not contain raw pipes or newlines. */
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const stars = (d: number): string => '★'.repeat(d) + '☆'.repeat(3 - d);
const fmt = (n: number, digits = 2): string => (Number.isFinite(n) ? n.toFixed(digits) : '—');

function abilityKey(a: AbilityDef): string {
  if (a.slot === 'passive') return '被动<br>Passive';
  // a lord skill without a cooldown is passive: G does nothing for it
  if (a.slot === 'lord') return isPassiveAbility(a) ? '被动主公技<br>Passive lord skill' : `${ABILITY_SLOT_INFO.lord.key}<br>主公技`;
  return ABILITY_SLOT_INFO[a.slot].key;
}

function abilityRow(a: AbilityDef): string {
  const key = abilityKey(a);
  const cd = a.cooldown === undefined ? '—' : `${a.cooldown} s${a.charges ? ` ×${a.charges}` : ''}`;
  const dt = a.dtype ? DAMAGE_TYPE_INFO[a.dtype] : undefined;
  const dmg = dt ? `<br><sub>${dt.nameZh}伤害 · ${dt.nameEn} damage</sub>` : '';
  const name = `**${cell(a.nameZh)}**<br>${cell(a.nameEn)}<br><sub>三国杀：${cell(a.sgsSkill)}</sub>${dmg}`;
  return `| ${key} | ${name} | ${cd} | ${cell(a.descZh)}<br>${cell(a.descEn)} |`;
}

function heroSection(h: HeroDef): string {
  const k = KINGDOM_INFO[h.kingdom];
  const w = WEAPON_BY_ID[h.signatureWeapon];
  const troop = TROOP_BY_ID[h.troopType];
  const squad = defaultSettings().troopsPerHero + h.troopBonus;
  const lines: string[] = [];
  lines.push(`### ${h.nameZh} ${h.nameEn}${h.lordCandidate ? ' ★' : ''}`);
  lines.push('');
  lines.push(`*${h.titleZh} · ${h.titleEn}*`);
  lines.push('');
  lines.push('| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(
    `| ${k.nameZh} ${k.nameEn} | ${h.sgsHp} (${h.maxHp}) | ×${h.speedMul.toFixed(2)} | ${troop.nameZh} ${troop.nameEn} ×${squad} | ${w.nameZh} ${w.nameEn} | ${stars(h.difficulty)} |`,
  );
  lines.push('');
  lines.push(`> ${h.bioZh}`);
  lines.push('>');
  lines.push(`> ${h.bioEn}`);
  lines.push('');
  lines.push(`**定位 Role** — ${h.playstyleZh}<br>${h.playstyleEn}`);
  lines.push('');
  lines.push('| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |');
  lines.push('|---|---|---|---|');
  const sorted = [...h.abilities].sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  for (const a of sorted) lines.push(abilityRow(a));
  lines.push('');
  lines.push('**台词 Quotes**');
  lines.push('');
  h.quotesZh.forEach((q, i) => {
    const en = h.quotesEn?.[i];
    lines.push(`- 「${q}」${en ? ` — *${en}*` : ''}`);
  });
  lines.push('');
  return lines.join('\n');
}

function rosterTable(): string {
  const lines = ['| 势力 | 武将 Hero | 称号 Title | 体力 HP | 主武器 Weapon | 难度 |', '|---|---|---|---|---|---|'];
  for (const kid of KINGDOMS) {
    for (const h of HEROES.filter((x) => x.kingdom === kid)) {
      const w = WEAPON_BY_ID[h.signatureWeapon];
      const anchor = `${h.nameZh}-${h.nameEn}${h.lordCandidate ? '-' : ''}`
        .toLowerCase()
        .replace(/[ ·]/g, '-')
        .replace(/[^\p{L}\p{N}-]/gu, '');
      lines.push(
        `| ${KINGDOM_INFO[kid].nameZh} | [${h.nameZh} ${h.nameEn}](#${anchor})${h.lordCandidate ? ' ★' : ''} | ${h.titleZh} · ${h.titleEn} | ${h.sgsHp} | ${w.nameZh} | ${stars(h.difficulty)} |`,
      );
    }
  }
  return lines.join('\n');
}

function weaponTable(): string {
  const lines = [
    '| 武器 Weapon | 原型 Card | 类型 Class | 稀有度 Rarity | DPS | TTK 300 / 400 | 特效 Special |',
    '|---|---|---|---|---|---|---|',
  ];
  const playerWeapons = WEAPONS.filter((w) => w.lootable || HEROES.some((h) => h.signatureWeapon === w.id));
  for (const w of playerWeapons) {
    const owner = HEROES.filter((h) => h.signatureWeapon === w.id).map((h) => h.nameZh);
    const tag = w.lootable ? RARITY_INFO[w.rarity].nameZh + ' ' + RARITY_INFO[w.rarity].nameEn : `专属 Signature`;
    lines.push(
      `| **${w.nameZh}** ${w.nameEn}${owner.length ? `<br><sub>${owner.join('、')}</sub>` : ''} | ${w.sgsCard || '—'} | ${WEAPON_CLASS_INFO[w.class].nameZh} | ${tag} | ${Math.round(weaponDps(w))} | ${fmt(timeToKill(w, 300))} / ${fmt(timeToKill(w, 400))} s | ${cell(w.descZh)}<br>${cell(w.descEn)} |`,
    );
  }
  return lines.join('\n');
}

function itemTable(): string {
  const lines = ['| 图标 | 锦囊 Item | 类型 Kind | 效果 Effect |', '|---|---|---|---|'];
  for (const i of ITEMS) {
    const kind = ITEM_KIND_INFO[i.kind];
    lines.push(`| ${i.icon} | **${i.nameZh}** ${i.nameEn} | ${kind.nameZh} ${kind.nameEn} | ${cell(i.descZh)}<br>${cell(i.descEn)} |`);
  }
  return lines.join('\n');
}

function gearTable(): string {
  const lines = ['| 装备 Gear | 类型 Type | 效果 Effect |', '|---|---|---|'];
  for (const a of ARMORS) lines.push(`| **${a.nameZh}** ${a.nameEn} | 防具 Armor | ${cell(a.descZh)}<br>${cell(a.descEn)} |`);
  for (const m of MOUNTS) {
    const t = m.type === 'offense' ? '-1 马 Offensive mount' : '+1 马 Defensive mount';
    lines.push(`| **${m.nameZh}** ${m.nameEn} | ${t} | ${cell(m.descZh)}<br>${cell(m.descEn)} |`);
  }
  return lines.join('\n');
}

export function renderHeroesMarkdown(): string {
  const base = defaultSettings().troopsPerHero;
  const out: string[] = [];
  out.push('# 武将图鉴 · Hero Guide');
  out.push('');
  out.push('> 三国杀·枪火乱世 (Sanguo Warlords) — 30 名武将的技能、数值与玩法。<br>');
  out.push('> All 30 heroes: abilities, numbers and how to play them.');
  out.push('');
  out.push(
    '<!-- Generated from src/data by tests/unit/data/heroes-doc.test.ts. Do not edit by hand: run `UPDATE_DOCS=1 npx vitest run tests/unit/data`. -->',
  );
  out.push('');
  out.push('## 读图须知 · How to read this guide');
  out.push('');
  out.push(`- **体力 HP** = 三国杀体力 × 100；主公（及影武者）额外 +100。<br>HP = the card game's health × 100; the Lord (and Body Double) get +100.`);
  out.push(
    `- **带兵 Squad** = 基础 ${base} 名 + 武将加成（主公再 +2）。<br>Squad = ${base} base soldiers + the hero's bonus (+2 more as Lord).`,
  );
  out.push('- **Q / E** 为主动技能，**G** 为主公技——只有真正的主公才能使用；“被动主公技”无需按键，主公身份时自动生效。<br>Q / E are active abilities; **G** is the lord skill and only works for the real Lord. A “passive lord skill” needs no key: it simply applies while you are the Lord.');
  out.push(
    '- **伤害类型**：技能与锦囊伤害不算武器命中——八卦阵、仁王盾、藤甲的防弹效果只挡子弹，酒也只加倍武器命中；藤甲仍怕火，白银狮子仍限单次伤害（穿透伤害无视护甲）。<br>Ability and item damage is not a weapon hit: Bagua, Benevolent King Shield and Rattan Armor only stop bullets, and Wine only doubles weapon hits. Rattan still burns (fire ×2) and Silver Lion still caps single hits (piercing damage ignores armor).',
  );
  out.push(
    '- **敌人 / enemy** = 你、你的士兵与召唤物以外的任何单位（身份是隐藏的！）。“武将”范围效果对所有武将生效，包括敌人。<br>“Enemy” means any unit that is not you, your soldiers or your summons — roles are hidden! Area effects on “heroes” hit every hero, enemies included.',
  );
  out.push('- **★** = 主公候选 Lord candidate · 难度 Difficulty ★☆☆ easy → ★★★ hard.');
  out.push('- 眩晕等硬控对武将最多 1.5 秒；召唤物都有时限。<br>Hard CC (stun) on heroes never exceeds 1.5 s; every summon is temporary.');
  out.push('');
  out.push('## 武将一览 · Roster');
  out.push('');
  out.push(rosterTable());
  out.push('');
  for (const kid of KINGDOMS) {
    const k = KINGDOM_INFO[kid];
    out.push(`## ${k.fullZh} · ${k.fullEn}`);
    out.push('');
    for (const h of HEROES.filter((x) => x.kingdom === kid)) out.push(heroSection(h));
  }
  out.push('## 附录：军械库 · Appendix: Arsenal');
  out.push('');
  out.push('DPS = 单次扳机伤害 × 射速（不含换弹）；TTK 从第一发开始计算并包含换弹，全部身体命中。<br>');
  out.push('DPS = one trigger pull × fire rate (no reloads); TTK counts from the first shot, includes reloads, body shots only.');
  out.push('');
  out.push(weaponTable());
  out.push('');
  out.push('### 锦囊 · Items');
  out.push('');
  out.push(itemTable());
  out.push('');
  out.push('### 防具与坐骑 · Armor & Mounts');
  out.push('');
  out.push(gearTable());
  out.push('');
  return out.join('\n');
}
