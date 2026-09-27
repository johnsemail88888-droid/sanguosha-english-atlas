// Skill facts as DOM (hero select detail, 武将图鉴, 玩法说明 → 武将技能, the HUD skill
// tooltip): the aim tag, the one plain line and the key-number chips, all generated
// from the ability data by data/skillInfo.ts.
import type { AbilityDef } from '../data/types';
import { AIM_LABEL, skillAim, skillAimed, skillLine, skillStats, type SkillLang } from '../data/skillInfo';
import { h } from './dom';

/** 「准星敌人」-style tag: how the skill is aimed. */
export function aimTag(def: AbilityDef, lang: SkillLang): HTMLElement {
  const a = skillAim(def);
  return h('span', { class: `sk-aim a-${a}` }, AIM_LABEL[a][lang === 'en' ? 1 : 0]);
}

/** The key numbers as chips (伤害 90 · 位移 8 米 · …); `skipCooldown` when the cooldown shows elsewhere. */
export function skillChips(def: AbilityDef, lang: SkillLang, opts: { skipCooldown?: boolean } = {}): HTMLElement | null {
  const stats = skillStats(def, lang).filter((s) => !(opts.skipCooldown && s.kind === 'cooldown'));
  if (!stats.length) return null;
  return h('div', { class: 'sk-chips' }, stats.map((s) => h('span', { class: `sk-chip k-${s.kind}` }, h('i', null, s.label), h('b', null, s.value))));
}

/** The one plain line. */
export function skillLineEl(def: AbilityDef, lang: SkillLang): HTMLElement {
  return h('p', { class: 'sk-line' }, skillLine(def, lang));
}

/**
 * Does the full description say more than the one line? (A short passive's description
 * often only repeats it: 权衡 「所有武器换弹快 20%」 / 「所有武器换弹速度 +20%」.)
 */
export function addsToLine(def: AbilityDef, lang: SkillLang): boolean {
  const desc = lang === 'en' ? def.descEn : def.descZh;
  return desc.length > skillLine(def, lang).length * 1.35;
}

/** How to use it from the keyboard: hold to preview + release, or press. */
export function castHint(def: AbilityDef, key: string, lang: SkillLang): string {
  if (!key) return '';
  if (skillAimed(def)) return lang === 'en' ? `Hold ${key} to see the area, release to cast · right click cancels` : `按住 ${key} 看范围，松开施放 · 右键取消`;
  return lang === 'en' ? `Press ${key} to cast` : `按 ${key} 立即施放`;
}
