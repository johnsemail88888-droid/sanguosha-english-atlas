// 玩法说明: roles & win conditions, dying & rewards, zone, squads, controls,
// and cards / gear / weapons tables generated from the data files.
import type { Kingdom, RoleId } from '../../core/types';
import type { ItemKind } from '../../data/types';
import { ARMORS, HEROES, ITEMS, ITEM_KIND_INFO, MOUNTS, ROLES, ROLE_DISTRIBUTION, TROOPS, WEAPONS } from '../../data';
import type { Screen, UiCtx } from '../ctx';
import { Bag, h, type Child } from '../dom';
import { colon, getLang, kingdomName, t, tx, type I18nKey } from '../i18n';
import { ORDER_GLYPH, ORDER_KEYS, RARITY_INK, cardTileVars, roleInk } from '../theme';
import { touchLabel, type TouchKey } from '../short';
import { shouldUseTouch } from '../touch';
import { settings, type Lang } from '../../game/settings';
import { button, keyCap, roleSeal, tabs } from '../widgets';
import { abilityBlock, sortedAbilities, weaponCardNote, weaponClassName } from './heroDetail';
import { gearArt, isUnitWeapon } from '../cardArt';
import { isMac } from '../perfcheck';
import { artKnown, gearIcon, roleCardBadge, setArt, whenArtKnown } from '../artIcons';
import { ZONE_PHASES } from '../../sim/zone';

type HelpTab = 'roles' | 'rules' | 'zone' | 'squad' | 'skills' | 'controls' | 'items' | 'gear' | 'weapons';

/** Zone schedule (GAME_SPEC §4), generated from the sim's phase table so it never drifts. */
export const ZONE_TABLE: readonly { phase: number; wait: number; shrink: number; radius: number; dps: number }[] = ZONE_PHASES.map((z, phase) => ({
  phase,
  wait: z.wait,
  shrink: z.shrink,
  radius: z.radius,
  dps: z.dps,
}));

export interface ControlRow {
  keys: string[];
  zh: string;
  en: string;
}

export const CONTROLS: readonly ControlRow[] = [
  { keys: ['W', 'A', 'S', 'D'], zh: '移动（鼠标瞄准，点击锁定鼠标）', en: 'Move (mouse aims; click to lock the pointer)' },
  { keys: ['左键'], zh: '开火', en: 'Fire' },
  { keys: ['右键'], zh: '开镜瞄准', en: 'Aim down sights' },
  { keys: ['R'], zh: '换弹', en: 'Reload' },
  { keys: ['Shift'], zh: '冲刺', en: 'Sprint' },
  { keys: ['Space'], zh: '跳跃', en: 'Jump' },
  { keys: ['Ctrl', 'Alt'], zh: '闪避翻滚（闪）· 2 次充能，8 秒恢复', en: 'Dodge roll (闪) · 2 charges, 8 s recharge' },
  { keys: ['Q', 'E'], zh: '武将技能：瞄准类技能按住看范围、松开施放（右键取消）', en: 'Hero abilities: aimed ones show their area while held, cast on release (right click cancels)' },
  { keys: ['G'], zh: '主公技（仅主公）', en: 'Lord skill (Lord only)' },
  { keys: ['F'], zh: '拾取 / 打开锦囊 / 按住救援', en: 'Pick up / open chest / hold to revive' },
  { keys: ['1', '2'], zh: '切换主 / 副武器（或滚轮）', en: 'Primary / secondary weapon (or wheel)' },
  { keys: ['4', '5', '6', '7'], zh: '使用锦囊栏', en: 'Use item slots' },
  { keys: ['X + 4–7'], zh: '丢弃该栏锦囊（按住 X 再按数字键）', en: 'Discard that card (hold X, then press the slot key)' },
  { keys: ['Z', 'X', 'C', 'V'], zh: '部曲：跟随 / 驻守 / 进攻 / 冲锋', en: 'Squad: follow / hold / attack / charge' },
  { keys: ['B', '中键'], zh: '标记准星处目标', en: 'Mark the target under the crosshair' },
  { keys: ['H'], zh: '切换第一 / 第三人称视角', en: 'Switch first / third person view' },
  { keys: ['T'], zh: '跳身份 & 快捷喊话轮盘', en: 'Claim & quick-chat wheel' },
  { keys: ['Tab'], zh: '战况（按住）', en: 'Scoreboard (hold)' },
  { keys: ['M'], zh: '战场地图', en: 'Battle map' },
  { keys: ['Enter'], zh: '聊天', en: 'Chat' },
  { keys: ['Esc'], zh: '菜单（单机自动暂停，联机不暂停）', en: 'Menu (pauses single player; online matches keep running)' },
];

