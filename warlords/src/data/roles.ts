import type { GameMode, RoleId } from '../core/types';
import type { RoleDef, RoleDistribution } from './types';

export const ROLES: RoleDef[] = [
  {
    id: 'lord',
    nameZh: '主公',
    nameEn: 'Lord',
    faction: 'lord',
    color: '#e8b64a',
    publicAtStart: true,
    goalZh: '消灭所有反贼和内奸。',
    goalEn: 'Eliminate every Rebel and the Traitor.',
    tipsZh: '身份公开、体力+100、兵力+2。先分辨谁是忠臣——误杀忠臣会失去全部锦囊与装备。',
    tipsEn: 'Public role, +100 HP, +2 troops. Work out who is loyal — killing a Loyalist makes you drop all items and gear.',
    chaosOnly: false,
  },
  {
    id: 'loyalist',
    nameZh: '忠臣',
    nameEn: 'Loyalist',
    faction: 'lord',
    color: '#e0c060',
    publicAtStart: false,
    goalZh: '保护主公，消灭所有反贼和内奸。',
    goalEn: 'Protect the Lord; eliminate every Rebel and the Traitor.',
    tipsZh: '主公不知道你是谁。用行动“跳忠”：替主公挡枪、集火打主公的人。',
    tipsEn: 'The Lord does not know you. Prove loyalty with actions: shield the Lord and focus whoever shoots them.',
    chaosOnly: false,
  },
  {
    id: 'rebel',
    nameZh: '反贼',
    nameEn: 'Rebel',
    faction: 'rebel',
    color: '#d94a3a',
    publicAtStart: false,
    goalZh: '击杀主公。',
    goalEn: 'Kill the Lord.',
    tipsZh: '你不知道谁是同伙。击杀反贼的人会获得 3 个锦囊奖励，别白白送死。',
    tipsEn: 'You do not know your fellow rebels. Whoever kills a Rebel is rewarded with 3 items — do not feed.',
    chaosOnly: false,
  },
  {
    id: 'traitor',
    nameZh: '内奸',
    nameEn: 'Traitor',
    faction: 'traitor',
    color: '#5aa0e0',
    publicAtStart: false,
    goalZh: '成为最后的幸存者：先除掉其他所有人，最后单挑击杀主公。',
    goalEn: 'Be the last one standing: remove everyone else, then defeat the Lord last.',
    tipsZh: '帮弱势一方维持平衡。主公若在你之外还有人存活时死亡，则反贼获胜。',
    tipsEn: 'Keep the sides balanced. If the Lord dies while anyone besides you is alive, the Rebels win.',
    chaosOnly: false,
  },
  {
    id: 'double',
    nameZh: '影武者',
    nameEn: 'Body Double',
    faction: 'lord',
    color: '#c9a3ff',
    publicAtStart: true, // shown to others as a second Lord (crown) — the disguise
    goalZh: '主公阵营：伪装成主公吸引火力，消灭反贼和内奸。',
    goalEn: 'Lord side: pose as a second Lord to draw fire; eliminate Rebels and the Traitor.',
    tipsZh: '所有人都看到两顶王冠，只有真主公知道你是替身。你没有主公技——别被识破。',
    tipsEn: 'Everyone sees two crowns; only the real Lord knows you are the decoy. You have no lord skill — do not get caught.',
    chaosOnly: true,
  },
  {
    id: 'opportunist',
    nameZh: '墙头草',
    nameEn: 'Opportunist',
    faction: 'neutral',
    color: '#8fd16a',
    publicAtStart: false,
    goalZh: '活到最后：无论哪一方获胜，只要你还活着就一起获胜。',
    goalEn: 'Survive: whichever side wins, you win too if you are still alive.',
    tipsZh: '两边讨好、见风使舵。你的死亡不影响任何一方的胜负。',
    tipsEn: 'Play both sides. Your death does not affect anyone else’s victory.',
    chaosOnly: true,
  },
  {
    id: 'bounty',
    nameZh: '赏金猎人',
    nameEn: 'Bounty Hunter',
    faction: 'neutral',
    color: '#ff8a3d',
    publicAtStart: false,
    goalZh: '亲手击杀你的秘密目标并活到最后，即可额外获胜。',
    goalEn: 'Personally kill your secret target and survive to the end for a bonus victory.',
    tipsZh: '目标被别人击杀时你会得到新目标。击杀目标奖励 2 个稀有锦囊。',
    tipsEn: 'If someone else kills your target you receive a new one. Each bounty pays out 2 rare items.',
    chaosOnly: true,
  },
];

export const ROLE_BY_ID: Record<RoleId, RoleDef> = Object.fromEntries(ROLES.map((r) => [r.id, r])) as Record<RoleId, RoleDef>;

/** Index 0 is always the lord seat. Standard = official 三国杀 身份局 counts. */
export const ROLE_DISTRIBUTION: Record<GameMode, RoleDistribution> = {
  standard: {
    5: [['lord', 'loyalist', 'rebel', 'rebel', 'traitor']],
    6: [['lord', 'loyalist', 'rebel', 'rebel', 'rebel', 'traitor']],
    7: [['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'traitor']],
    8: [['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor']],
  },
  // 乱世模式: one random variant per count, each swaps in fun roles and keeps the 内奸. Every variant
  // deals at least as many rebels as lord-side seats (lord + loyalists + 影武者): the crowns carry
  // +100 HP / +2 soldiers each, and a table of 1 rebel against 2 lord-side seats / 2 rebels against 3
  // was a lord-side walkover (G4 balance: 乱世 rebels won ~21 %; 8 % / 12 % / 21 % on those three
  // variants, 0 of 11 on the 6-seat loyalist + bounty table).
  chaos: {
    5: [
      ['lord', 'double', 'rebel', 'rebel', 'traitor'],
      ['lord', 'opportunist', 'rebel', 'rebel', 'traitor'],
    ],
    6: [
      ['lord', 'double', 'rebel', 'rebel', 'opportunist', 'traitor'],
      ['lord', 'double', 'rebel', 'rebel', 'rebel', 'traitor'],
    ],
    7: [
      ['lord', 'double', 'rebel', 'rebel', 'rebel', 'bounty', 'traitor'],
      ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'rebel', 'traitor'],
    ],
    8: [
      ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'rebel', 'bounty', 'traitor'],
      ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'rebel', 'opportunist', 'traitor'],
    ],
  },
};
