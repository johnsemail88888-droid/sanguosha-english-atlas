// 玩法说明: roles & win conditions, dying & rewards, zone, squads, controls,
// and cards / gear / weapons tables generated from the data files.
import type { RoleId } from '../../core/types';
import type { ItemKind } from '../../data/types';
import { ARMORS, ITEMS, ITEM_KIND_INFO, MOUNTS, ROLES, ROLE_DISTRIBUTION, TROOPS, WEAPONS } from '../../data';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, type Child } from '../dom';
import { colon, kingdomName, t, tx, type I18nKey } from '../i18n';
import { ORDER_KEYS, RARITY_COLOR, roleInk } from '../theme';
import { button, keyCap, roleSeal, tabs } from '../widgets';
import { weaponClassName } from './heroDetail';
import { ZONE_PHASES } from '../../sim/zone';

type HelpTab = 'roles' | 'rules' | 'zone' | 'squad' | 'controls' | 'items' | 'gear' | 'weapons';

/** Zone schedule (GAME_SPEC §4), generated from the sim's phase table so it never drifts. */
export const ZONE_TABLE: readonly { phase: number; wait: number; shrink: number; radius: number; dps: number }[] = ZONE_PHASES.map((z, phase) => ({
  phase,
  wait: z.wait,
  shrink: z.shrink,
  radius: z.radius,
  dps: z.dps,
}));

export const CONTROLS: readonly { keys: string[]; zh: string; en: string }[] = [
  { keys: ['W', 'A', 'S', 'D'], zh: '移动（鼠标瞄准，点击锁定鼠标）', en: 'Move (mouse aims; click to lock the pointer)' },
  { keys: ['左键'], zh: '开火', en: 'Fire' },
  { keys: ['右键'], zh: '开镜瞄准', en: 'Aim down sights' },
  { keys: ['R'], zh: '换弹', en: 'Reload' },
  { keys: ['Shift'], zh: '冲刺', en: 'Sprint' },
  { keys: ['Space'], zh: '跳跃', en: 'Jump' },
  { keys: ['Ctrl', 'Alt'], zh: '闪避翻滚（闪）· 2 次充能，8 秒恢复', en: 'Dodge roll (闪) · 2 charges, 8 s recharge' },
  { keys: ['Q', 'E'], zh: '武将技能', en: 'Hero abilities' },
  { keys: ['G'], zh: '主公技（仅主公）', en: 'Lord skill (Lord only)' },
  { keys: ['F'], zh: '拾取 / 打开锦囊 / 按住救援', en: 'Pick up / open chest / hold to revive' },
  { keys: ['1', '2'], zh: '切换主 / 副武器（或滚轮）', en: 'Primary / secondary weapon (or wheel)' },
  { keys: ['4', '5', '6', '7'], zh: '使用锦囊栏', en: 'Use item slots' },
  { keys: ['Z', 'X', 'C', 'V'], zh: '部曲：跟随 / 驻守 / 进攻 / 冲锋', en: 'Squad: follow / hold / attack / charge' },
  { keys: ['B', '中键'], zh: '标记准星处目标', en: 'Mark the target under the crosshair' },
  { keys: ['T'], zh: '跳身份 & 快捷喊话轮盘', en: 'Claim & quick-chat wheel' },
  { keys: ['Tab'], zh: '战况（按住）', en: 'Scoreboard (hold)' },
  { keys: ['M'], zh: '战场地图', en: 'Battle map' },
  { keys: ['Enter'], zh: '聊天', en: 'Chat' },
  { keys: ['Esc'], zh: '菜单（单机自动暂停，联机不暂停）', en: 'Menu (pauses single player; online matches keep running)' },
];

const KIND_NAMES: Record<ItemKind, [string, string]> = {
  basic: ['基本牌', 'Basic'],
  trick: ['锦囊牌', 'Trick'],
  delayTrick: ['延时锦囊', 'Delayed trick'],
  ammo: ['弹药', 'Ammo'],
  utility: ['道具', 'Utility'],
};

function itemKindName(k: ItemKind): string {
  const d = ITEM_KIND_INFO?.[k];
  if (d) return tx(d.nameZh, d.nameEn);
  const n = KIND_NAMES[k];
  return n ? tx(n[0], n[1]) : k;
}

