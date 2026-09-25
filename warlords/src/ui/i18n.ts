// UI strings. Chinese is the primary language; English is the toggle
// (settings.lang). Content strings (hero / item / weapon names, descriptions)
// live in src/data and are picked with `tx()` or the name helpers below.
import { settings, type Lang } from '../game/settings';
import type { Kingdom, RoleId } from '../core/types';
import { HERO_BY_ID, ROLE_BY_ID, WEAPON_BY_ID, ITEM_BY_ID, ARMOR_BY_ID, MOUNT_BY_ID, TROOP_BY_ID } from '../data';

const DICT = {
  // ── generic ──
  'app.title': ['三国杀·枪火乱世', 'Sanguo Warlords'],
  'app.subtitle': ['身份局 × 第三人称枪战 × 带兵', 'Hidden roles × third-person shooter × squad command'],
  'common.back': ['返回', 'Back'],
  'common.close': ['关闭', 'Close'],
  'common.confirm': ['确定', 'Confirm'],
  'common.cancel': ['取消', 'Cancel'],
  'common.ok': ['好的', 'OK'],
  'common.start': ['开始', 'Start'],
  'common.loading': ['加载中…', 'Loading…'],
  'common.copy': ['复制', 'Copy'],
  'common.copied': ['已复制', 'Copied'],
  'common.on': ['开', 'On'],
  'common.off': ['关', 'Off'],
  'common.auto': ['自动', 'Auto'],
  'common.seat': ['{n}号位', 'Seat {n}'],
  'common.bot': ['AI', 'Bot'],
  'common.you': ['你', 'You'],
  'common.host': ['房主', 'Host'],
  'common.all': ['全部', 'All'],
  'common.seconds': ['{n}秒', '{n}s'],
  'common.hp': ['体力', 'HP'],
  'common.difficulty': ['难度', 'Difficulty'],
  'common.unknown': ['未知', 'Unknown'],
  'common.lang': ['English', '中文'],

  // ── title ──
  'title.single': ['单人练习', 'Single Player'],
  'title.singleSub': ['与AI武将一决高下', 'Battle against bot warlords'],
  'title.online': ['联机对战', 'Play Online'],
  'title.onlineSub': ['创建或加入房间', 'Host or join a room'],
  'title.gallery': ['武将图鉴', 'Hero Gallery'],
  'title.help': ['玩法说明', 'How to Play'],
  'title.settings': ['设置', 'Settings'],
  'title.name': ['你的名号', 'Your name'],
  'title.namePh': ['输入名号', 'Enter a name'],
  'title.pressStart': ['天下大势，分久必合', 'The empire, long divided, must unite'],
  'title.version': ['测试版 v{v}', 'Beta v{v}'],

  // ── single ──
  'single.title': ['单人练习', 'Single Player'],
  'single.players': ['人数', 'Players'],
  'single.mode': ['模式', 'Mode'],
  'single.modeStandard': ['标准身份', 'Standard'],
  'single.modeChaos': ['乱世身份', 'Chaos'],
  'single.modeStandardDesc': ['官方身份局：主公、忠臣、反贼、内奸。', 'Official roles: Lord, Loyalist, Rebel, Traitor.'],
  'single.modeChaosDesc': ['加入影武者、墙头草、赏金猎人等乱世身份。', 'Adds Body Double, Opportunist and Bounty Hunter.'],
  'single.botDiff': ['AI难度', 'Bot difficulty'],
  'single.easy': ['简单', 'Easy'],
  'single.normal': ['普通', 'Normal'],
  'single.hard': ['困难', 'Hard'],
  'single.freePick': ['自由选将', 'Free pick'],
  'single.freePickDesc': ['可从全部武将中挑选', 'Choose from every hero'],
  'single.roles': ['身份分配', 'Role deal'],
  'single.start': ['出征', 'Deploy'],

  // ── online ──
  'online.title': ['联机对战', 'Play Online'],
  'online.host': ['创建房间', 'Host a room'],
  'online.hostDesc': ['创建房间后把房间号或邀请链接发给好友。空位由AI补齐。', 'Create a room and share the code or invite link. Empty seats are filled with bots.'],
  'online.join': ['加入房间', 'Join a room'],
  'online.joinDesc': ['输入好友的房间号。', 'Enter your friend’s room code.'],
  'online.code': ['房间号', 'Room code'],
  'online.codePh': ['例如 KX7PQ', 'e.g. KX7PQ'],
  'online.joinBtn': ['加入', 'Join'],
  'online.via': ['连接方式', 'Connection'],
  'online.peer': ['公共P2P', 'Public P2P'],
  'online.ws': ['服务器', 'Server'],
  'online.peerDesc': ['通过 WebRTC 直连，无需服务器。', 'Direct WebRTC connection, no server needed.'],
  'online.wsDesc': ['通过局域网 / 自建服务器中转。', 'Relay through a LAN / self-hosted server.'],
  'online.serverSettings': ['服务器设置', 'Server settings'],
  'online.connecting': ['正在连接…', 'Connecting…'],
  'online.hosting': ['正在创建房间…', 'Creating room…'],
  'online.noWsUrl': ['尚未配置服务器地址，请先在设置中填写。', 'No server address configured yet — set it in Settings first.'],
  'online.badCode': ['请输入有效的房间号', 'Please enter a valid room code'],
  'online.failed': ['连接失败：{msg}', 'Connection failed: {msg}'],
  'online.invited': ['你收到了房间 {code} 的邀请', 'You were invited to room {code}'],

  // ── lobby ──
  'lobby.title': ['房间大厅', 'Lobby'],
  'lobby.roomCode': ['房间号', 'Room code'],
  'lobby.copyLink': ['复制邀请链接', 'Copy invite link'],
  'lobby.copyCode': ['点击复制房间号', 'Click to copy the code'],
  'lobby.emptySeat': ['空位 · AI补位', 'Empty · bot fills'],
  'lobby.ready': ['已准备', 'Ready'],
  'lobby.notReady': ['未准备', 'Not ready'],
  'lobby.readyBtn': ['准备', 'Ready up'],
  'lobby.unready': ['取消准备', 'Unready'],
  'lobby.addBot': ['添加AI', 'Add bot'],
  'lobby.removeBot': ['移除', 'Remove'],
  'lobby.kick': ['踢出', 'Kick'],
  'lobby.kickConfirm': ['确定将 {name} 请出房间？', 'Kick {name} from the room?'],
  'lobby.start': ['开始游戏', 'Start game'],
  'lobby.waitHost': ['等待房主开始…', 'Waiting for the host…'],
  'lobby.notAllReady': ['尚有玩家未准备', 'Not everyone is ready'],
  'lobby.settings': ['对局设置', 'Match settings'],
  'lobby.chat': ['聊天', 'Chat'],
  'lobby.chatPh': ['说点什么…', 'Say something…'],
  'lobby.send': ['发送', 'Send'],
  'lobby.leave': ['离开房间', 'Leave room'],
  'lobby.friendlyFire': ['友军伤害', 'Friendly fire'],
  'lobby.troops': ['每人兵力', 'Troops per hero'],
  'lobby.players': ['{n}/{max} 名玩家', '{n}/{max} players'],

  // ── roles ──
  'roles.title': ['身份分配', 'Roles'],
  'roles.yourRole': ['你的身份', 'Your role'],
  'roles.goal': ['胜利条件', 'Victory'],
  'roles.tips': ['提示', 'Tips'],
  'roles.lordIs': ['主公是 {name}（{seat}）', 'The Lord is {name} ({seat})'],
  'roles.twoCrowns': ['两顶王冠！其中一位是影武者。', 'Two crowns! One of them is a Body Double.'],
  'roles.yourDouble': ['{name}（{seat}）是你的影武者——只有你知道', '{name} ({seat}) is your Body Double — only you know'],
  'roles.youAreDouble': ['真主公是 {name}（{seat}）——替他挡刀，别暴露', 'The real Lord is {name} ({seat}) — draw fire for them and stay convincing'],
  'roles.bounty': ['你的赏金目标：{name}（{seat}）', 'Your bounty target: {name} ({seat})'],
  'roles.secret': ['仅你可见', 'Only you can see this'],
  'roles.tap': ['点击翻牌', 'Tap to flip'],

  // ── hero select ──
  'select.title': ['选择武将', 'Choose your hero'],
  'select.lordFirst': ['主公先行选将', 'The Lord chooses first'],
  'select.youAreLord': ['你是主公，请先选将', 'You are the Lord — choose first'],
  'select.youAreCrown': ['你头戴王冠，与主公一同先选将', 'You wear a crown — choose along with the Lord'],
  'select.crownsPicking': ['等待戴冠者选将…', 'Waiting for the crowned players to choose…'],
  'select.waitLord': ['等待主公选将…', 'Waiting for the Lord to choose…'],
  'select.lordPicked': ['主公选择了 {hero}', 'The Lord chose {hero}'],
  'select.confirm': ['选定', 'Lock in'],
  'select.locked': ['已选定', 'Locked in'],
  'select.waitOthers': ['等待其他玩家…', 'Waiting for other players…'],
  'select.taken': ['已被选择', 'Taken'],
  'select.passive': ['被动', 'Passive'],
  'select.lordSkill': ['主公技', 'Lord skill'],
  'select.signature': ['专属武器', 'Signature weapon'],
  'select.troops': ['麾下兵种', 'Troops'],
  'select.cooldown': ['冷却 {n}秒', 'Cooldown {n}s'],
  'select.charges': ['{n} 层充能', '{n} charges'],
  'select.lordOnly': ['仅主公身份时生效', 'Only works as the Lord'],
  'select.picking': ['选将中', 'Picking'],
  'select.pickHint': ['请从 {n} 名武将中选择一名，其他玩家同时选将', 'Pick one of {n} heroes — everyone else is choosing too'],
  'select.freeHint': ['自由选将：可选择任意未被选择的武将', 'Free pick: choose any hero nobody has taken'],

  // ── loading ──
  'loading.title': ['战场加载中', 'Preparing the battlefield'],
  'loading.tip': ['提示', 'Tip'],

  // ── HUD ──
  'hud.reloading': ['换弹中', 'Reloading'],
  'hud.noWeapon': ['徒手', 'Unarmed'],
  'hud.primary': ['主武器', 'Primary'],
  'hud.secondary': ['副武器', 'Secondary'],
  'hud.dodge': ['闪', 'Dodge'],
  'hud.squad': ['部曲', 'Squad'],
  'hud.squadEmpty': ['麾下已无兵', 'No troops left'],
  'hud.order.follow': ['跟随', 'Follow'],
  'hud.order.hold': ['驻守', 'Hold'],
  'hud.order.attack': ['进攻', 'Attack'],
  'hud.order.charge': ['冲锋', 'Charge'],
  'hud.zone.wait': ['烽火圈将在 {t} 后收缩', 'Zone shrinks in {t}'],
  'hud.zone.shrink': ['烽火圈收缩中 {t}', 'Zone shrinking {t}'],
  'hud.zone.final': ['烽火圈已稳定', 'Zone stable'],
  'hud.zone.phase': ['第{n}阶段', 'Phase {n}'],
  'hud.zone.outside': ['你在烽火圈外！每秒 -{dps}', 'Outside the zone! -{dps}/s'],
  'hud.zone.distance': ['距安全区 {m} 米', '{m} m to safety'],
  'hud.alive': ['存活 {n}', '{n} alive'],
  'hud.interact.crate': ['打开锦囊', 'Open the chest'],
  'hud.interact.crate2': ['打开铜锦囊', 'Open the bronze chest'],
  'hud.interact.airdrop': ['打开天降锦囊', 'Open the airdrop'],
  'hud.interact.pickup': ['拾取 {name}', 'Pick up {name}'],
  'hud.interact.swap': ['替换为 {name}', 'Swap for {name}'],
  'hud.interact.revive': ['按住 F 救援 {name}', 'Hold F to revive {name}'],
  'hud.interact.needPeach': ['需要桃', 'Needs a Peach'],
  'hud.interact.selfRevive': ['按 {key} 饮酒自救', 'Press {key} to drink Wine and rise'],
  'hud.channel.item': ['使用中', 'Using'],
  'hud.channel.revive': ['救援中', 'Reviving'],
  'hud.channel.open': ['开启锦囊', 'Opening'],
  'hud.channel.ability': ['施法中', 'Casting'],
  'hud.channel.recruit': ['征兵中', 'Recruiting'],
  'hud.downed': ['濒死', 'Downed'],
  'hud.downedHint': ['等待队友用「桃」救援', 'Wait for an ally to revive you with a Peach'],
  'hud.bleed': ['失血 {t}', 'Bleeding out {t}'],
  'hud.dead': ['你已阵亡', 'You have fallen'],
  'hud.killedBy': ['击杀者：{name}', 'Killed by {name}'],
  'hud.spectating': ['观战：{name}', 'Spectating: {name}'],
  'hud.prev': ['上一位', 'Previous'],
  'hud.next': ['下一位', 'Next'],
  'hud.headshot': ['爆头', 'Headshot'],
  'hud.kill': ['击杀', 'Kill'],
  'hud.zoneDeath': ['烽火圈', 'the zone'],
  'hud.killed': ['击杀', 'killed'],
  'hud.downedBy': ['击倒', 'downed'],
  'hud.claims': ['声明：{role}', 'claims {role}'],
  'hud.blocked.dodge': ['闪', 'Dodged'],
  'hud.blocked.armor': ['格挡', 'Blocked'],
  'hud.blocked.invuln': ['免疫', 'Immune'],
  'hud.blocked.shield': ['护盾', 'Shield'],
  'hud.blocked.nullify': ['无懈', 'Nullified'],
  'hud.blocked.redirect': ['流离', 'Deflected'],
  'hud.reward.rebelKill': ['击杀反贼！获得 3 个锦囊', 'Rebel slain! +3 items'],
  'hud.reward.bounty': ['赏金到手！获得 2 个稀有锦囊', 'Bounty claimed! +2 rare items'],
  'hud.reward.lordPenalty': ['主公误杀忠良，弃置所有装备！', 'The Lord slew a loyal subject and drops all gear!'],
  'hud.pickup': ['获得 {name}', 'Got {name}'],
  'hud.airdrop': ['天降锦囊！', 'Airdrop incoming!'],
  'hud.zoneAnnounce': ['烽火圈 {phase}：即将收缩至 {r} 米', 'Zone {phase}: shrinking to {r} m'],
  'hud.bountyTarget': ['目标：{name}', 'Target: {name}'],
  'hud.clickToPlay': ['点击进入战场', 'Click to enter the battle'],
  'hud.fps': ['{n} 帧', '{n} FPS'],
  'hud.rotate': ['请将设备横置以进行游戏', 'Rotate your device to landscape to play'],
  'hud.passive': ['被动', 'Passive'],
  'hud.lord': ['主公技', 'Lord'],
  'hud.armor': ['防具', 'Armor'],
  'hud.mount': ['坐骑', 'Mount'],

  // ── scoreboard / map / chat / wheel / pause ──
  'score.title': ['战况', 'Scoreboard'],
  'score.player': ['玩家', 'Player'],
  'score.hero': ['武将', 'Hero'],
  'score.role': ['身份', 'Role'],
  'score.claim': ['声明', 'Claim'],
  'score.kills': ['击杀', 'Kills'],
  'score.status': ['状态', 'Status'],
  'score.ping': ['延迟', 'Ping'],
  'score.alive': ['存活', 'Alive'],
  'score.downed': ['濒死', 'Downed'],
  'score.dead': ['阵亡', 'Dead'],
  'score.hidden': ['未知', 'Hidden'],
  'score.ally': ['自己人', 'Ally'],
  'score.decoy': ['你的影武者', 'Your Body Double'],
  'score.trueLord': ['真主公', 'The real Lord'],
  'score.yourStats': ['你的战绩', 'Your stats'],
  'stat.kills': ['击杀', 'Kills'],
  'stat.damage': ['伤害', 'Damage'],
  'stat.healing': ['治疗', 'Healing'],
  'stat.rescues': ['救援', 'Rescues'],
  'map.title': ['战场地图', 'Battle map'],
  'map.legend.you': ['你', 'You'],
  'map.legend.squad': ['部曲', 'Squad'],
  'map.legend.lord': ['主公', 'Lord'],
  'map.legend.zone': ['烽火圈', 'Zone'],
  'map.legend.next': ['下一圈', 'Next zone'],
  'map.legend.airdrop': ['天降锦囊', 'Airdrop'],
  'map.legend.known': ['已知身份', 'Known role'],
  'chat.placeholder': ['按 Enter 发送，Esc 取消', 'Enter to send, Esc to cancel'],
  'chat.system': ['系统', 'System'],
  'wheel.title': ['跳身份 · 快捷喊话', 'Claims & quick chat'],
  'wheel.hint': ['点击或按数字键选择，T / Esc 关闭', 'Click or press a number; T / Esc to close'],
  'pause.title': ['暂停', 'Paused'],
  'pause.resume': ['继续战斗', 'Resume'],
  'pause.settings': ['设置', 'Settings'],
  'pause.leave': ['离开对局', 'Leave match'],
  'pause.leaveConfirm': ['确定离开当前对局？', 'Leave the current match?'],
  'pause.controls': ['操作说明', 'Controls'],

  // ── game over ──
  'over.victory': ['胜利', 'Victory'],
  'over.defeat': ['败北', 'Defeat'],
  'over.draw': ['平局', 'Draw'],
  'over.winners': ['获胜阵营：{faction}', 'Winning side: {faction}'],
  'over.duration': ['对局时长 {t}', 'Match length {t}'],
  'over.mvp': ['最佳武将', 'MVP'],
  'over.toLobby': ['返回大厅', 'Back to lobby'],
  'over.again': ['再来一局', 'Play again'],
  'over.toTitle': ['返回标题', 'Main menu'],
  'over.waitHost': ['等待房主返回大厅…', 'Waiting for the host…'],
  'over.won': ['胜', 'Won'],
  'over.lost': ['败', 'Lost'],
  'faction.lord': ['主公阵营', 'Lord & Loyalists'],
  'faction.rebel': ['反贼', 'Rebels'],
  'faction.traitor': ['内奸', 'Traitor'],
  'faction.neutral': ['中立', 'Neutral'],
  'faction.draw': ['无人', 'Nobody'],

  // ── gallery ──
  'gallery.title': ['武将图鉴', 'Hero Gallery'],
  'gallery.count': ['共 {n} 名武将', '{n} heroes'],
  'gallery.bio': ['生平', 'Biography'],
  'gallery.playstyle': ['玩法', 'Playstyle'],
  'gallery.quotes': ['台词', 'Quotes'],
  'gallery.abilities': ['技能', 'Abilities'],
  'gallery.gender.male': ['男', 'Male'],
  'gallery.gender.female': ['女', 'Female'],
  'gallery.lordCandidate': ['主公候选', 'Lord candidate'],
  'gallery.empty': ['暂无武将', 'No heroes yet'],

  // ── help ──
  'help.title': ['玩法说明', 'How to Play'],
  'help.tab.roles': ['身份', 'Roles'],
  'help.tab.rules': ['规则', 'Rules'],
  'help.tab.zone': ['烽火圈', 'Zone'],
  'help.tab.squad': ['带兵', 'Squads'],
  'help.tab.controls': ['操作', 'Controls'],
  'help.tab.items': ['锦囊', 'Cards & items'],
  'help.tab.gear': ['装备', 'Gear'],
  'help.tab.weapons': ['武器', 'Weapons'],

  // ── settings ──
  'settings.title': ['设置', 'Settings'],
  'settings.tab.general': ['通用', 'General'],
  'settings.tab.controls': ['操作', 'Controls'],
  'settings.tab.graphics': ['画面', 'Graphics'],
  'settings.tab.audio': ['声音', 'Audio'],
  'settings.tab.network': ['网络', 'Network'],
  'settings.language': ['语言', 'Language'],
  'settings.name': ['名号', 'Player name'],
  'settings.mouse': ['鼠标灵敏度', 'Mouse sensitivity'],
  'settings.ads': ['开镜灵敏度', 'ADS sensitivity'],
  'settings.invertY': ['反转Y轴', 'Invert Y axis'],
  'settings.touch': ['触屏操作', 'Touch controls'],
  'settings.fov': ['视野 (FOV)', 'Field of view'],
  'settings.quality': ['画质', 'Quality'],
  'settings.quality.low': ['流畅', 'Low'],
  'settings.quality.medium': ['均衡', 'Medium'],
  'settings.quality.high': ['精美', 'High'],
  'settings.fps': ['显示帧率', 'Show FPS'],
  'settings.master': ['总音量', 'Master volume'],
  'settings.music': ['音乐', 'Music'],
  'settings.sfx': ['音效', 'Sound effects'],
  'settings.voice': ['武将台词', 'Hero voice lines'],
  'settings.netMode': ['默认联机方式', 'Default connection'],
  'settings.peerHost': ['PeerJS 服务器', 'PeerJS host'],
  'settings.peerHostPh': ['留空 = 公共云 0.peerjs.com', 'empty = public cloud 0.peerjs.com'],
  'settings.peerPort': ['端口', 'Port'],
  'settings.peerPath': ['路径', 'Path'],
  'settings.peerSecure': ['使用 HTTPS/WSS', 'Use HTTPS/WSS'],
  'settings.wsUrl': ['中转服务器地址', 'Relay server URL'],
  'settings.wsUrlPh': ['例如 ws://192.168.1.5:8787/ws', 'e.g. ws://192.168.1.5:8787/ws'],
  'settings.turn': ['TURN 服务器（可选）', 'TURN server (optional)'],
  'settings.turnUser': ['TURN 用户名', 'TURN username'],
  'settings.turnPass': ['TURN 密码', 'TURN password'],
  'settings.reset': ['恢复默认', 'Reset to defaults'],
  'settings.resetNet': ['恢复网络默认', 'Reset network'],
  'settings.saved': ['设置已保存', 'Settings saved'],

  // ── errors ──
  'error.title': ['出错了', 'Something went wrong'],
  'error.generic': ['发生未知错误', 'An unknown error occurred'],
} as const satisfies Record<string, readonly [string, string]>;

