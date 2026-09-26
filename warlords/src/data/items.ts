// Items (三国杀 基本牌 / 锦囊牌 / 延时锦囊 as consumables), armors and mounts
// (docs/GAME_SPEC.md §7). Behaviour lives in sim/items/* keyed by id; every
// number the implementation needs is in `params` (units: m, s, HP).
//
// Conventions shared by all item implementations:
//  - "enemy" = any unit that is not on the user's own side (SimApi.isOwnSide false).
//  - `range`   = max throw / target distance (mirrors ItemDef.range).
//  - `radius`  = effect radius around the impact point / user.
//  - thrown items (`fuse`) are lobbed at the aim point (clamped to range); they stop at the first
//    wall / roof / unit on the way, lie there as a visible warning circle of `radius`, and go off
//    `fuse` s after the throw.
//  - traps (`armTime`, `lifetime`) are hidden hazards that spring once on the first enemy HERO
//    (standing, not immune to the trap's status) inside `radius`; enemy soldiers never trigger
//    them. Only the owner's side sees them; enemies spot them up close (design: 6 m — snapshots
//    currently use the 8 m stealth send range, see docs/SIM_REQUESTS.md).
//  - random items are rolled with rollLoot('reward', …) from data/loot.ts.
//  - `dtype` is the DamageType of every hit an item deals. Item damage is never a weapon hit
//    (no weaponId): bullet-only armor rules and 酒 don't apply to it.
//  - Everything here is implementable with SimApi (+ sim/ext.ts) alone: 决斗 and 借刀杀人 use
//    statuses, squad orders and sim.schedule() polling — no damage-pipeline hooks needed.
//  - "Not consumed on failure": an item that cannot do anything (no target, nothing to steal, nobody
//    hurt, squad full …) stays in its slot. An item cancelled by the target's 无懈可击 is spent.
import type { ArmorDef, ItemDef, MountDef } from './types';