function keyLabel(k: string): string {
  if (k === '左键') return tx('左键', 'LMB');
  if (k === '右键') return tx('右键', 'RMB');
  if (k === '中键') return tx('中键', 'MMB');
  return k;
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'help-sec' }, h('h2', { class: 'sg-h2' }, title), ...children);
}

function para(zh: string, en: string): HTMLElement {
  return h('p', null, tx(zh, en));
}

function rolesTab(): HTMLElement {
  const cards = ROLES.map((r) =>
    h('div', { class: 'role-row' },
      roleSeal(r.id, '2.6em'),
      h('div', null,
        h('div', { class: 'rr-head' }, h('b', { style: `color:${roleInk(r.id)}` }, tx(r.nameZh, r.nameEn)), r.chaosOnly ? h('span', { class: 'sg-chip' }, t('single.modeChaos')) : null, r.publicAtStart ? h('span', { class: 'sg-chip' }, tx('公开', 'Public')) : null),
        h('div', null, h('b', null, `${t('roles.goal')}${colon()}`), tx(r.goalZh, r.goalEn)),
        h('div', { class: 'sg-mute' }, tx(r.tipsZh, r.tipsEn)),
      ),
    ),
  );
  const seals = (roles: RoleId[]): HTMLElement => h('span', { class: 'seal-row' }, roles.map((r) => roleSeal(r, '1.5em')));
  const dist = h('table', { class: 'sg-table' },
    h('thead', null, h('tr', null, h('th', null, t('single.players')), h('th', null, t('single.modeStandard')), h('th', null, t('single.modeChaos')))),
    h('tbody', null, ([5, 6, 7, 8] as const).map((n) =>
      h('tr', null,
        h('td', { class: 'num' }, String(n)),
        h('td', null, ROLE_DISTRIBUTION.standard[n].map(seals)),
        h('td', null, h('div', { class: 'variants' }, ROLE_DISTRIBUTION.chaos[n].map(seals))),
      ),
    )),
  );
  return h('div', null,
    section(tx('身份与胜负', 'Roles & victory'),
      para('每位玩家只知道自己的身份，只有主公是公开的。阵亡时身份会向所有人揭晓。', 'Each player knows only their own role; only the Lord is public. A role is revealed to everyone on death.'),
      h('div', { class: 'role-list' }, cards),
    ),
    section(tx('身份分配', 'Role distribution'), h('div', { class: 'sg-table-wrap' }, dist),
      para('乱世模式每局随机抽取一种分配方案。中立身份不会阻止或导致其他阵营的胜利。', 'Chaos mode deals one random variant per match. Neutral roles never block or cause another side’s victory.'),
    ),
    section(tx('胜利条件', 'Win conditions'),
      h('ul', null,
        h('li', null, tx('主公阵亡：若场上只剩内奸（中立除外）⇒ 内奸胜；否则 ⇒ 反贼胜（即使反贼已全部阵亡）。', 'Lord dies: if the only living non-neutral hero is the Traitor ⇒ Traitor wins; otherwise ⇒ Rebels win (even if every rebel is dead).')),
        h('li', null, tx('主公存活且反贼与内奸全部阵亡 ⇒ 主公与忠臣（及影武者）胜。', 'All Rebels and the Traitor dead while the Lord lives ⇒ Lord + Loyalists (+ Double) win.')),
        h('li', null, tx('所有人同时阵亡 ⇒ 平局。15:00 时最后一圈烽火圈收缩至 0。', 'Everyone dead at once ⇒ draw. At 15:00 the final zone collapses to 0.')),
      ),
    ),
  );
}