/**
 * The rows a Mac player reads differently (by the row's keys): 闪避 on ⌥ Option first —
 * ⌃ Control + click is a right-click there, ⌃+Space switches the input source (拼音 ↔
 * ABC) and ⌃+arrows switch desktops, all system shortcuts a page cannot stop — the
 * trackpad's two-finger click for 右键, and no middle button on a trackpad.
 */
const MAC_ROWS: Readonly<Record<string, ControlRow>> = {
  右键: { keys: ['右键'], zh: '开镜瞄准（触控板：双指点按）', en: 'Aim down sights (trackpad: two-finger click)' },
  'Ctrl+Alt': {
    keys: ['⌥ Option', '⌃ Control'],
    zh: '闪避翻滚（闪）· 2 次充能，8 秒恢复 · Mac 上请用 ⌥（⌃+点击会变成右键）',
    en: 'Dodge roll (闪) · 2 charges, 8 s recharge · on a Mac use ⌥ (⌃+click is a right-click)',
  },
  '1+2': { keys: ['1', '2'], zh: '切换主 / 副武器（或滚轮、触控板双指上下滑）', en: 'Primary / secondary weapon (or the wheel / a two-finger swipe)' },
  'B+中键': { keys: ['B', '中键'], zh: '标记准星处目标（触控板没有中键：按 B）', en: 'Mark the target under the crosshair (no middle button on a trackpad: press B)' },
};

/** The keyboard & mouse table, in a Mac player's words on a Mac. */
export function controlsFor(mac: boolean): readonly ControlRow[] {
  return mac ? CONTROLS.map((c) => MAC_ROWS[c.keys.join('+')] ?? c) : CONTROLS;
}

/**
 * Mac notes (玩法说明 → 操作, 设置 → 操作): the trackpad, and the game keys that meet
 * macOS / Safari shortcuts a page cannot block.
 */
export const MAC_NOTES: readonly { zh: string; en: string }[] = [
  { zh: '触控板：双指点按 = 右键瞄准；建议使用鼠标（触控板很难边走边瞄）。', en: 'Trackpad: a two-finger click is the right button (aim); a mouse is much easier.' },
  { zh: '闪避请按 ⌥ Option：⌃ Control + 点击会变成右键，⌃+空格会切换输入法，⌃+方向键会切换桌面。', en: 'Dodge with ⌥ Option: ⌃ Control + click is a right-click, ⌃+Space switches the input source and ⌃+arrows switch desktops.' },
  { zh: '对局中别按 ⌘：⌘W 会关闭页面、⌘Q 会退出浏览器、⌘H 会隐藏窗口（网页拦不住）。', en: 'Keep off ⌘ in a match: ⌘W closes the page, ⌘Q quits the browser, ⌘H hides it (a page cannot stop them).' },
  { zh: 'F3 性能面板：Mac 上按 fn + F3（F3 默认是调度中心），或在 设置 → 画面 打开「显示帧率」。', en: 'F3 performance panel: fn + F3 on a Mac (F3 alone is Mission Control), or 设置 → Graphics → “Show FPS”.' },
  { zh: '全屏更沉浸：⌃⌘F，或点窗口左上角的绿色按钮。', en: 'Full screen: ⌃⌘F, or the green button at the top left of the window.' },
];

/** The Mac notes as a titled box (玩法说明 and 设置 → 操作). */
export function macNotesBox(cls = ''): HTMLElement {
  return h('div', { class: `sg-mac-notes ${cls}`.trim(), data: { mac: '1' } },
    h('b', null, tx('Mac 用户', 'On a Mac')),
    h('ul', null, MAC_NOTES.map((n) => h('li', null, tx(n.zh, n.en)))),
  );
}