export const ITEMS: ItemDef[] = [
  // ── 基本牌 Basic cards ────────────────────────────────────────────────────
  {
    id: 'sha',
    nameZh: '杀',
    nameEn: 'Strike (Ammo Box)',
    sgsCard: '杀',
    kind: 'ammo',
    descZh: '弹药箱：为两把武器补充 50% 最大备弹。',
    descEn: 'Ammo box: refills 50% of max reserve ammo for both weapons.',
    rarity: 'common',
    useTime: 0.6,
    targeting: 'self',
    range: 0,
    maxStack: 5,
    params: { reserveFrac: 0.5 },
    icon: '杀',
    color: '#d94a3a',
    aiHint: 'utility',
  },
  {
    id: 'shan',
    nameZh: '闪',
    nameEn: 'Dodge',
    sgsCard: '闪',
    kind: 'basic',
    descZh: '立即获得 1 次闪避（可超出上限，最多 3 次）。',
    descEn: 'Instantly gain 1 dodge charge (can exceed your normal max, up to 3).',
    rarity: 'common',
    useTime: 0,
    targeting: 'self',
    range: 0,
    maxStack: 3,
    params: { charges: 1, cap: 3 },
    icon: '闪',
    color: '#4a90d9',
    aiHint: 'defense',
  },
  {
    id: 'tao',
    nameZh: '桃',
    nameEn: 'Peach (Medkit)',
    sgsCard: '桃',
    kind: 'basic',
    descZh: '回复 120 生命；对濒死角色按住 F 1.5 秒可将其以 100 生命救起。',
    descEn: 'Restore 120 HP. Hold F on a downed hero for 1.5 s to revive them with 100 HP.',
    rarity: 'common',
    useTime: 1.2,
    targeting: 'self',
    range: 3,
    maxStack: 3,
    params: { heal: 120, reviveHp: 100, reviveTime: 1.5 },
    icon: '桃',
    color: '#ff7a8a',
    aiHint: 'heal',
  },
  {
    id: 'jiu',
    nameZh: '酒',
    nameEn: 'Wine',
    sgsCard: '酒',
    kind: 'basic',
    descZh: '8 秒内你的下一次武器命中伤害 ×2（技能与锦囊伤害不受影响）；濒死时可饮用，以 50 生命自救。',
    descEn: 'Your next weapon hit within 8 s deals ×2 (ability and item damage are unaffected). While downed, drink it to revive with 50 HP.',
    rarity: 'rare',
    useTime: 0.5,
    targeting: 'self',
    range: 0,
    maxStack: 2,
    // weaponOnly=1: the 'drunk' status (params { mul, weaponOnly }) is applied and consumed only by
    // hits with a weaponId — abilities never get ×2 (see heroes.ts "Burst"; CONTRACT_CHANGES).
    params: { mul: 2, duration: 8, reviveHp: 50, weaponOnly: 1 },
    icon: '酒',
    color: '#b5651d',
    aiHint: 'offense',
  },

  // ── 锦囊 Tricks ───────────────────────────────────────────────────────────
  {
    id: 'wuzhong',
    nameZh: '无中生有',
    nameEn: 'Something from Nothing',
    sgsCard: '无中生有',
    kind: 'trick',
    descZh: '立即获得 2 个随机锦囊。',
    descEn: 'Instantly gain 2 random items.',
    rarity: 'rare',
    useTime: 0.5,
    targeting: 'self',
    range: 0,
    maxStack: 2,
    params: { count: 2 },
    icon: '无',
    color: '#e8b64a',
    aiHint: 'utility',
  },
  {
    id: 'guohe',
    nameZh: '过河拆桥',
    nameEn: 'Dismantle (EMP Grenade)',
    sgsCard: '过河拆桥',
    kind: 'trick',
    descZh: '投掷电磁手雷（1.2 秒后于 4 米内生效）：敌人的护甲与坐骑被震落到 2.5 米外（本人 5 秒内无法拾回），护盾清空。',
    descEn: 'Throw an EMP grenade (4 m, 1.2 s fuse): enemies lose all shield, and their armor and mount are knocked 2.5 m away (they cannot pick them back up for 5 s).',
    rarity: 'rare',
    useTime: 0,
    targeting: 'point',
    range: 25,
    maxStack: 2,
    // impl: gear is flung `scatter` m away from the blast (pulled in by walls) as loot locked for its
    //   former wearer for `dropLock` s (anyone else may grab it at once); 白银狮子 still heals on removal.
    params: { range: 25, radius: 4, fuse: 1.2, scatter: 2.5, dropLock: 5 },
    icon: '拆',
    color: '#6a8ad0',
    aiHint: 'offense',
  },
  {
    id: 'shunshou',
    nameZh: '顺手牵羊',
    nameEn: 'Steal (Grapple)',
    sgsCard: '顺手牵羊',
    kind: 'trick',
    descZh: '用钩索从 8 米内的敌方武将处偷取 1 个随机锦囊或装备。',
    descEn: 'Grapple-steal 1 random item or piece of equipment from an enemy hero within 8 m.',
    rarity: 'rare',
    useTime: 0,
    targeting: 'enemy',
    range: 8,
    maxStack: 2,
    params: { range: 8, count: 1, includeEquipment: 1 },
    icon: '顺',
    color: '#9a7ad0',
    aiHint: 'offense',
  },
  {
    id: 'juedou',
    nameZh: '决斗',
    nameEn: 'Duel',
    sgsCard: '决斗',
    kind: 'trick',
    descZh: '与 20 米内敌方武将决斗 8 秒，双方士兵集火对方；结束（或相距超过 35 米）时，期间失血较多的一方再受 80 伤害。',
    descEn: "Duel an enemy hero within 20 m for 8 s; each side's soldiers focus the other. When it ends (or you're 35 m+ apart), whoever lost more HP meanwhile takes 80 damage.",
    rarity: 'rare',
    useTime: 0,
    targeting: 'enemy',
    range: 20,
    maxStack: 1,
    // impl (SimApi only): the target's 无懈可击 refuses the duel (item spent; 'marked' itself is an
    //   information status and never consumes it, so the gate is checked explicitly). Otherwise
    //   applyStatus(target, 'marked', duration, { sourceId: user }) and applyStatus(user, 'marked',
    //   duration, { sourceId: target }) — each side's troops focus the other. One duel per user at a
    //   time. Record hp + shield of both at start; sim.schedule() a check every pollEvery s: the duel
    //   ends at `duration`, when either is downed/dead, or when they are more than breakDist apart.
    //   HP lost = start − now (downed/dead = everything). The one that lost more takes loserDamage
    //   (dtype, canDodge false, sourceId = the other duelist) unless it already fell; a tie punishes nobody.
    params: { range: 20, duration: 8, breakDist: 35, pollEvery: 0.5, loserDamage: 80 },
    dtype: 'normal',
    icon: '斗',
    color: '#c0392b',
    aiHint: 'offense',
  },
  {
    id: 'jiedao',
    nameZh: '借刀杀人',
    nameEn: 'Borrowed Blade (Hack)',
    sgsCard: '借刀杀人',
    kind: 'trick',
    descZh: '入侵 40 米内敌方武将的士兵与炮台：6 秒内它们围攻离其主人最近的另一名武将（不会是你）；对方无兵或附近无人时无法使用。',
    descEn: "Hack an enemy hero's soldiers and turrets (40 m): for 6 s they attack the hero nearest their commander (never you). Fails if they have none, or nobody is near.",
    rarity: 'epic',
    useTime: 0.5,
    targeting: 'enemy',
    range: 40,
    maxStack: 1,
    // impl (SimApi only): aiming at a soldier / turret hacks its commander. x = nearest standing hero
    //   ≠ target, ≠ user within searchRadius of the target; none (or no living soldier / turret) ⇒
    //   use() returns false (not consumed). 无懈可击 on the target cancels it (spent). Otherwise
    //   sim.setSquadOrder(target, { kind: 'attack', targetId: x }) re-applied every pollEvery s via
    //   sim.schedule() for `duration` (x re-picked if it falls or leaves), then the previous order.
    //   (A commander's own troops can never damage him — combat credit rule — so they turn on x instead.)
    params: { range: 40, duration: 6, searchRadius: 40, pollEvery: 0.5 },
    icon: '借',
    color: '#7a4ab0',
    aiHint: 'offense',
  },
  {
    id: 'wuxie',
    nameZh: '无懈可击',
    nameEn: 'Impeccable',
    sgsCard: '无懈可击',
    kind: 'trick',
    descZh: '20 秒内，下一个针对你的负面状态或技能效果被抵消。',
    descEn: 'For 20 s, the next hostile status or ability effect aimed at you is cancelled.',
    rarity: 'rare',
    useTime: 0,
    targeting: 'self',
    range: 0,
    maxStack: 2,
    params: { duration: 20 },
    icon: '懈',
    color: '#f0e0a0',
    aiHint: 'defense',
  },
  {
    id: 'nanman',
    nameZh: '南蛮入侵',
    nameEn: 'Barbarian Invasion',
    sgsCard: '南蛮入侵',
    kind: 'trick',
    descZh: '召唤 5 名南蛮勇士冲向准星处（20 秒），它们攻击除你和你的士兵以外的所有人。',
    descEn: 'Summon 5 barbarian warriors (20 s) that rush the aim point and attack everyone but you and your soldiers.',
    rarity: 'epic',
    useTime: 0.5,
    targeting: 'point',
    range: 50,
    maxStack: 1,
    params: { range: 50, count: 5, lifetime: 20 },
    icon: '蛮',
    color: '#8a5a2a',
    aiHint: 'summon',
  },
  {
    id: 'wanjian',
    nameZh: '万箭齐发',
    nameEn: 'Arrow Barrage',
    sgsCard: '万箭齐发',
    kind: 'trick',
    descZh: '0.8 秒后，准星处 8 米范围箭如雨下 3 秒：每 0.5 秒造成 18 伤害。',
    descEn: 'After 0.8 s, arrows rain on an 8 m area at the aim point for 3 s: 18 damage every 0.5 s.',
    rarity: 'epic',
    useTime: 0,
    targeting: 'point',
    range: 60,
    maxStack: 1,
    params: { range: 60, radius: 8, delay: 0.8, duration: 3, tickEvery: 0.5, damage: 18 },
    dtype: 'normal',
    icon: '箭',
    color: '#a0a060',
    aiHint: 'offense',
  },
  {
    id: 'taoyuan',
    nameZh: '桃园结义',
    nameEn: 'Peach Garden Oath',
    sgsCard: '桃园结义',
    kind: 'trick',
    descZh: '为 15 米内所有武将（包括敌人）与士兵回复 80 生命。',
    descEn: 'Heal every hero (enemies included) and soldier within 15 m for 80.',
    rarity: 'rare',
    useTime: 1,
    targeting: 'self',
    range: 0,
    maxStack: 1,
    params: { radius: 15, heal: 80 },
    icon: '园',
    color: '#ff9ab0',
    aiHint: 'heal',
  },
  {
    id: 'wugu',
    nameZh: '五谷丰登',
    nameEn: 'Bountiful Harvest',
    sgsCard: '五谷丰登',
    kind: 'trick',
    descZh: '在身边 3 米内撒出 4 个随机锦囊，先到先得。',
    descEn: 'Burst 4 random items onto the ground within 3 m of you — first come, first served.',
    rarity: 'rare',
    useTime: 0.5,
    targeting: 'self',
    range: 0,
    maxStack: 1,
    params: { count: 4, scatter: 3 },
    icon: '谷',
    color: '#d8b040',
    aiHint: 'utility',
  },
  {
    id: 'huogong',
    nameZh: '火攻',
    nameEn: 'Fire Attack (Incendiary)',
    sgsCard: '火攻',
    kind: 'trick',
    descZh: '投掷燃烧弹（1.5 秒后爆炸）：4 米内 40 火焰伤害并点燃，留下火海 6 秒（每秒 15）。',
    descEn: 'Throw an incendiary (1.5 s fuse): 40 fire damage in 4 m and ignites, leaving a fire field for 6 s (15/s).',
    rarity: 'common',
    useTime: 0,
    targeting: 'point',
    range: 30,
    maxStack: 3,
    params: { range: 30, radius: 4, fuse: 1.5, damage: 40, burnDps: 10, burnTime: 3, fieldTime: 6, fieldDps: 15 },
    dtype: 'fire',
    icon: '火',
    color: '#ff6a2a',
    aiHint: 'offense',
  },
  {
    id: 'tiesuo',
    nameZh: '铁索连环',
    nameEn: 'Iron Chains',
    sgsCard: '铁索连环',
    kind: 'trick',
    descZh: '锁住准星处 6 米内至多 3 个敌人 10 秒：火焰与雷电伤害在被锁者之间传导。',
    descEn: 'Chain up to 3 enemies within 6 m of the aim point for 10 s: fire and thunder damage spreads between them.',
    rarity: 'common',
    useTime: 0,
    targeting: 'point',
    range: 30,
    maxStack: 3,
    params: { range: 30, radius: 6, maxTargets: 3, duration: 10 },
    icon: '锁',
    color: '#8a8a9a',
    aiHint: 'offense',
  },

  // ── 延时锦囊 Delayed tricks (deployables) ───────────────────────────────────
  {
    id: 'lebusishu',
    nameZh: '乐不思蜀',
    nameEn: 'Indulgence (Trap)',
    sgsCard: '乐不思蜀',
    kind: 'delayTrick',
    descZh: '布置隐蔽陷阱（敌人靠近才能发现；1 秒后生效，存在 60 秒）：首个踏入的敌方武将跳舞 3 秒，无法射击与使用技能。',
    descEn: 'Place a hidden trap (enemies only spot it up close; arms in 1 s, lasts 60 s): the first enemy hero to step in dances for 3 s, unable to shoot or use abilities.',
    rarity: 'rare',
    useTime: 0.5,
    // 'self', not 'point': the public itemUse event must not carry the hidden trap's spot (ITEMS-3);
    //   use() lays it at the crosshair (≤ range), or where the bot's botShouldUse decided.
    targeting: 'self',
    range: 8,
    maxStack: 2,
    params: { range: 8, radius: 2.5, armTime: 1, lifetime: 60, duration: 3 },
    icon: '乐',
    color: '#e070b0',
    // 'utility': the bot planner defers to botShouldUse (charging foes, retreats, doorways, airdrops)
    aiHint: 'utility',
  },
  {
    id: 'bingliang',
    nameZh: '兵粮寸断',
    nameEn: 'Supply Shortage (Trap)',
    sgsCard: '兵粮寸断',
    kind: 'delayTrick',
    descZh: '布置隐蔽陷阱（敌人靠近才能发现；1 秒后生效，存在 60 秒）：首个踏入的敌方武将定身 2.5 秒并失去 50% 备弹。',
    descEn: 'Place a hidden trap (enemies only spot it up close; arms in 1 s, lasts 60 s): the first enemy hero to step in is rooted 2.5 s and loses 50% reserve ammo.',
    rarity: 'rare',
    useTime: 0.5,
    // 'self', not 'point': the public itemUse event must not carry the hidden trap's spot (ITEMS-3);
    //   use() lays it at the crosshair (≤ range), or where the bot's botShouldUse decided.
    targeting: 'self',
    range: 8,
    maxStack: 2,
    params: { range: 8, radius: 2.5, armTime: 1, lifetime: 60, rootTime: 2.5, reserveLoss: 0.5 },
    icon: '粮',
    color: '#a08040',
    // 'utility': the bot planner defers to botShouldUse (charging foes, retreats, doorways, airdrops)
    aiHint: 'utility',
  },
  {
    id: 'shandian',
    nameZh: '闪电',
    nameEn: 'Lightning (Storm Cloud)',
    sgsCard: '闪电',
    kind: 'delayTrick',
    descZh: '在准星处召出雷云（18 秒）：以 3.5 米/秒飘向最近的武将（可能是你！），每 3 秒对其下方 3 米内所有人劈下 70 雷电伤害。',
    descEn: 'Summon a storm cloud (18 s) that drifts at 3.5 m/s toward the nearest hero — maybe you! — striking everyone within 3 m below it for 70 thunder every 3 s.',
    rarity: 'epic',
    useTime: 0.5,
    targeting: 'point',
    range: 15,
    maxStack: 1,
    // impl: "nearest hero" = nearest standing hero whose position is public — heroes in stealth (not revealed to
    //   everyone) and downed heroes are skipped, so the public cloud never tracks an invisible hero. It rides at its
    //   quarry's level (roof / deck / floor) and a bolt only reaches units within 2.5 m of that height.
    params: { range: 15, lifetime: 18, speed: 3.5, strikeEvery: 3, damage: 70, radius: 3 },
    dtype: 'thunder',
    icon: '电',
    color: '#8ad0ff',
    aiHint: 'offense',
  },

  // ── Utility ───────────────────────────────────────────────────────────────
  {
    id: 'zhengbing',
    nameZh: '征兵令',
    nameEn: 'Conscription Order',
    sgsCard: '',
    kind: 'utility',
    descZh: '引导 1.5 秒，征召 2 名本国士兵（最多超出带兵上限 2 名）。',
    descEn: 'Channel 1.5 s to recruit 2 soldiers of your kingdom (up to 2 over your squad cap).',
    rarity: 'rare',
    useTime: 1.5,
    targeting: 'self',
    range: 0,
    maxStack: 2,
    params: { count: 2, overCap: 2 },
    icon: '兵',
    color: '#c9a227',
    aiHint: 'summon',
  },
];