export type I18nKey = keyof typeof DICT;
export type I18nVars = Record<string, string | number>;

let langOverride: Lang | null = null;

/** Current UI language. */
export function getLang(): Lang {
  return langOverride ?? settings.get().lang;
}

/** Test / harness hook: force a language without touching persisted settings. */
export function overrideLang(lang: Lang | null): void {
  langOverride = lang;
}

function interpolate(s: string, vars?: I18nVars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate a dictionary key (with optional `{var}` interpolation). */
export function t(key: I18nKey, vars?: I18nVars): string {
  const entry = DICT[key];
  return interpolate(getLang() === 'en' ? entry[1] : entry[0], vars);
}

/** Pick between an inline Chinese / English pair. */
export function tx(zh: string, en: string, vars?: I18nVars): string {
  return interpolate(getLang() === 'en' ? en || zh : zh || en, vars);
}

export function hasKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(DICT, key);
}

/** All dictionary keys (tests check both languages are filled). */
export function allKeys(): I18nKey[] {
  return Object.keys(DICT) as I18nKey[];
}

export function rawEntry(key: I18nKey): readonly [string, string] {
  return DICT[key];
}

// ── content-name helpers (fall back to the raw id for unknown content) ─────

export function heroName(id: string | undefined): string {
  if (!id) return '';
  const h = HERO_BY_ID[id];
  return h ? tx(h.nameZh, h.nameEn) : id;
}