/**
 * The touch controls, one row per on-screen control (NP-7): what a phone player reads
 * first. Button caps are the buttons' own labels (short.ts touchLabel / theme ORDER_GLYPH),
 * so the sheet and the screen always agree (装弹, not 换弹; 切枪; 随 → 守 → 攻 → 冲).
 */
export interface TouchControlRow {
  /** TouchKey: that button's label; `order`: the squad button's glyph; else a literal [zh, en] cap */
  caps: readonly (TouchKey | 'order' | readonly [string, string])[];
  zh: string;
  en: string;
}

export const TOUCH_CONTROLS: readonly TouchControlRow[] = [
  { caps: [['摇杆', 'Stick']], zh: '左侧摇杆移动，推到底自动冲刺', en: 'Left stick: move; push it all the way to sprint' },
  { caps: [['拖动', 'Drag']], zh: '在右半屏拖动瞄准', en: 'Drag on the right half of the screen to aim' },
  { caps: ['fire'], zh: '开火（按住并拖动可同时瞄准）', en: 'Fire (hold and drag to aim at the same time)' },
  { caps: ['ads'], zh: '开镜瞄准（再点一次收镜）', en: 'Aim down sights (tap again to lower)' },
  { caps: ['jump'], zh: '跳跃', en: 'Jump' },
  { caps: ['dodge'], zh: '闪避翻滚，短暂无敌 · 2 次充能，8 秒恢复', en: 'Dodge roll, brief invulnerability · 2 charges, 8 s recharge' },
  { caps: ['reload'], zh: '装弹', en: 'Reload' },
  { caps: ['swap'], zh: '切枪：主 / 副武器', en: 'Swap between primary and secondary weapon' },
  { caps: [['Q', 'Q'], ['E', 'E'], ['G', 'G']], zh: '武将技能（G：主公技，仅主公）', en: 'Hero abilities (G: lord skill, Lord only)' },
  { caps: ['interact'], zh: '拾取 / 打开锦囊 / 按住救援——按钮上写着现在能做什么', en: 'Pick up / open chests / hold to revive — the button says what a tap does now' },
  { caps: [['4–7', '4–7']], zh: '锦囊栏：点击使用；长按查看说明，可「丢弃此锦囊」', en: 'Item slots: tap to use; long-press to read the card, with “Discard this card”' },
  { caps: ['order'], zh: '部曲命令：每点一次切换 随 跟随 → 守 驻守 → 攻 进攻 → 冲 冲锋', en: 'Squad order: each tap cycles Follow → Hold → Attack → Charge' },
  { caps: ['mark'], zh: '标记准星处目标（部曲会集火）', en: 'Mark the target under the crosshair (your troops focus it)' },
  { caps: ['wheel'], zh: '跳身份 & 快捷喊话轮盘', en: 'Claim & quick-chat wheel' },
  { caps: ['chat', 'map', 'score'], zh: '聊天 · 战场地图 · 战况', en: 'Chat · battle map · scoreboard' },
  { caps: ['menu'], zh: '菜单（单机自动暂停，联机不暂停）', en: 'Menu (pauses single player; online matches keep running)' },
];

/** A touch control's caps as shown (the buttons' own labels in this language). */
export function touchCapLabels(row: TouchControlRow, lang: Lang): string[] {
  return row.caps.map((c) => (c === 'order' ? (lang === 'en' ? t('hud.order.follow') : ORDER_GLYPH.follow) : typeof c === 'string' ? touchLabel(c, lang) : lang === 'en' ? c[1] : c[0]));
}

/** The touch rows as table / grid cells: round caps like the on-screen buttons, then the text. */
export function touchControlCells(lang: Lang): { caps: HTMLElement[]; text: string }[] {
  return TOUCH_CONTROLS.map((r) => ({ caps: touchCapLabels(r, lang).map((c) => h('span', { class: 'sg-tcap' }, c)), text: lang === 'en' ? r.en : r.zh }));
}

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

/** A card / armor / mount glyph tile: its painted emblem in a round frame when the art ships. */
function gearGlyph(id: string, color: string, glyph: string): HTMLElement {
  const el = h('span', { class: 'item-glyph', style: cardTileVars(color) }, glyph);
  setArt(el, gearArt(id), { lazy: true });
  return el;
}

