# 三国杀·枪火乱世 (Sanguo Warlords) — Game Spec v1

> Master design + architecture document. Every contributor (human or agent) reads this first.
> Contracts (TypeScript) live in `src/core/*`, `src/data/types.ts`, `src/sim/api.ts`,
> `src/sim/host.ts`, `src/render/view.ts`, `src/game/session.ts`. This doc explains them.

## 1. Vision

A **third-person hero shooter** that fuses:

- **三国杀 身份局** — hidden roles 主公 / 忠臣 / 反贼 / 内奸 (+ optional 乱世 fun roles), the same
  win conditions, rewards and penalties as the card game. Each player knows only their own role;
  the Lord is public.
- **三国杀 武将** — 30 heroes; each hero's card skills are reimagined as action abilities
  (passive + Q + E, lord skill on G when playing the Lord).
- **和平精英 / PUBG feel** — loot 锦囊 crates, ancient weapons reimagined as modern guns
  (诸葛连弩 = SMG, 麒麟弓 = anti-materiel sniper, 方天画戟 = triple rocket launcher …),
  a shrinking **烽火圈** zone, airdrops (天降锦囊), third-person over-the-shoulder camera, ADS.
- **带兵 (squad command)** — every hero leads AI soldiers of their kingdom and can order them
  (follow / hold / attack / charge, mark target).

Target: **5–8 player matches (humans + bots), 8–12 minutes**, playable in a browser with zero
install, as a desktop app, single-player vs bots, and online with friends via a room code.

## 2. Tech & repository

- Lives in `warlords/` inside this repo. The rest of the repository (the 三国杀英文图鉴 atlas at the
  repo root) is **legacy and must not be touched**.
- TypeScript (strict) + Vite 8 + three.js r186. No UI framework: DOM + CSS for UI.
- Networking: PeerJS (WebRTC data channels) for internet P2P with room codes, plus a WebSocket
  relay (`server/server.mjs`, Node `ws`) for LAN / self-hosted servers. The same Node server also
  hosts a PeerJS signalling server (`peer` package) so users in regions where the public PeerJS
  cloud is slow/blocked can self-host one server for everything.
- Tests: vitest (`tests/unit/**`, node env, sim is headless) and Playwright (`tests/e2e/**`).
  Headless Chromium lives at `/opt/pw-browsers/chromium` (Playwright 1.56.1 is pinned to match).
  WebGL in headless Chromium: launch with `args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']`.
- Commands (run inside `warlords/`): `npm run dev`, `npm run build`, `npm run typecheck`,
  `npm test`, `npm run e2e`, `npm run build:single` (one self-contained HTML file),
  `npm run server` (LAN/self-host server on :8787).
- The container has **no internet** except the npm registry. PeerJS cloud, CDNs and Google Fonts
  are unreachable here — never depend on them at runtime without a fallback; test networking
  with the local server (`peer` + `ws`) instead.

### Layout & ownership

```
src/core/      contracts: types.ts, math.ts, rng.ts, map.ts           (frozen, orchestrator)
src/data/      content: heroes, weapons, items/armor/mounts, troops,   (DATA)
               roles, statuses, loot tables, i18n strings for content
src/sim/       headless authoritative simulation                       (SIM-CORE)
  api.ts host.ts                                                       (frozen contracts)
  world.ts physics.ts combat.ts status.ts spatial.ts rules.ts zone.ts
  loot.ts troops.ts npc.ts snapshot.ts ...
  abilities/registry.ts  (+ per-kingdom impl files in wave 2)
  items/registry.ts      (+ item impls in wave 2)
  ai/                    (basic bot in wave 1, full AI in wave 2)
  map/                   map generator + nav grid                      (MAP)
src/render/    three.js renderer, characters, weapons, vfx, camera     (RENDER)
src/game/      input.ts (keyboard/mouse/touch → InputFrame), match glue (RENDER + INTEGRATION)
src/net/       transports, protocol, host/client sessions, views       (NET)
server/        Node LAN/self-host server                               (NET)
src/ui/        all DOM screens, HUD, i18n, styles, touch controls      (UI)
src/audio/     procedural WebAudio SFX + music                        (AUDIO)
electron/, .github/workflows, scripts/  packaging + CI                  (PACKAGING, wave 2)
```