// ── Armor (防具) ─────────────────────────────────────────────────────────────
/**
 * Max total chance to evade a dodgeable bullet. Sources (八卦 chance, 'dodgeChance' statuses such
 * as 八阵图, 甄姬 倾国) combine as 1 − Π(1 − pᵢ) and the result is capped here (SIM-CORE combat).
 */
export const BULLET_EVASION_CAP = 0.5;

// bulletReduction applies to damage type 'normal' only. `special` semantics:
//  bagua    chance: probability to fully evade a dodgeable bullet (ignored by undodgeable).
//  renwang  frontArc: degrees in front of the wearer; mul: bullet damage multiplier from that arc.
//  tengjia  fireMul: fire damage multiplier; troopImmune=1: immune to troop/NPC/turret bullets.
//  baiyin   cap: max damage from any single hit (any type except zone and 'true' HP loss; like
//           every armor it is bypassed by armor-piercing hits — 青釭剑, 'pierce');
//           healOnRemove: heal when the armor is removed, swapped, stripped or stolen.
export const ARMORS: ArmorDef[] = [
  {
    id: 'bagua',
    nameZh: '八卦阵',
    nameEn: 'Bagua Deflector',
    sgsCard: '八卦阵',
    descZh: '偏导力场：每颗子弹有 35% 几率被完全闪避。',
    descEn: 'Deflector field: each incoming bullet has a 35% chance to be completely evaded.',
    rarity: 'rare',
    bulletReduction: 0,
    special: 'bagua',
    params: { chance: 0.35 },
    color: '#e8d27a',
  },
  {
    id: 'renwang',
    nameZh: '仁王盾',
    nameEn: 'Benevolent King Shield',
    sgsCard: '仁王盾',
    descZh: '前置防弹盾：来自正面 90° 的子弹伤害 -70%。',
    descEn: 'Front ballistic shield: bullet damage from your front 90° is reduced by 70%.',
    rarity: 'rare',
    bulletReduction: 0,
    special: 'renwang',
    params: { frontArc: 90, mul: 0.3 },
    color: '#b0b8c8',
  },
  {
    id: 'tengjia',
    nameZh: '藤甲',
    nameEn: 'Rattan Armor',
    sgsCard: '藤甲',
    descZh: '子弹伤害 -40%，免疫士兵、NPC 与炮台的子弹；但受到的火焰伤害 ×2。',
    descEn: 'Bullet damage -40% and immune to soldier, NPC and turret bullets — but fire damage taken ×2.',
    rarity: 'rare',
    bulletReduction: 0.4,
    special: 'tengjia',
    params: { fireMul: 2, troopImmune: 1 },
    color: '#a07a3a',
  },
  {
    id: 'baiyin',
    nameZh: '白银狮子',
    nameEn: 'Silver Lion',
    sgsCard: '白银狮子',
    descZh: '任何单次伤害最多 60 点；被卸下、拆除或偷走时回复 100 生命。',
    descEn: 'No single hit can deal more than 60 damage. When removed, stripped or stolen, heal 100 HP.',
    rarity: 'epic',
    bulletReduction: 0,
    special: 'baiyin',
    params: { cap: 60, healOnRemove: 100 },
    color: '#d8dce8',
  },
];