function rulesTab(): HTMLElement {
  return h('div', null,
    section(tx('体力与濒死', 'Health & dying'),
      h('ul', null,
        h('li', null, tx('体力 = 三国杀体力 × 100（3 勾玉 → 300）。主公（及影武者）体力 +100。没有自然回复。', 'HP = 三国杀 HP × 100 (3 → 300). The Lord (and Double) get +100. No passive regeneration.')),
        h('li', null, tx('体力归零进入濒死：12 秒失血倒计时，只能以 25% 速度爬行，不能开火。', 'At 0 HP you are downed: 12 s bleed-out, crawling at 25% speed, unable to shoot.')),
        h('li', null, tx('任何人可按住 F 用「桃」救起濒死者（1.5 秒，回复 100 体力）；濒死者可饮「酒」自救（50 体力）。', 'Anyone can hold F with a Peach to revive (1.5 s → 100 HP); the downed hero may drink Wine to rise (50 HP).')),
        h('li', null, tx('阵亡后身份公开，你可以观战；你的部曲会溃散。', 'On death your role is revealed and you spectate; your squad disbands.')),
      ),
    ),
    section(tx('奖惩', 'Rewards & penalties'),
      h('ul', null,
        h('li', null, tx('击杀反贼者获得 3 个随机锦囊。', 'Whoever kills a Rebel draws 3 random items.')),
        h('li', null, tx('主公击杀忠臣或影武者：主公丢弃所有锦囊、防具、坐骑和副武器。', 'If the Lord kills a Loyalist or the Double, the Lord drops every item, armor, mount and the secondary weapon.')),
        h('li', null, tx('友军伤害开启——这是身份局。你自己的部曲与炮台不会伤害你。', 'Friendly fire is ON — it is an identity game. Your own troops and turrets never hurt you.')),
      ),
    ),
    section(tx('跳身份', 'Claims'),
      para('按 T 可公开宣称身份（我是忠臣 / 反贼 / 内奸）或快捷喊话。宣称会显示在名牌与战况中——谎言是允许的，AI 也会撒谎。', 'Press T to publicly claim a role (Loyalist / Rebel / Traitor) or send quick chat. Claims show on nameplates and the scoreboard — lies are allowed, and bots lie too.'),
    ),
    section(tx('锦囊与空投', 'Loot & airdrops'),
      para('木锦囊（1–2 件）遍布各地，铜锦囊（2–3 件，含稀有武器）位于营地和重要建筑。2:00 起每 100 秒会有天降锦囊，12 秒后落地，内含传说级武器。', 'Wooden chests (1–2 items) are everywhere; bronze chests (2–3 items incl. rare weapons) sit in camps and key buildings. From 2:00 an airdrop falls every 100 s, landing after 12 s with a legendary weapon.'),
    ),
  );
}

function zoneTab(): HTMLElement {
  return h('div', null,
    section(t('help.tab.zone'),
      para('烽火圈会分阶段收缩，圈外每秒受到无视护甲与闪避的伤害（部曲与 NPC 同样受伤）。下一圈的圆心随机但一定在当前圈内。', 'The zone shrinks in phases; outside it you take damage every second that ignores armor and dodge (troops and NPCs too). The next centre is random but always inside the current circle.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('thead', null, h('tr', null,
            h('th', null, tx('阶段', 'Phase')),
            h('th', { class: 'num' }, tx('等待', 'Wait')),
            h('th', { class: 'num' }, tx('收缩', 'Shrink')),
            h('th', { class: 'num' }, tx('半径', 'Radius')),
            h('th', { class: 'num' }, tx('圈外伤害', 'Damage outside')),
          )),
          h('tbody', null, ZONE_TABLE.map((z) =>
            h('tr', null,
              h('td', null, String(z.phase)),
              h('td', { class: 'num' }, `${z.wait}s`),
              h('td', { class: 'num' }, z.shrink ? `${z.shrink}s` : '—'),
              h('td', { class: 'num' }, `${z.radius} m`),
              h('td', { class: 'num' }, z.dps ? `${z.dps}/s` : '—'),
            ),
          )),
        ),
      ),
    ),
  );
}