### Hard rules for all code

1. `src/sim/**` must never import three.js, DOM, or anything in `render/ ui/ audio/ net/`.
   It must run in Node (unit tests) and in the browser.
2. The host's sim is the single source of truth. Clients never roll gameplay randomness.
3. Renderer/UI/audio only read `ViewSource` / `GameSession` and never mutate sim state.
4. Every user-facing string is bilingual (zh primary, en secondary). Default language zh.
5. Named exports only. No new runtime dependencies without the orchestrator's approval
   (installed: three, peerjs; dev: ws, peer, vite-plugin-singlefile, vitest, playwright, electron).
6. Contracts are frozen during parallel waves. Allowed: **additive optional** fields or new
   exported types. Log every contract change in `docs/CONTRACT_CHANGES.md` (append a line).
7. Performance: sim tick < 4 ms for 8 heroes + 50 troops + 30 NPCs; render 60 fps at 1080p on an
   integrated GPU (instancing, few draw calls, one shadow-casting light).

## 3. Match flow

1. **Title** → 单人练习 (vs bots) · 创建房间 · 加入房间 · 武将图鉴 · 玩法说明 · 设置.
2. **Lobby** (host): player count 5/6/7/8, mode 标准身份 / 乱世身份, bot difficulty, free-pick toggle.
   Humans join by room code; empty seats are bots. Host presses 开始.
3. **身份分配 (roles)**: a role card flips for each player (only you see yours). Lord is announced
   (in 乱世 mode with 影武者, two crowns are announced — see §4).
4. **选将 (hero select)**: the Lord first picks from the 5 lord candidates + 3 random heroes (15 s);
   the Lord's pick is shown to everyone; then all others pick simultaneously from 3 random
   heroes (20 s; `freePick` shows all). Duplicate heroes are not allowed. Bots pick instantly.
5. **Battle**: everyone spawns (Lord at the palace, others at shuffled spawn points ~110 m out)
   with their signature weapon, a pistol, 1 × 桃, and their squad.
6. **Game over** screen: winners, every role revealed, stats (kills/damage/healing/rescues), MVP;
   host can return everyone to the lobby.

## 4. Rules (三国杀 身份局, action edition)

### Roles & distribution (`src/data/roles.ts`)

| Players | Standard (official counts) |
|---|---|
| 5 | 主公1 忠臣1 反贼2 内奸1 |
| 6 | 主公1 忠臣1 反贼3 内奸1 |
| 7 | 主公1 忠臣2 反贼3 内奸1 |
| 8 | 主公1 忠臣2 反贼4 内奸1 |

乱世 (chaos) mode deals one random variant per count from `ROLE_DISTRIBUTION.chaos`, swapping in:

- **影武者 Body Double** (lord side): everyone sees a crown on both the real Lord and the Double;
  only the real Lord knows which is the decoy. The Double gets the Lord's +100 HP but **no lord
  skill** (a tell for sharp players). Revealed on death.
- **墙头草 Opportunist** (neutral): wins alongside whichever side wins if alive at the end.
- **赏金猎人 Bounty Hunter** (neutral): secretly assigned a random non-lord target; killing it
  personally pays 2 rare items; if someone else kills the target a new target is assigned.
  Bonus-wins if they killed at least one bounty target and are alive at the end.
  Neutral roles never block or cause other factions' victories.

### Win conditions (checked every tick, `sim/rules.ts`)

- **Lord dies** → if the only living non-neutral hero is the Traitor ⇒ **Traitor wins**;
  otherwise ⇒ **Rebels win** (even if every rebel is already dead — official rule).
- **All Rebels and the Traitor are dead** while the Lord lives ⇒ **Lord + Loyalists (+ Double) win**.
- Neutral extra winners are appended to `GameResult.winners`.
- Everyone dead at the same tick ⇒ draw. Hard cap 15:00: the final zone collapses to 0.

### Life, dying, rewards