// ── Mounts (坐骑) ────────────────────────────────────────────────────────────
// -1 马 (offense) = pure speed; +1 马 (defense) = some speed + damage reduction.
// Mounted heroes can be dismounted by 麒麟弓 / 过河拆桥 / 奇袭 (the mount drops as loot).
export const MOUNTS: MountDef[] = [
  {
    id: 'chitu',
    nameZh: '赤兔',
    nameEn: 'Red Hare',
    sgsCard: '赤兔',
    descZh: '-1 马：移动速度 +40%。人中吕布，马中赤兔。',
    descEn: 'Offensive mount: +40% move speed. "Among men, Lü Bu; among horses, Red Hare."',
    rarity: 'epic',
    type: 'offense',
    speedMul: 1.4,
    damageTakenMul: 1.0,
    color: '#b3261e',
  },
  {
    id: 'dawan',
    nameZh: '大宛',
    nameEn: 'Ferghana Steed',
    sgsCard: '大宛',
    descZh: '-1 马：移动速度 +35%。',
    descEn: 'Offensive mount: +35% move speed.',
    rarity: 'rare',
    type: 'offense',
    speedMul: 1.35,
    damageTakenMul: 1.0,
    color: '#c89a5a',
  },
  {
    id: 'zixing',
    nameZh: '紫骍',
    nameEn: 'Purple Stallion',
    sgsCard: '紫骍',
    descZh: '-1 马：移动速度 +30%。',
    descEn: 'Offensive mount: +30% move speed.',
    rarity: 'common',
    type: 'offense',
    speedMul: 1.3,
    damageTakenMul: 1.0,
    color: '#7a4a8a',
  },
  {
    id: 'dilu',
    nameZh: '的卢',
    nameEn: 'Dilu',
    sgsCard: '的卢',
    descZh: '+1 马：移动速度 +18%，受到伤害 -12%。',
    descEn: 'Defensive mount: +18% move speed, 12% less damage taken.',
    rarity: 'rare',
    type: 'defense',
    speedMul: 1.18,
    damageTakenMul: 0.88,
    color: '#e8e0d0',
  },
  {
    id: 'jueying',
    nameZh: '绝影',
    nameEn: 'Shadowrunner',
    sgsCard: '绝影',
    descZh: '+1 马：移动速度 +12%，受到伤害 -18%。',
    descEn: 'Defensive mount: +12% move speed, 18% less damage taken.',
    rarity: 'rare',
    type: 'defense',
    speedMul: 1.12,
    damageTakenMul: 0.82,
    color: '#2a2a30',
  },
  {
    id: 'zhuahuang',
    nameZh: '爪黄飞电',
    nameEn: 'Flying Lightning',
    sgsCard: '爪黄飞电',
    descZh: '+1 马：移动速度 +18%，受到伤害 -18%。',
    descEn: 'Defensive mount: +18% move speed, 18% less damage taken.',
    rarity: 'epic',
    type: 'defense',
    speedMul: 1.18,
    damageTakenMul: 0.82,
    color: '#f0f0f0',
  },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const ARMOR_BY_ID: Record<string, ArmorDef> = Object.fromEntries(ARMORS.map((a) => [a.id, a]));
export const MOUNT_BY_ID: Record<string, MountDef> = Object.fromEntries(MOUNTS.map((m) => [m.id, m]));
