// Short labels for small HUD buttons (ability icons, item cards, touch buttons).
// Chinese uses the card / skill glyphs; English gets a curated short word so a
// 44–60 px button never shows "Righteous Severance" squeezed to nothing.
// Pure data + functions (no DOM): unit-tested in tests/unit/ui.
import type { Lang } from '../game/settings';
import type { AbilityDef } from '../data/types';
import { ITEM_BY_ID } from '../data';

/** Ability id → short English label (≤ 9 characters). Missing ids fall back to shortEnglish(). */
export const ABILITY_SHORT_EN: Readonly<Record<string, string>> = {
  liubei_rende: 'Benevol.',
  liubei_jimin: 'Supplies',
  liubei_banner: 'Banner',
  liubei_jijiang: 'Rouse',
  guanyu_wusheng: 'Saint',
  guanyu_qinglong: 'Cleave',
  guanyu_yijue: 'Sever',
  zhangfei_shemao: 'Flurry',
  zhangfei_paoxiao: 'Roar',
  zhangfei_duanqiao: 'Thunder',
  zhugeliang_guanxing: 'Stargaze',
  zhugeliang_bazhen: 'Maze',
  zhugeliang_kongcheng: 'Fort',
  zhaoyun_longdan: 'Courage',
  zhaoyun_qijin: '7 In 7 Out',
  zhaoyun_jiuzhu: 'Rescue',
  machao_mashu: 'Horse',
  machao_tieji: 'Cavalry',
  machao_charge: 'Charge',
  huangyueying_jizhi: 'Wisdom',
  huangyueying_muniu: 'Turret',
  huangyueying_qicai: 'Genius',
  huangzhong_liegong: 'Bow',
  huangzhong_chuanyang: '100 Pace',
  huangzhong_laodang: 'Vigor',
  caocao_jianxiong: 'Villain',
  caocao_ningjiao: 'Betray',
  caocao_wangmei: 'Plums',
  caocao_hujia: 'Escort',
  simayi_fankui: 'Retaliate',
  simayi_guicai: 'Reflect',
  simayi_langgu: 'Wolf Eye',
  xiahoudun_ganglie: 'Unyield',
  xiahoudun_bashi: 'Eat Eye',
  xiahoudun_charge: 'Charge',
  zhangliao_liaolai: 'Liao!',
  zhangliao_tuxi: 'Raid',
  zhangliao_weizhen: 'Terror',
  xuchu_huchi: 'Tiger',
  xuchu_luoyi: 'Bare',
  xuchu_slam: 'Slam',
  guojia_tiandu: 'Envy',
  guojia_yiji: 'Airdrop',
  guojia_guimou: 'Scheme',
  zhenji_qingguo: 'Beauty',
  zhenji_luoshen: 'Luo',
  zhenji_lingbo: 'Steps',
  xiahouyuan_jixing: 'March',
  xiahouyuan_shensu: 'Godspeed',
  xiahouyuan_hubu: 'Stride',
  sunquan_quanheng: 'Deliber.',
  sunquan_zhiheng: 'Balance',
  sunquan_zuoduan: 'Recruit',
  sunquan_jiuyuan: 'Rescue',
  ganning_jinfan: 'Sails',
  ganning_qixi: 'EMP',
  ganning_jieying: 'Raiders',
  lumeng_keji: 'Restraint',
  lumeng_baiyi: 'White',
  lumeng_gongxin: 'Mind',
  huanggai_chidan: 'Loyalty',
  huanggai_kurou: 'Injury',
  huanggai_huochuan: 'Fire Ship',
  zhouyu_yingzi: 'Bearing',
  zhouyu_fanjian: 'Discord',
  zhouyu_chibi: 'Inferno',
  daqiao_liuli: 'Displace',
  daqiao_guose: 'Beauty',
  daqiao_anxian: 'Serenity',
  luxun_qianxun: 'Modesty',
  luxun_lianying: 'Camps',
  luxun_huoshao: 'Burn',
  luxun_liaoyuan: 'Wildfire',
  sunshangxiang_xiaoji: 'Princess',
  sunshangxiang_jieyin: 'Bond',
  sunshangxiang_gongyao: 'Arrows',
  huatuo_jijiu: 'First Aid',
  huatuo_qingnang: 'Satchel',
  huatuo_mafei: 'Gas',
  lubu_wushuang: 'Peerless',
  lubu_fangtian: 'Sweep',
  lubu_sheji: 'Gate Shot',
  diaochan_biyue: 'Eclipse',
  diaochan_lijian: 'Dissent',
  diaochan_lianhuan: 'Chains',
  zhangjiao_guidao: 'Ghost Way',
  zhangjiao_leiji: 'Lightning',
  zhangjiao_taiping: 'Storm',
  zhangjiao_huangtian: 'Heaven',
  yuanshao_mingmen: 'Lineage',
  yuanshao_luanji: 'Volley',
  yuanshao_sishi: 'Crossbows',
  yuanshao_xueyi: 'Bloodline',
  menghuo_huoshou: 'Culprit',
  menghuo_zaiqi: 'Resurge',
  menghuo_nanman: 'Invasion',
  menghuo_xiangbing: 'Elephant',
};