- HP = 三国杀 体力 × 100 (3 → 300, 4 → 400). Lord (and Double) +100 max HP in all counts.
- No passive regen. Healing comes from 桃 / abilities.
- **濒死 (downed)** at 0 HP: 12 s bleed-out, crawling at 25 % speed, cannot shoot. Anyone can
  revive with a 桃 (hold F on them, 1.5 s → 100 HP); the downed hero may drink 酒 to self-revive
  (50 HP). Damage while downed shortens bleed-out. Bleed-out or finishing → **death**.
- **Death reveals the role** to everyone (kill feed: "张飞(反贼) 被 曹操 击杀"). Dead players spectate
  (cycle alive heroes). Their squad disbands (troops become neutral NPCs that flee/fight 20 s, then vanish).
- **Rewards/penalties** (official): whoever kills a **Rebel** draws **3 random items**
  (dropped straight into their slots / at their feet). If the **Lord kills a Loyalist or the Double**,
  the Lord **drops every item, armor, mount and the secondary weapon**.
- Friendly fire is ON (it's an identity game). A commander's own troops/turrets never damage him
  and are immune to his own AoE.

### 跳身份 (claims) and quick-chat

Players may publicly claim a role at any time (T wheel: 我是忠臣 / 我是反贼 / 我是内奸 / 保护主公 /
集火此人 / 需要桃 / 跟我来). Claims show as a small tag above the nameplate and in the scoreboard.
Lies are allowed. Bots claim too (sometimes lying as traitors).

### Zone 烽火圈 (`sim/zone.ts`)

| Phase | wait (s) | shrink (s) | radius → | dps outside |
|---|---|---|---|---|
| 0 | 90 | — | 230 (whole map) | 0 |
| 1 | 0 | 60 | 160 | 4 |
| 2 | 60 | 45 | 100 | 8 |
| 3 | 45 | 40 | 55 | 15 |
| 4 | 40 | 30 | 25 | 30 |
| 5 | 30 | 30 | 0 | 60 |

Next center is random but inside the current circle, biased towards the map center.
Zone damage is type `zone` (ignores armor/dodge/shields; troops/NPCs take it too).

### Loot & airdrops (`sim/loot.ts`)

- ~40 tier-1 wooden 锦囊 crates (1–2 items, common/rare), ~12 tier-2 bronze crates in camps and
  important buildings (2–3 items incl. rare/epic weapons), ~60 ground loot spots.
- **天降锦囊 airdrop** every 100 s from 2:00, announced and marked on the minimap; lands after a
  12 s fall (visible smoke + flare): 1 legendary/epic weapon + armor or mount + 2 items.
- Picking up: walk over ammo/items auto-pickup if a slot is free; weapons/armor/mounts need F
  (swaps with current, dropping the old one). Items stack up to `maxStack`.

## 5. Heroes (30) — design intent

Each hero: `sgsHp`, a signature weapon, a troop type (by kingdom), **passive + Q + E**, and for the
five lord candidates a **lord skill (G)** that only works when that hero is the actual Lord.
Kingdom colors: 魏 blue `#2e5fa8`, 蜀 red `#c0392b`, 吴 green `#2e8b57`, 群 grey `#8a8a8a`.
DATA writes full numbers + bilingual text; wave-2 ABILITY agents implement them. Numbers below
are guidance; DATA tunes them for balance (TTK for a 400 HP hero under sustained rifle fire ≈ 2.5 s).

### 蜀 Shu
| id | 名 | HP | passive | Q | E | lord (G) |
|---|---|---|---|---|---|---|
| liubei | 刘备 ★ | 4 | 仁德: heals you give also heal you 30 %; squad +2 | 仁德: toss a supply pack to the ally under crosshair (heal 80 + 1 common item); 2nd toss within 12 s heals you 60 | 蜀汉旌旗: plant a rally banner 10 s (allies regen 15/s, your troops +30 % dmg) | 激将: summon 4 temporary Shu militia (30 s) + nearby Shu heroes fire-rate ×1.3 |
| guanyu | 关羽 | 4 | 武圣: fire/explosive/melee dmg +25 % | 青龙斩: 8 m charge + 110° glaive sweep 90 dmg, knockback | 义绝: target silenced 8 s, you deal +30 % to it | — |
| zhangfei | 张飞 | 4 | 咆哮(被动): shotgun reload −40 %; kills grant 3 s no-reload | 咆哮: 6 s no-reload + fire-rate ×1.5; enemies within 8 m slowed 30 % | 据水断桥: cone shout, knockback; stuns troops/NPCs 2 s, heroes 0.8 s | — |
| zhugeliang | 诸葛亮 | 3 | 观星: every 20 s reveal heroes within 60 m on your minimap for 3 s | 八阵图: 7 m stone formation 8 s: enemies inside slowed & confused, allies inside +30 % dodge | 空城: 3 s invulnerable + untargetable, cannot attack (guqin); nearby troops/NPCs lose aggro | — |
| zhaoyun | 赵云 | 4 | 龙胆: 3 dodge charges; after a dodge your next 3 shots +40 % | 七进七出: up to 3 chained 7 m dashes with i-frames, 40 melee to enemies passed through | 长坂救主: dash to ally/self under crosshair and grant 150 shield 6 s | — |
| machao | 马超 | 4 | 马术: permanently mounted (+20 % speed, rides a warhorse) | 铁骑: 6 s your shots are undodgeable + pierce armor, hits silence 1 s | 西凉冲锋: 15 m charge, 70 dmg + knockback to everything in the path | — |
| huangyueying | 黄月英 | 3 | 集智: using an item cuts all your cooldowns by 3 s | 木牛流马: deploy an auto-turret (200 HP, 25 s, SMG) | 奇才: 6 s your turrets/troops fire-rate ×1.6 and your weapon doesn't consume ammo | — |
| huangzhong | 黄忠 | 4 | 烈弓: shots vs targets > 30 m are undodgeable and +25 % | 百步穿杨: next shot within 5 s: charged penetrating round (pierces 3, 180 dmg) | 老当益壮: heal 25 % of max + 5 s haste | — |

### 魏 Wei
| id | 名 | HP | passive | Q | E | lord (G) |
|---|---|---|---|---|---|---|
| caocao | 曹操 ★ | 4 | 奸雄: 25 % of weapon damage you take becomes shield (5 s) | 宁教我负天下人: your troops +50 % dmg and charge the crosshair target; you gain 20 % lifesteal 6 s | 望梅止渴: fully heal your squad, squad + you haste 5 s | 护驾: summon 3 虎豹骑 guards (40 s); 6 s: 50 % of damage you take is redirected to nearby Wei units |
| simayi | 司马懿 | 3 | 反馈: when a hero damages you, steal 1 random item from them (8 s cd) | 鬼才: 3 s field reflecting 100 % bullet damage back to shooters | 狼顾: reveal enemies within 40 m 5 s; your shots at revealed targets +40 % | — |
| xiahoudun | 夏侯惇 | 4 | 刚烈: 30 % of any damage you take is dealt back to the attacker | 拔矢啖睛: heal 30 % of missing HP + dmg ×1.3 for 6 s | 独目怒冲: charge 12 m, stun first hero hit 1 s | — |
| zhangliao | 张辽 | 4 | 突袭(被动): +50 % damage to targets facing away | 突袭: blink ≤ 12 m to crosshair target, steal 1 item from up to 2 enemies within 6 m, slow them | 威震逍遥津: 10 m shout: enemies silenced 2 s, their troops flee 3 s | — |
| xuchu | 许褚 | 4 | 虎痴: immune to knockback; squad +1 | 裸衣: 8 s dmg ×1.6, damage taken ×1.25 | 虎卫猛击: ground slam 6 m, 80 dmg + knock-up | — |
| guojia | 郭嘉 | 3 | 天妒/遗计: taking ≥ 40 dmg in one hit gives you 1 random item and refills your mag (6 s cd) | 遗计: call a supply airdrop at crosshair (lands in 3 s, 2 items) | 鬼谋: mark target 6 s — takes +25 % from all sources and is revealed | — |
| zhenji | 甄姬 | 3 | 倾国: 25 % chance to evade bullets while moving | 洛神: gamble up to 4 draws (60 %, 50 %, 40 %, 30 %), each success = 1 random item | 凌波微步: blink 10 m, leave a frost field that slows | — |
| xiahouyuan | 夏侯渊 | 4 | 神速(被动): +15 % move speed; sprint doesn't break ADS | 神速: blink 14 m to point + instant free 5-round volley | 虎步关右: 5 s haste 40 % + dodge recharge | — |

### 吴 Wu
| id | 名 | HP | passive | Q | E | lord (G) |
|---|---|---|---|---|---|---|
| sunquan | 孙权 ★ | 4 | 制衡(被动): reload 20 % faster | 制衡: discard all items and redraw the same number +1; instantly reload everything; reset dodges | 坐断东南: recruit 2 troops (up to squad cap + 2) | 救援: 6 s: nearby Wu units take 30 % less; heals from Wu heroes on you ×2 |
| ganning | 甘宁 | 4 | 锦帆: +10 % speed; kills refill your mag | 奇袭: EMP bolt — target drops armor & mount, loses shield, silenced 3 s | 百骑劫营: 8 s stealth for you + squad; first attack from stealth +60 % | — |
| lumeng | 吕蒙 | 4 | 克己: not firing for 4 s ⇒ stealth (breaks on firing) | 白衣渡江: 6 s stealth while moving + 30 % haste | 攻心: target disarmed 2.5 s and you steal 1 item | — |
| huanggai | 黄盖 | 4 | 苦肉(被动): below 50 % HP, fire damage +30 % | 苦肉: lose 40 HP ⇒ gain 2 random items + fire-rate ×1.4 5 s | 诈降火船: launch a burning fire-ship drone (12 m/s), explodes 7 m: 120 fire + fire field | — |
| zhouyu | 周瑜 | 3 | 英姿: reload +25 %, ability cooldowns −15 % | 反间: charm the crosshair enemy 3 s — they attack the nearest other hero; their troops turn on them | 火烧赤壁: napalm strike along a 25 m line after 1.5 s: 100 fire + burning ground | — |
| daqiao | 大乔 | 3 | 流离: 30 % of bullets hitting you are redirected to another unit within 8 m | 国色: throw 乐不思蜀 at crosshair enemy: dance 3 s | 安娴: heal you and all allies within 6 m for 80 | — |
| luxun | 陆逊 | 3 | 谦逊: immune to stun/charm/dance/silence/steal. 连营: when your mag empties, instantly reload 50 % | 火烧连营: lay 5 fire fields in a line ahead | 连营: 6 s no-reload; your fire fields spread | — |
| sunshangxiang | 孙尚香 | 3 | 枭姬: when you lose armor/mount or first drop < 50 % HP: haste + full ammo + 1 item | 结姻: heal yourself and the male hero under crosshair 100 each | 弓腰姬: fire 5 explosive arrows in a fan | — |

### 群 Qun
| id | 名 | HP | passive | Q | E | lord (G) |
|---|---|---|---|---|---|---|
| huatuo | 华佗 | 3 | 急救: revives take 0.5 s and give +80 HP; revive without 桃 once per 30 s | 青囊: heal crosshair ally/self 150 over 3 s + cleanse debuffs | 麻沸散: gas grenade 5 m: enemies stunned 1.5 s + slowed | — |
| lubu | 吕布 | 4 | 无双: your damage is undodgeable and ignores 50 % of shields; rides 赤兔 (+15 %) | 方天画戟: 360° halberd spin 5 m, 110 dmg + knockback | 辕门射戟: precise long shot 150 dmg, stun 1 s | — |
| diaochan | 貂蝉 | 3 | 闭月: regen 6 HP/s after 5 s without damage | 离间: crosshair enemy + the nearest other hero to it are charmed to fight each other 3 s | 连环计: chain up to 3 enemies near the target for 8 s (fire/thunder spreads) | — |
| zhangjiao | 张角 ★ | 3 | 鬼道: thunder damage +30 % | 雷击: 3 lightning bolts at crosshair area (0.6 s apart), 90 thunder each, stun 0.5 s | 太平要术: a storm cloud follows the crosshair enemy 8 s, striking every 1.5 s | 黄天: summon 5 黄巾力士 allies (40 s) |
| yuanshao | 袁绍 ★ | 4 | 名门: squad +1; troops +20 % HP | 乱击: arrow-rain barrage 12 m radius at crosshair for 3 s | 四世三公: summon 4 crossbowmen (30 s) | 血裔: +50 max HP per living Qun hero; squad +2 |
| menghuo | 孟获 | 4 | 祸首/再起: immune to barbarians; once per match, when downed instantly rise with 50 % HP | 南蛮入侵: summon 6 barbarian warriors (25 s) rushing the crosshair point | 象兵: a war elephant charges forward 30 m trampling everything | — |

★ = lord candidate. Lord skills (G) only function if the hero is the real Lord.

## 6. Weapons (`src/data/weapons.ts`) — ancient → modern

Every hero carries a **primary** (signature or looted) and a **secondary** (pistol). Hitscan unless
`projectile` is set. Damage falloff from `falloffStart` to `maxRange` (→ 50 %).

| id | 三国杀 card | Modern form | special |
|---|---|---|---|
| pistol | — | 制式手枪 | — |
| carbine | — | 制式卡宾枪 (common AR) | — |
| smg | — | 制式冲锋枪 | — |
| zhuge | 诸葛连弩 | extreme fire-rate SMG | `rapid` |
| qinggang | 青釭剑 | armor-piercing DMR | `pierceArmor` |
| cixiong | 雌雄双股剑 | dual pistols (akimbo) | `genderBonus` +40 % vs opposite gender |
| hanbing | 寒冰剑 | cryo rifle | `freeze` (slow stacks → freeze) |
| guding | 古锭刀 | combat shotgun with blade | `noArmorBonus` +50 % vs no-armor targets |
| qinglong | 青龙偃月刀 | assault rifle + crescent bayonet | `followUp` |
| zhangba | 丈八蛇矛 | serpent-blade pump shotgun | wide spread, 10 pellets |
| guanshi | 贯石斧 | grenade launcher | `forceHit` (splash ignores dodge) |
| zhuque | 朱雀羽扇 | phoenix flamethrower | `fireConvert` (burn) |
| fangtian | 方天画戟 | triple rocket launcher | `multiTarget` (3 rockets) |
| qilin | 麒麟弓 | anti-materiel sniper | `dismount`, 3.5× zoom |

Hero signature (non-lootable) variants: longdan (赵云 bayonet carbine), liegong (黄忠 sniper-bow),
jinfan (甘宁 dual SMGs with bells), xiaoji (孙尚香 compound bow, explosive arrows), taiping (张角
tesla staff, `chainLightning`), wushuang (吕布 heavy battle rifle), huben (许褚 LMG), qingnang
(华佗 dart pistol). Troop weapons (non-lootable): troop_rifle, troop_smg, troop_crossbow,
troop_shotgun, troop_melee, turret_smg.

## 7. Items — 三国杀 cards as consumables (`src/data/items.ts`)

Four item slots (keys 4–7). Basic cards: **杀** ammo box (refill 50 % reserve), **闪** +1 dodge
charge, **桃** medkit/revive, **酒** next hit ×2 (8 s) or self-revive when downed.
Tricks (锦囊): **无中生有** 2 random items · **过河拆桥** EMP grenade (strip armor/mount/shield) ·
**顺手牵羊** grapple-steal an item (8 m) · **决斗** tether duel 10 s (damage between you ×1.5, others
×0.5) · **借刀杀人** hack the target's troops/turret to attack their owner 6 s · **无懈可击** gain
`nullify` 20 s · **南蛮入侵** summon 5 barbarians (20 s) that attack everyone but you ·
**万箭齐发** arrow-rain on a point · **桃园结义** heal every hero within 15 m by 80 (enemies too) ·
**五谷丰登** burst 4 random items onto the ground around you · **火攻** incendiary grenade ·
**铁索连环** chain up to 3 targets.
Delayed tricks = deployables: **乐不思蜀** trap (dance 3 s) · **兵粮寸断** trap (root 2.5 s + lose
reserve ammo) · **闪电** storm cloud that wanders to the nearest hero (could be you!).
Utility: **征兵令** recruit 2 soldiers.
Armor: 八卦阵 (35 % bullet evade), 仁王盾 (−70 % bullet damage from the front 90°), 藤甲 (−40 %
bullets, immune to troop/NPC bullets, fire ×2), 白银狮子 (caps any single hit at 60; heals 100 when
removed). Mounts: offensive −1 马 赤兔/大宛/紫骍 (+30–40 % speed); defensive +1 马 的卢/绝影/爪黄飞电
(+15 % speed, −15 % damage taken). 麒麟弓 hits knock riders off.

## 8. Troops & NPCs (带兵)

- Squad size = `settings.troopsPerHero` (4) + hero `troopBonus` (+2 if Lord). Troop types by
  kingdom: 蜀 白毦兵 riflemen · 魏 虎豹骑 shield troopers (SMG, 120 HP) · 吴 解烦军 crossbow
  marksmen · 群 飞熊军 shotgun raiders. NPCs: 黄巾贼 (SMG), 黄巾力士 (melee brute), 南蛮勇士
  (spear rusher), 战象 (600 HP trampler), temporary militia/guards/crossbowmen from abilities.
- Orders: **Z 跟随** (wedge formation behind), **X 驻守** (hold the crosshair point),
  **C 进攻** (attack crosshair target, or attack-move to point), **V 冲锋** (free engage: hunt the
  nearest hostile within 40 m). **Middle mouse / B 标记** marks the crosshair enemy (troops focus).
- Hostility (identity-aware!): troops engage (a) anyone who damaged their commander or them in
  the last 10 s, (b) whatever their commander is shooting at / marked, (c) NPCs that aggro,
  (d) heroes whose **known** role is hostile to the commander's role (e.g. revealed rebels for the
  Lord's troops). They never attack heroes they have no reason to — this keeps the hidden-role
  tension. Troops don't respawn; recruit with 征兵令 / abilities.
- 黄巾 camps (4–6 bandits + bronze crate) guard the best early loot; they leash back home.

## 9. Map — 虎牢·赤壁 (`src/sim/map/`)

320 × 320 m, deterministic from `mapSeed`. Rolling terrain 0–25 m, impassable mountain rim.

- **洛阳宫城** (center): 80 × 80 m walled city, 4 gate towers, central palace (Lord spawn),
  streets with houses, 4 corner watchtowers, courtyard pavilions.
- **虎牢关** (north): pass between two ridges closed by a fortress wall with a gate tower.
- **赤壁** (south): an east-west river (water, slows 40 %, no sprint) with 3 bridges, docks and
  moored warships (walkable decks), braziers.
- **官渡大营** (east): military camp — tents, barricades, crate stacks, 黄巾 camp.
- **长坂坡** (west): hills + bamboo forest + farming village + 黄巾 camp.
- Scattered cover everywhere: rocks, trees, ruins, crate stacks, banners. 8+ spawn points ~110 m
  from the center. Named regions shown on the minimap.
- A walkability nav grid (2 m cells) for AI pathfinding (A* with line-of-sight smoothing).

## 10. Controls

| Key | Action |
|---|---|
| WASD / mouse | move / aim (pointer lock) |
| LMB / RMB | fire / aim down sights |
| R | reload |
| Shift | sprint |
| Space | jump |
| Ctrl / Alt | dodge roll (闪) — 2 charges (8 s recharge), i-frames 0.35 s |
| Q / E | abilities · **G** lord skill |
| F | interact: pick up / open crate / revive (hold) |
| 1 / 2 / wheel | primary / secondary weapon |
| 4 5 6 7 | use item slots |
| Z X C V | squad: follow / hold / attack / charge |
| B / MMB | mark target |
| T | quick-chat & 跳身份 wheel |
| Tab / M | scoreboard / big map |
| Enter | chat · Esc menu |

Touch (mobile): left virtual stick, right side drag = aim, buttons: fire, ADS, jump, dodge,
reload, Q, E, G, interact, item bar, squad button (cycles order). Auto-detected.

## 11. Netcode

- **Host-authoritative**: the host runs the sim at 30 Hz. The host player is local (zero latency).
- Clients send `InputFrame` at 30 Hz (unreliable channel; actions duplicated across the next 3
  frames with seq-based dedup so edge events survive loss).
- Host sends each client a `Snapshot` at 20 Hz (unreliable; binary-encoded, quantized) and all
  `GameEvent`s on the reliable channel.
- Clients render remote entities `INTERP_DELAY` (100 ms) in the past with interpolation; the local
  hero is **predicted** using the shared movement function from `sim/physics.ts`
  (`predictMove`) and reconciled with `ackSeq` + replay; small errors are smoothed.
- Local shots play muzzle/tracer/sound instantly; the host resolves hits with **lag
  compensation** (rewind hero/troop positions to `viewTick`, max 250 ms).
- Hidden information: snapshots never contain another player's role unless public.
- Transports (`src/net/`): `LoopbackTransport` (single player / tests), `PeerTransport`
  (PeerJS; host id `sgwl-<ROOM>`; configurable signalling server; ICE servers include
  China-reachable STUN: stun.miwifi.com, stun.chat.bilibili.com, stun.cloudflare.com, Google),
  `WsTransport` (relay through `server/server.mjs` rooms). Disconnected humans are replaced by bots;
  rejoining with the same name reclaims the seat.

## 12. Art direction

- Stylized low-poly "ink & gold" look: saturated kingdom colors, warm late-afternoon sun, soft
  ink-wash sky gradient + distant mountain silhouettes, atmospheric fog, bloom on fire/muzzle/
  lightning, subtle vignette. Chinese architecture: red pillars, grey tile curved roofs (upturned
  eaves), white walls, gold trims. Banners with kingdom glyphs (魏 蜀 吴 群).
- Characters: procedural, readable silhouettes built from primitives per `HeroVisual`
  (headgear, beard, cape, body type, extras such as 夏侯惇's eyepatch, 诸葛亮's fan, 许褚's bare
  chest). Height ≈ 1.8 m. Procedural animation (walk/run cycle, aim pose, recoil, reload, dodge
  roll, downed crawl, death ragdoll-ish fall, dance for 乐不思蜀). If `public/assets/heroes/<id>.glb`
  exists it replaces the procedural model (future AI-generated assets).
- Weapons: procedural guns fused with ancient ornaments (dragon heads, crescent blades, tassels,
  phoenix feathers) per `WeaponModelSpec`.
- Nameplates: hero name + player name, HP bar, crown for Lord, role badge when public, claim tag.
  Troops show a small kingdom-colored pennant; your own squad has a green chevron.

## 13. Audio

Procedural WebAudio (no files needed): per-weapon-class gunshots (noise bursts + filtered clicks),
explosions, fire crackle, thunder, sword swings, footsteps, UI clicks, heartbeat when downed, zone
warning horn, war drums (战鼓) + pentatonic guzheng/erhu-like synth music for menus & battle,
intensity rising with zone phase. 3D positional audio for world events. Master/music/sfx volume.

## 14. UI screens (`src/ui/`)

三国杀-inspired: parchment + ink + gold borders, red seal stamps, kingdom color frames, calligraphy
display font stack (`"STKaiti","KaiTi","Kaiti SC","楷体",serif`) — **no web fonts** (offline/China).
Screens: Title (animated), Lobby (seats, settings, room code + copy link, chat), Role reveal (card
flip), Hero select (cards with portrait render, abilities, kingdom), HUD (HP/shield bar, weapon +
ammo, ability icons with cooldown sweeps, item slots, dodge charges, squad panel with order,
minimap + zone, kill feed with role reveals, announcements, damage numbers, hit marker, crosshair
per weapon, downed overlay, spectate bar), Scoreboard (Tab), Big map (M), Pause/settings (Esc),
Game over, 武将图鉴 gallery (3D model turntable + skills), 玩法说明 (rules + controls), Settings
(language, sensitivity, FOV, volume, graphics quality, server config). Mobile touch overlay.

## 15. Testing requirements

- Unit (vitest): damage pipeline, statuses, win conditions for every role combo, rewards/penalties,
  zone schedule, map generator determinism + no spawn inside colliders, snapshot encode/decode,
  prediction reconciliation, flow (role dealing counts, hero options).
- Headless full match: 8 bots, fixed seed, runs to a valid `GameResult` within 15 sim-minutes.
- E2E (Playwright + swiftshader): title → single player → match renders (canvas non-blank), no
  console errors, HUD visible; two browser contexts join via the local server and see each other.