function squadTab(): HTMLElement {
  const orders: [keyof typeof ORDER_KEYS, I18nKey, string, string][] = [
    ['follow', 'hud.order.follow', '以楔形阵跟随在你身后。', 'Follow behind you in a wedge.'],
    ['hold', 'hud.order.hold', '驻守准星所指的位置。', 'Hold the point under your crosshair.'],
    ['attack', 'hud.order.attack', '攻击准星处的目标，或进攻至该地点。', 'Attack the target under the crosshair, or attack-move to the point.'],
    ['charge', 'hud.order.charge', '自由交战：追杀 40 米内最近的敌人。', 'Free engage: hunt the nearest hostile within 40 m.'],
  ];
  return h('div', null,
    section(tx('带兵', 'Squad command'),
      para('每位武将统领本国士兵（基础 4 人，主公 +2）。士兵不会复活，可用「征兵令」或技能补充。', 'Every hero leads soldiers of their kingdom (4 base, Lord +2). Troops do not respawn; recruit more with Conscription orders or abilities.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('tbody', null, orders.map(([o, key, zh, en]) => h('tr', null, h('td', null, keyCap(ORDER_KEYS[o])), h('td', null, h('b', null, t(key))), h('td', null, tx(zh, en))))),
          h('tbody', null, h('tr', null, h('td', null, keyCap('B')), h('td', null, h('b', null, tx('标记', 'Mark'))), h('td', null, tx('标记准星处的敌人，部曲会集火它。', 'Mark the enemy under the crosshair; your troops focus it.')))),
        ),
      ),
      para('部曲只攻击有理由攻击的目标：伤害过你或它们的人、你正在射击或标记的目标、主动攻击的 NPC，以及已知身份与你敌对的武将——这样才能保留身份的悬念。', 'Troops only engage targets they have a reason to: anyone who hurt you or them, whatever you shoot or mark, aggressive NPCs, and heroes whose known role is hostile to yours — keeping the hidden-role tension.'),
    ),
    section(tx('兵种', 'Troop types'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('thead', null, h('tr', null, h('th', null, tx('兵种', 'Troop')), h('th', null, tx('势力', 'Kingdom')), h('th', { class: 'num' }, t('common.hp')), h('th', null, tx('作战', 'Combat')))),
          h('tbody', null, TROOPS.map((tr) =>
            h('tr', null,
              h('td', null, h('b', null, tx(tr.nameZh, tr.nameEn))),
              h('td', null, tr.kingdom === 'neutral' ? tx('中立', 'Neutral') : kingdomName(tr.kingdom)),
              h('td', { class: 'num' }, String(tr.hp)),
              h('td', null, tr.melee ? tx('近战', 'Melee') : tx(`射程 ${tr.attackRange} 米`, `${tr.attackRange} m range`)),
            ),
          )),
        ),
      ),
    ),
  );
}

function controlsTab(): HTMLElement {
  return h('div', null,
    section(tx('键鼠操作', 'Keyboard & mouse'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table controls' },
          h('tbody', null, CONTROLS.map((c) => h('tr', null, h('td', { class: 'keys' }, c.keys.map((k) => keyCap(keyLabel(k)))), h('td', null, tx(c.zh, c.en))))),
        ),
      ),
    ),
    section(tx('触屏操作', 'Touch controls'),
      para('左侧虚拟摇杆移动（推到底自动冲刺），右半屏拖动瞄准。按钮：开火（按住并拖动可同时瞄准）、开镜、跳跃、闪避、换弹、Q、E、G、互动、锦囊栏与部曲命令（点击切换）。在触屏设备上自动开启，也可在设置中切换。', 'Left virtual stick to move (push fully to sprint), drag on the right half to aim. Buttons: fire (hold and drag to aim), ADS, jump, dodge, reload, Q, E, G, interact, item bar and squad order (tap to cycle). Auto-enabled on touch devices; toggle it in Settings.'),
    ),
  );
}

function itemsTab(): HTMLElement {
  return h('div', null,
    section(tx('锦囊（消耗品）', 'Cards (consumables)'),
      para('四个锦囊栏（按键 4–7）。基本牌与锦囊牌被改造成现代道具。', 'Four item slots (keys 4–7). Basic and trick cards are reimagined as modern gadgets.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table items' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, tx('名称', 'Name')), h('th', null, tx('类别', 'Type')), h('th', null, tx('效果', 'Effect')), h('th', { class: 'num' }, tx('堆叠', 'Stack')))),
          h('tbody', null, ITEMS.map((it) =>
            h('tr', null,
              h('td', null, h('span', { class: 'item-glyph', style: `--ic:${it.color}` }, it.icon)),
              h('td', null, h('b', { style: `color:${RARITY_COLOR[it.rarity] ?? 'inherit'}` }, tx(it.nameZh, it.nameEn)), it.sgsCard && it.sgsCard !== it.nameZh ? h('div', { class: 'sg-mute' }, `〔${it.sgsCard}〕`) : null),
              h('td', null, itemKindName(it.kind)),
              h('td', null, tx(it.descZh, it.descEn)),
              h('td', { class: 'num' }, String(it.maxStack)),
            ),
          )),
        ),
      ),
    ),
  );
}