export function heroTitle(id: string | undefined): string {
  const h = id ? HERO_BY_ID[id] : undefined;
  return h ? tx(h.titleZh, h.titleEn) : '';
}

export function roleName(role: RoleId | undefined | null): string {
  if (!role) return '';
  const r = ROLE_BY_ID[role];
  return r ? tx(r.nameZh, r.nameEn) : role;
}

const KINGDOM_NAMES: Record<Kingdom, [string, string]> = {
  wei: ['魏', 'Wei'],
  shu: ['蜀', 'Shu'],
  wu: ['吴', 'Wu'],
  qun: ['群', 'Qun'],
  god: ['神', 'God'],
};

export function kingdomName(k: Kingdom | undefined): string {
  if (!k) return '';
  const n = KINGDOM_NAMES[k];
  return n ? tx(n[0], n[1]) : k;
}

/** Any equipment / item / weapon id → display name. */
export function gearName(id: string | undefined | null): string {
  if (!id) return '';
  const d = WEAPON_BY_ID[id] ?? ITEM_BY_ID[id] ?? ARMOR_BY_ID[id] ?? MOUNT_BY_ID[id];
  return d ? tx(d.nameZh, d.nameEn) : id;
}

export function troopName(id: string | undefined): string {
  if (!id) return '';
  const d = TROOP_BY_ID[id];
  return d ? tx(d.nameZh, d.nameEn) : id;
}

/** m:ss */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function seatLabel(seat: number): string {
  return t('common.seat', { n: seat + 1 });
}