function rolesTab(): HTMLElement {
  const cards = ROLES.map((r) =>
    h('div', { class: 'role-row' },
      roleCardBadge(r.id, () => roleSeal(r.id, '2.6em'), 'help-card'),
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
        h('table', { class: 'sg-table orders' },
          h('tbody', null, orders.map(([o, key, zh, en]) => h('tr', null, h('td', null, keyCap(ORDER_KEYS[o])), h('td', null, h('b', null, t(key))), h('td', null, tx(zh, en))))),
          h('tbody', null, h('tr', null, h('td', null, keyCap('B')), h('td', null, h('b', null, tx('标记', 'Mark'))), h('td', null, tx('标记准星处的敌人，部曲会集火它。', 'Mark the enemy under the crosshair; your troops focus it.')))),
        ),
      ),
      para('部曲只攻击有理由攻击的目标：伤害过你或它们的人、你正在射击或标记的目标、主动攻击的 NPC，以及已知身份与你敌对的武将——这样才能保留身份的悬念。', 'Troops only engage targets they have a reason to: anyone who hurt you or them, whatever you shoot or mark, aggressive NPCs, and heroes whose known role is hostile to yours — keeping the hidden-role tension.'),
    ),
    section(tx('兵种', 'Troop types'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table troops' },
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
  const mac = isMac();
  const keys = section(tx('键鼠操作', 'Keyboard & mouse'),
    mac ? macNotesBox('help') : null,
    h('div', { class: 'sg-table-wrap' },
      h('table', { class: 'sg-table controls' },
        h('tbody', null, controlsFor(mac).map((c) => h('tr', null, h('td', { class: 'keys' }, c.keys.map((k) => keyCap(keyLabel(k)))), h('td', null, tx(c.zh, c.en))))),
      ),
    ),
  );
  const touch = section(tx('触屏操作', 'Touch controls'),
    h('div', { class: 'sg-table-wrap' },
      h('table', { class: 'sg-table controls touch' },
        h('tbody', null, touchControlCells(getLang()).map((c) => h('tr', null, h('td', { class: 'keys' }, c.caps), h('td', null, c.text)))),
      ),
    ),
    para('在触屏设备上自动开启，也可在设置中切换。', 'Auto-enabled on touch devices; toggle it in Settings.'),
  );
  // NP-7: a phone player reads the buttons first (the 20-row keyboard table comes after)
  return shouldUseTouch(settings.get().touchControls) ? h('div', null, touch, keys) : h('div', null, keys, touch);
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
              h('td', null, gearGlyph(it.id, it.color, it.icon)),
              h('td', null, h('b', { style: `color:${RARITY_INK[it.rarity] ?? 'inherit'}` }, tx(it.nameZh, it.nameEn)), it.sgsCard && it.sgsCard !== it.nameZh ? h('div', { class: 'sg-mute' }, `〔${it.sgsCard}〕`) : null),
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
          h('tbody', null, ARMORS.map((a) => h('tr', null, h('td', null, gearGlyph(a.id, a.color, a.nameZh.slice(0, 1))), h('td', null, h('b', null, tx(a.nameZh, a.nameEn))), h('td', null, tx(a.descZh, a.descEn))))),
        ),
      ),
    ),
    section(tx('坐骑', 'Mounts'),
      para('-1 马（进攻马）大幅提升移速；+1 马（防御马）提升移速并减少受到的伤害。被麒麟弓击中会坠马。', 'Offensive (−1) horses give big speed; defensive (+1) horses add speed and reduce damage taken. Qilin Bow hits knock riders off.'),
      h('div', { class: 'sg-table-wrap' },
        h('table', { class: 'sg-table' },
          h('tbody', null, MOUNTS.map((m) => h('tr', null,
            h('td', null, gearGlyph(m.id, m.color, m.type === 'offense' ? '-1' : '+1')),
            h('td', null, h('b', null, tx(m.nameZh, m.nameEn))),
            h('td', null, tx(m.descZh, m.descEn)),
          ))),
        ),
      ),
    ),
  );
}

/** The 玩法说明 weapon table: every weapon a hero can carry (lootable first), no unit-only guns. */
export function playerWeapons(): typeof WEAPONS {
  return WEAPONS.filter((w) => !isUnitWeapon(w.id)).sort((a, b) => Number(b.lootable) - Number(a.lootable));
}