function gearTab(): HTMLElement {
  return h('div', null,
    section(tx('防具', 'Armor'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('tbody', null, ARMORS.map((a) => h('tr', null, h('td', null, h('span', { class: 'item-glyph', style: `--ic:${a.color}` }, a.nameZh.slice(0, 1))), h('td', null, h('b', null, tx(a.nameZh, a.nameEn))), h('td', null, tx(a.descZh, a.descEn))))),
        ),
      ),
    ),
    section(tx('坐骑', 'Mounts'),
      para('-1 马（进攻马）大幅提升移速；+1 马（防御马）提升移速并减少受到的伤害。被麒麟弓击中会坠马。', 'Offensive (−1) horses give big speed; defensive (+1) horses add speed and reduce damage taken. Qilin Bow hits knock riders off.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('tbody', null, MOUNTS.map((m) => h('tr', null,
            h('td', null, h('span', { class: 'item-glyph', style: `--ic:${m.color}` }, m.type === 'offense' ? '-1' : '+1')),
            h('td', null, h('b', null, tx(m.nameZh, m.nameEn))),
            h('td', null, tx(m.descZh, m.descEn)),
          ))),
        ),
      ),
    ),
  );
}

function weaponsTab(): HTMLElement {
  const sorted = [...WEAPONS].filter((w) => !w.id.startsWith('troop_') && !w.id.startsWith('turret_')).sort((a, b) => Number(b.lootable) - Number(a.lootable));
  return h('div', null,
    section(tx('武器：古兵器 → 现代枪械', 'Weapons: ancient → modern'),
      para('每位武将携带一把主武器（专属或拾取）与一把副武器（手枪）。伤害在衰减距离后逐渐降低，最远射程处为 50%。', 'Every hero carries a primary (signature or looted) and a secondary (pistol). Damage falls off after the falloff distance down to 50% at max range.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table weapons' },
          h('thead', null, h('tr', null,
            h('th', null, tx('武器', 'Weapon')),
            h('th', null, tx('类型', 'Class')),
            h('th', { class: 'num' }, tx('伤害', 'Dmg')),
            h('th', { class: 'num' }, tx('射速', 'Rate')),
            h('th', { class: 'num' }, tx('弹匣', 'Mag')),
            h('th', { class: 'num' }, tx('射程', 'Range')),
            h('th', null, tx('特性', 'Special')),
          )),
          h('tbody', null, sorted.map((w) =>
            h('tr', null,
              h('td', null, h('b', { style: `color:${RARITY_COLOR[w.rarity] ?? 'inherit'}` }, tx(w.nameZh, w.nameEn)), w.sgsCard ? h('div', { class: 'sg-mute' }, `〔${w.sgsCard}〕`) : null, !w.lootable ? h('span', { class: 'sg-chip' }, tx('专属', 'Signature')) : null),
              h('td', null, weaponClassName(w.class)),
              h('td', { class: 'num' }, w.pellets > 1 ? `${w.damage}×${w.pellets}` : String(w.damage)),
              h('td', { class: 'num' }, `${w.fireRate}/s`),
              h('td', { class: 'num' }, String(w.magSize)),
              h('td', { class: 'num' }, `${w.maxRange} m`),
              h('td', { class: 'desc' }, tx(w.descZh, w.descEn)),
            ),
          )),
        ),
      ),
    ),
  );
}

const TAB_BUILDERS: Record<HelpTab, () => HTMLElement> = {
  roles: rolesTab,
  rules: rulesTab,
  zone: zoneTab,
  squad: squadTab,
  controls: controlsTab,
  items: itemsTab,
  gear: gearTab,
  weapons: weaponsTab,
};

export function createHelpScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-help', data: { screen: 'help' } });
  let tab: HelpTab = 'roles';
  const body = h('div', { class: 'help-body sg-panel sg-corners' });

  const showTab = (): void => {
    body.replaceChildren(TAB_BUILDERS[tab]());
    body.scrollTop = 0;
  };

  const build = (): void => {
    const ids: HelpTab[] = ['roles', 'rules', 'zone', 'squad', 'controls', 'items', 'gear', 'weapons'];
    el.replaceChildren(
      h('header', { class: 'help-head' },
        button(`‹ ${t('common.back')}`, () => ctx.go('title'), { cls: 'ghost small', sfx: 'back' }),
        h('h1', { class: 'sg-h1' }, t('help.title')),
      ),
      tabs(ids.map((id) => ({ id, label: t(`help.tab.${id}` as I18nKey) })), tab, (id) => {
        tab = id;
        showTab();
      }),
      body,
    );
    showTab();
  };
  build();
  return { el, relabel: build, dispose: () => bag.dispose() };
}