const STOP_WORDS = new Set(['of', 'the', 'at', 'in', 'a', 'an', 'and', 'to', 'is']);

/** Fallback short English label: the longest meaningful word (≤ 9 chars), else the name cut to 8 + '.' */
export function shortEnglish(name: string): string {
  const words = name.split(/[\s,·/()-]+/).filter((w) => w && !STOP_WORDS.has(w.toLowerCase()));
  if (!words.length) return name.slice(0, 8);
  const fits = words.filter((w) => w.length <= 9);
  if (fits.length) return fits.reduce((a, b) => (b.length > a.length ? b : a));
  const w = words[0];
  return w.length > 9 ? `${w.slice(0, 8)}.` : w;
}

/** Icon label of an ability: two glyphs in Chinese, a short word in English. */
export function abilityShort(def: Pick<AbilityDef, 'id' | 'nameZh' | 'nameEn'>, lang: Lang): string {
  if (lang === 'en') return ABILITY_SHORT_EN[def.id] ?? shortEnglish(def.nameEn);
  return def.nameZh.slice(0, 2);
}

/** Item (card) id → short label under the card glyph. */
export const ITEM_SHORT: Readonly<Record<string, readonly [string, string]>> = {
  sha: ['杀', 'Ammo'],
  shan: ['闪', 'Dodge'],
  tao: ['桃', 'Peach'],
  jiu: ['酒', 'Wine'],
  wuzhong: ['无中生有', 'Draw 2'],
  guohe: ['过河拆桥', 'EMP'],
  shunshou: ['顺手牵羊', 'Steal'],
  juedou: ['决斗', 'Duel'],
  jiedao: ['借刀杀人', 'Hack'],
  wuxie: ['无懈可击', 'Negate'],
  nanman: ['南蛮入侵', 'Barbar.'],
  wanjian: ['万箭齐发', 'Arrows'],
  taoyuan: ['桃园结义', 'Oath'],
  wugu: ['五谷丰登', 'Harvest'],
  huogong: ['火攻', 'Fire'],
  tiesuo: ['铁索连环', 'Chains'],
  lebusishu: ['乐不思蜀', 'Dance'],
  bingliang: ['兵粮寸断', 'Starve'],
  shandian: ['闪电', 'Storm'],
  zhengbing: ['征兵令', 'Recruit'],
};

export function itemShort(id: string, lang: Lang): string {
  const s = ITEM_SHORT[id];
  if (s) return lang === 'en' ? s[1] : s[0];
  const def = ITEM_BY_ID[id];
  if (!def) return id;
  return lang === 'en' ? shortEnglish(def.nameEn.replace(/\s*\(.*\)\s*/, '')) : def.nameZh;
}

export type TouchKey = 'fire' | 'ads' | 'jump' | 'dodge' | 'reload' | 'swap' | 'interact' | 'mark' | 'wheel' | 'chat' | 'map' | 'score' | 'menu';

/** Touch button labels: one glyph in Chinese, a short word in English. */
export const TOUCH_LABEL: Readonly<Record<TouchKey, readonly [string, string]>> = {
  fire: ['射', 'Fire'],
  ads: ['镜', 'Aim'],
  jump: ['跃', 'Jump'],
  dodge: ['闪', 'Roll'],
  reload: ['装', 'Reload'],
  swap: ['换', 'Swap'],
  interact: ['F', 'F'],
  mark: ['标', 'Mark'],
  wheel: ['令', 'Call'],
  chat: ['聊', 'Chat'],
  map: ['图', 'Map'],
  score: ['战', 'Score'],
  menu: ['☰', '☰'],
};

export function touchLabel(key: TouchKey, lang: Lang): string {
  const l = TOUCH_LABEL[key];
  return lang === 'en' ? l[1] : l[0];
}