function weaponsTab(): HTMLElement {
  // what a player can hold: troop / NPC (黄巾力士's hammer, the elephant's tusks) / turret guns are never in reach
  const sorted = playerWeapons();
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
              h('td', { class: 'wname' },
                gearIcon(w.id, 'wt-art', true),
                h('b', { style: `color:${RARITY_INK[w.rarity] ?? 'inherit'}` }, tx(w.nameZh, w.nameEn)),
                weaponCardNote(w) ? h('div', { class: 'sg-mute' }, weaponCardNote(w)) : null,
                // on its own line: never over the end of a long name
                !w.lootable ? h('div', null, h('span', { class: 'sg-chip' }, tx('专属', 'Signature'))) : null,
              ),
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

/** 武将技能: how skills work, then every hero's skills (line + numbers from the ability data). */
function skillsTab(): HTMLElement {
  const kingdoms: Kingdom[] = ['shu', 'wei', 'wu', 'qun'];
  return h('div', null,
    section(tx('技能怎么用', 'How skills work'),
      h('div', { class: 'sk-howto' },
        h('ul', null,
          h('li', null, tx('每位武将有 Q、E 两个主动技能和被动技能；主公另有 G 主公技。技能冷却时图标变暗，金色圆环走满即就绪。', 'Every hero has two active skills (Q, E) and passives; the Lord also gets a lord skill on G. A skill on cooldown is dimmed; when the gold ring closes it is ready.')),
          h('li', null, tx('需要瞄准的技能（准星方向 / 准星落点 / 准星敌人 / 自身周围）：按住按键，地上会画出范围——冲锋路线、扇形、落点圆圈或目标光圈，松开才施放；按住时点右键取消。', 'Aimed skills (aimed direction / point / enemy / around you): hold the key and the area is drawn on the ground — the dash path, the cone, the circle or a ring under the target — and the skill fires when you let go; right click while holding cancels.')),
          h('li', null, tx('「准星敌人 / 友军」技能要把准星对准目标，灰色光圈表示现在没有目标。只作用于自身的技能按下即施放。', '“Aimed enemy / ally” skills need the crosshair on a unit — a grey ring means nothing is targeted. Self-only skills fire as soon as you press the key.')),
          h('li', null, tx('施放后准星下方会告诉你结果：命中几人、对谁生效、或未命中。', 'After a cast, the line under the crosshair tells you what it did: how many it hit, whom it affected, or that it missed.')),
        ),
      ),
    ),
    ...kingdoms.map((k) =>
      section(kingdomName(k),
        HEROES.filter((hd) => hd.kingdom === k).map((hd) =>
          h('div', { class: 'sk-hero' },
            h('h4', null, tx(hd.nameZh, hd.nameEn), h('small', null, tx(hd.titleZh, hd.titleEn)), hd.lordCandidate ? h('small', null, tx('★ 主公候选', '★ Lord candidate')) : null),
            h('div', { class: 'sk-list' }, sortedAbilities(hd).map((a) => abilityBlock(a))),
          ),
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
  skills: skillsTab,
  controls: controlsTab,
  items: itemsTab,
  gear: gearTab,
  weapons: weaponsTab,
};

export function createHelpScreen(ctx: UiCtx): Screen {
  const bag = new Bag();
  const el = h('div', { class: 'sg-screen sg-help', data: { screen: 'help' } });
  let tab: HelpTab = 'roles';
  // the tab scrolls inside the framed panel: its corner brackets stay on the frame, never over a row
  const scroll = h('div', { class: 'help-scroll' });
  const body = h('div', { class: 'help-body sg-panel sg-corners' }, scroll);

  const showTab = (): void => {
    scroll.replaceChildren(TAB_BUILDERS[tab]());
    scroll.scrollTop = 0;
  };

  const build = (): void => {
    const ids: HelpTab[] = ['roles', 'rules', 'zone', 'squad', 'skills', 'controls', 'items', 'gear', 'weapons'];
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
  // opened before the art listing arrived (a deep link): the weapon renders need it at build time
  if (!artKnown()) void whenArtKnown().then(() => !bag.isDisposed && showTab());
  return { el, relabel: build, dispose: () => bag.dispose() };
}
