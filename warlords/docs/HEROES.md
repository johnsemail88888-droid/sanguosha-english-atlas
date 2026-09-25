# 武将图鉴 · Hero Guide

> 三国杀·枪火乱世 (Sanguo Warlords) — 30 名武将的技能、数值与玩法。<br>
> All 30 heroes: abilities, numbers and how to play them.

<!-- Generated from src/data by tests/unit/data/heroes-doc.test.ts. Do not edit by hand: run `UPDATE_DOCS=1 npx vitest run tests/unit/data`. -->

## 读图须知 · How to read this guide

- **体力 HP** = 三国杀体力 × 100；主公（及影武者）额外 +100。<br>HP = the card game's health × 100; the Lord (and Body Double) get +100.
- **带兵 Squad** = 基础 4 名 + 武将加成（主公再 +2）。<br>Squad = 4 base soldiers + the hero's bonus (+2 more as Lord).
- **Q / E** 为主动技能，**G** 为主公技——只有真正的主公才能使用；“被动主公技”无需按键，主公身份时自动生效。<br>Q / E are active abilities; **G** is the lord skill and only works for the real Lord. A “passive lord skill” needs no key: it simply applies while you are the Lord.
- **伤害类型**：技能与锦囊伤害不算武器命中——八卦阵、仁王盾、藤甲的防弹效果只挡子弹，酒也只加倍武器命中；藤甲仍怕火，白银狮子仍限单次伤害（穿透伤害无视护甲）。<br>Ability and item damage is not a weapon hit: Bagua, Benevolent King Shield and Rattan Armor only stop bullets, and Wine only doubles weapon hits. Rattan still burns (fire ×2) and Silver Lion still caps single hits (piercing damage ignores armor).
- **敌人 / enemy** = 你、你的士兵与召唤物以外的任何单位（身份是隐藏的！）。“武将”范围效果对所有武将生效，包括敌人。<br>“Enemy” means any unit that is not you, your soldiers or your summons — roles are hidden! Area effects on “heroes” hit every hero, enemies included.
- **★** = 主公候选 Lord candidate · 难度 Difficulty ★☆☆ easy → ★★★ hard.
- 眩晕等硬控对武将最多 1.5 秒；召唤物都有时限。<br>Hard CC (stun) on heroes never exceeds 1.5 s; every summon is temporary.

## 武将一览 · Roster

| 势力 | 武将 Hero | 称号 Title | 体力 HP | 主武器 Weapon | 难度 |
|---|---|---|---|---|---|
| 蜀 | [刘备 Liu Bei](#刘备-liu-bei-) ★ | 乱世的枭雄 · Hero of a Chaotic Age | 4 | 雌雄双股 | ★☆☆ |
| 蜀 | [关羽 Guan Yu](#关羽-guan-yu) | 美髯公 · Lord of the Magnificent Beard | 4 | 青龙偃月 | ★☆☆ |
| 蜀 | [张飞 Zhang Fei](#张飞-zhang-fei) | 万夫不当 · Match for Ten Thousand | 4 | 丈八蛇矛 | ★☆☆ |
| 蜀 | [诸葛亮 Zhuge Liang](#诸葛亮-zhuge-liang) | 迟暮的丞相 · The Twilight Chancellor | 3 | 诸葛连弩 | ★★★ |
| 蜀 | [赵云 Zhao Yun](#赵云-zhao-yun) | 少年将军 · The Young General | 4 | 龙胆亮银枪 | ★★☆ |
| 蜀 | [马超 Ma Chao](#马超-ma-chao) | 一骑当千 · Rider Worth a Thousand | 4 | 虎头湛金枪 | ★☆☆ |
| 蜀 | [黄月英 Huang Yueying](#黄月英-huang-yueying) | 归隐的杰女 · The Reclusive Genius | 3 | 机关连弩 | ★★☆ |
| 蜀 | [黄忠 Huang Zhong](#黄忠-huang-zhong) | 老当益壮 · Vigorous in Old Age | 4 | 烈弓 | ★★☆ |
| 魏 | [曹操 Cao Cao](#曹操-cao-cao-) ★ | 魏武帝 · Martial Emperor of Wei | 4 | 倚天 | ★★☆ |
| 魏 | [司马懿 Sima Yi](#司马懿-sima-yi) | 狼顾之鬼 · The Wolf Who Looks Back | 3 | 寒冰 | ★★★ |
| 魏 | [夏侯惇 Xiahou Dun](#夏侯惇-xiahou-dun) | 独眼的罗刹 · The One-Eyed Rakshasa | 4 | 青釭 | ★☆☆ |
| 魏 | [张辽 Zhang Liao](#张辽-zhang-liao) | 前将军 · General of the Vanguard | 4 | 制式冲锋枪 | ★★☆ |
| 魏 | [许褚 Xu Chu](#许褚-xu-chu) | 虎痴 · The Tiger Fool | 4 | 虎贲机枪 | ★☆☆ |
| 魏 | [郭嘉 Guo Jia](#郭嘉-guo-jia) | 早终的先知 · The Prophet Taken Early | 3 | 制式卡宾枪 | ★★☆ |
| 魏 | [甄姬 Zhen Ji](#甄姬-zhen-ji) | 薄幸的美人 · The Ill-Fated Beauty | 3 | 制式冲锋枪 | ★★☆ |
| 魏 | [夏侯渊 Xiahou Yuan](#夏侯渊-xiahou-yuan) | 疾行的猎豹 · The Swift Leopard | 4 | 制式卡宾枪 | ★★☆ |
| 吴 | [孙权 Sun Quan](#孙权-sun-quan-) ★ | 年轻的贤君 · The Young Sage Ruler | 4 | 古锭 | ★★☆ |
| 吴 | [甘宁 Gan Ning](#甘宁-gan-ning) | 锦帆游侠 · The Brocade Sail Rover | 4 | 锦帆双铃 | ★★☆ |
| 吴 | [吕蒙 Lü Meng](#吕蒙-lü-meng) | 白衣渡江 · Crossing in White | 4 | 白衣 | ★★☆ |
| 吴 | [黄盖 Huang Gai](#黄盖-huang-gai) | 轻身为国 · Body Given for the Realm | 4 | 贯石 | ★★☆ |
| 吴 | [周瑜 Zhou Yu](#周瑜-zhou-yu) | 大都督 · The Grand Commander | 3 | 朱雀羽扇 | ★★★ |
| 吴 | [大乔 Da Qiao](#大乔-da-qiao) | 矜持之花 · The Reserved Blossom | 3 | 制式冲锋枪 | ★★☆ |
| 吴 | [陆逊 Lu Xun](#陆逊-lu-xun) | 儒生雄才 · The Scholar Hero | 3 | 制式冲锋枪 | ★★★ |
| 吴 | [孙尚香 Sun Shangxiang](#孙尚香-sun-shangxiang) | 弓腰姬 · The Bow-Waisted Princess | 3 | 枭姬弓 | ★★☆ |
| 群 | [华佗 Hua Tuo](#华佗-hua-tuo) | 神医 · The Divine Physician | 3 | 青囊药镖 | ★★☆ |
| 群 | [吕布 Lü Bu](#吕布-lü-bu) | 武的化身 · Avatar of War | 4 | 无双战铳 | ★☆☆ |
| 群 | [貂蝉 Diaochan](#貂蝉-diaochan) | 绝世的舞姬 · The Peerless Dancer | 3 | 雌雄双股 | ★★★ |
| 群 | [张角 Zhang Jiao](#张角-zhang-jiao-) ★ | 天公将军 · General of Heaven | 3 | 太平雷杖 | ★★☆ |
| 群 | [袁绍 Yuan Shao](#袁绍-yuan-shao-) ★ | 高贵的名门 · The Noble Scion | 4 | 制式卡宾枪 | ★☆☆ |
| 群 | [孟获 Meng Huo](#孟获-meng-huo) | 南蛮王 · King of the Nanman | 4 | 蛮王双管 | ★☆☆ |

## 蜀汉 · Shu Han

### 刘备 Liu Bei ★

*乱世的枭雄 · Hero of a Chaotic Age*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×1.00 | 白毦兵 White-Plume Rifleman ×6 | 雌雄双股 Yin-Yang Twin Pistols | ★☆☆ |

> 汉室宗亲，桃园结义之长兄。三顾茅庐请出诸葛亮，以仁德聚人心，终在乱世中建立蜀汉。
>
> A distant scion of the Han, eldest of the Peach Garden brothers. He won Zhuge Liang with three visits and built Shu Han on benevolence.

**定位 Role** — 团队核心：远程投送补给、插旗回复，治疗他人也能自愈；主公时召唤义军并为蜀将加速射击。<br>Team anchor: toss supplies, plant a healing banner and heal yourself by healing others; as Lord, summon militia and speed up Shu allies.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **仁德**<br>Benevolence<br><sub>三国杀：仁德</sub> | — | 你治疗其他武将时，自己回复治疗量的 30%；带兵 +2。<br>When you heal another hero, you also heal for 30% of that amount. Squad +2. |
| Q | **仁德·济民**<br>Relief Supplies<br><sub>三国杀：仁德</sub> | 12 s ×2 | 向准星处武将投掷补给：回复 80 并赠 1 张杀/闪/酒；12 秒内再投一次你回复 60。<br>Toss supplies to the hero under your crosshair: heal 80 + give 1 Strike/Dodge/Wine. A 2nd toss within 12 s heals you 60. |
| E | **蜀汉旌旗**<br>Banner of Han<br><sub>三国杀：仁德</sub> | 30 s | 插下军旗 10 秒：8 米内武将与你的士兵每秒回复 15，你的士兵伤害 +30%。<br>Plant a banner for 10 s: heroes and your soldiers within 8 m regen 15 HP/s; your soldiers deal +30% damage. |
| G<br>主公技 | **激将**<br>Rouse<br><sub>三国杀：激将</sub> | 45 s | 召集 4 名蜀汉义军（30 秒）；20 米内蜀国武将射速 ×1.3，持续 8 秒。<br>Summon 4 Shu militia for 30 s. Shu heroes within 20 m (you included) gain ×1.3 fire rate for 8 s. |

**台词 Quotes**

- 「惟贤惟德，能服于人。」 — *Only virtue and worth win hearts.*
- 「勿以恶小而为之，勿以善小而不为！」 — *Do no evil however small; neglect no good however slight!*
- 「汉室复兴，在此一举！」 — *The Han revival rides on this moment!*

### 关羽 Guan Yu

*美髯公 · Lord of the Magnificent Beard*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×0.97 | 白毦兵 White-Plume Rifleman ×4 | 青龙偃月 Green Dragon Rifle | ★☆☆ |

> 蜀汉五虎上将之首。温酒斩华雄、过五关斩六将，忠义之名千古传颂，后世尊为武圣。
>
> First of the Five Tiger Generals of Shu. He slew Hua Xiong before the wine cooled and crossed five passes alone; revered as the Saint of War.

**定位 Role** — 中近距离压制型战士：冲锋横扫打乱敌阵，用义绝锁定并击杀关键目标。<br>Mid-to-close bruiser: charge in and cleave through formations, then use Righteous Severance to lock down a key target.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **武圣**<br>Saint of War<br><sub>三国杀：武圣</sub><br><sub>近战伤害 · Melee damage</sub> | — | 近战、火焰、爆炸伤害 +25%；命中燃烧中的目标时追加 30 点近战斩击（1 秒冷却）。<br>Melee, fire and explosive damage +25%. Hitting a burning target adds a 30 melee slash (1 s cooldown). |
| Q | **青龙斩**<br>Green Dragon Cleave<br><sub>三国杀：武圣</sub><br><sub>近战伤害 · Melee damage</sub> | 9 s | 向前冲锋 8 米，横扫前方 110° 扇形 4.5 米：造成 90 近战伤害并击退。<br>Charge 8 m, then sweep a 110° arc (4.5 m): 90 melee damage and knockback. |
| E | **义绝**<br>Righteous Severance<br><sub>三国杀：义绝</sub> | 18 s | 准星处敌人 6 秒内无法使用技能与锦囊，且你对其伤害 +30%。<br>The enemy under your crosshair is silenced for 6 s and takes +30% damage from you. |

**台词 Quotes**

- 「关羽在此，尔等受死！」 — *Guan Yu is here — prepare to die!*
- 「吾观颜良，如插标卖首耳！」 — *Yan Liang? A head on a signpost, waiting to be taken!*
- 「青龙偃月，斩尽贼寇！」 — *Green Dragon, cut down every bandit!*

### 张飞 Zhang Fei

*万夫不当 · Match for Ten Thousand*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×0.97 | 白毦兵 White-Plume Rifleman ×4 | 丈八蛇矛 Serpent Spear Shotgun | ★☆☆ |

> 燕人张翼德，桃园三弟。长坂桥头一声断喝，吓退曹军百万；性烈如火，勇冠三军。
>
> Zhang Yide of Yan, youngest Peach Garden brother. One roar on Changban Bridge held off Cao Cao's host; fiery-tempered and bravest of all.

**定位 Role** — 近身爆发：开咆哮后霰弹枪无限连射，用断桥怒吼击退并定住追兵。<br>Close-range burst: Roar turns the shotgun into an ammo-free storm; the Bridge shout knocks back and stuns pursuers.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **蛇矛连击**<br>Serpent Flurry<br><sub>三国杀：咆哮</sub> | — | 霰弹枪换弹时间 -40%；击杀任意单位后 3 秒内射击不消耗弹药。<br>Shotgun reloads are 40% faster. Killing any unit grants 3 s of firing without using ammo. |
| Q | **咆哮**<br>Roar<br><sub>三国杀：咆哮</sub> | 22 s | 5 秒内射击不耗弹、射速 ×1.4；8 米内敌人减速 30%（2 秒）。<br>For 5 s: no ammo use and ×1.4 fire rate. Enemies within 8 m are slowed 30% for 2 s. |
| E | **据水断桥**<br>Thunder at the Bridge<br><sub>三国杀：咆哮</sub><br><sub>普通伤害 · Normal damage</sub> | 16 s | 向前 10 米 70° 怒吼：20 伤害并击退；士兵/NPC 眩晕 2 秒，武将 0.8 秒。<br>Roar in a 10 m, 70° cone: 20 damage + knockback. Stuns soldiers/NPCs for 2 s and heroes for 0.8 s. |

**台词 Quotes**

- 「燕人张翼德在此！」 — *Zhang Yide of Yan is here!*
- 「谁敢与我决一死战！」 — *Who dares fight me to the death?!*
- 「哇呀呀呀——！」 — *Waaaah—!*

### 诸葛亮 Zhuge Liang

*迟暮的丞相 · The Twilight Chancellor*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 3 (300) | ×1.00 | 白毦兵 White-Plume Rifleman ×4 | 诸葛连弩 Zhuge Repeater | ★★★ |

> 卧龙先生，蜀汉丞相。隆中对三分天下，草船借箭、空城退敌，鞠躬尽瘁，死而后已。
>
> The Sleeping Dragon, Chancellor of Shu. He foresaw the three-way split, borrowed arrows with straw boats and bluffed an army with an empty fort.

**定位 Role** — 控场军师：观星掌握敌情，八阵图封锁要道，危急时空城保命。<br>Control strategist: Stargazing scouts, the Maze locks down chokepoints, and Empty Fort saves you when caught.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **观星**<br>Stargazing<br><sub>三国杀：观星</sub> | — | 每 20 秒，45 米内其他武将对你显形 3 秒（仅你的小地图与描边可见）。<br>Every 20 s, other heroes within 45 m are revealed to you alone for 3 s (your minimap + outline). |
| Q | **八阵图**<br>Eight Trigrams Maze<br><sub>三国杀：八阵</sub> | 18 s | 在准星处布下 7 米石阵 8 秒：敌人减速 40% 并沉默；你与士兵获得 30% 闪避。<br>Raise a 7 m stone maze at the crosshair for 8 s: enemies are slowed 40% and silenced; you and your squad gain 30% evasion. |
| E | **空城**<br>Empty Fort<br><sub>三国杀：空城</sub> | 35 s | 抚琴 3 秒：无敌且无法被选中，不能攻击、移速 -30%；15 米内敌对士兵与 NPC 脱离仇恨。<br>Play the guqin 3 s: invulnerable and untargetable, but no attacks and 30% slower. Hostile soldiers/NPCs within 15 m lose aggro. |

**台词 Quotes**

- 「观今夜天象，知天下大事。」 — *Tonight's stars tell me the fate of the realm.*
- 「淡泊以明志，宁静以致远。」 — *Simplicity clarifies the will; serenity reaches afar.*
- 「鞠躬尽瘁，死而后已。」 — *I will give my all until my dying breath.*

### 赵云 Zhao Yun

*少年将军 · The Young General*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×1.05 | 白毦兵 White-Plume Rifleman ×4 | 龙胆亮银枪 Longdan Bayonet Carbine | ★★☆ |

> 常山赵子龙。长坂坡单骑救主，七进七出于百万曹军之中，先主赞其“一身是胆”。
>
> Zhao Zilong of Changshan. At Changban he rode alone through Cao Cao's host seven times to save his lord's son — "his whole body is courage."

**定位 Role** — 高机动突击手：三段冲刺与三次闪避穿梭战场，闪避后伤害提升，可冲去为队友套盾。<br>Mobile skirmisher: three dashes and three dodges to weave through fights, bonus damage after dodging, and a shield-dash to save a friend.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **龙胆**<br>Dragon Courage<br><sub>三国杀：龙胆</sub> | — | 闪避次数上限 3；每次闪避后 2.5 秒内武器伤害 +40%。<br>Up to 3 dodge charges. After each dodge, weapon damage +40% for 2.5 s. |
| Q | **七进七出**<br>Seven In, Seven Out<br><sub>三国杀：龙胆</sub><br><sub>近战伤害 · Melee damage</sub> | 14 s ×3 | 无敌冲刺 7 米，对穿过的敌人造成 40 近战伤害；可储存 3 次。<br>Invulnerable 7 m dash dealing 40 melee damage to enemies passed through. Holds 3 charges. |
| E | **长坂救主**<br>Rescue at Changban<br><sub>三国杀：龙胆</sub> | 24 s | 冲向准星处 20 米内的武将，你与其各获得 120 护盾 6 秒；无目标则仅自身获得。<br>Dash to the hero under your crosshair (20 m); you and they gain a 120 shield for 6 s. No target: shield only yourself. |

**台词 Quotes**

- 「吾乃常山赵子龙也！」 — *I am Zhao Zilong of Changshan!*
- 「龙战于野，其血玄黄！」 — *Dragons battle in the wild; their blood is black and yellow!*
- 「一身是胆，何惧之有！」 — *My whole body is courage — what is there to fear!*

### 马超 Ma Chao

*一骑当千 · Rider Worth a Thousand*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×1.00 | 白毦兵 White-Plume Rifleman ×4 | 虎头湛金枪 Tiger-Head Lance Rifle | ★☆☆ |

> 西凉锦马超，伏波将军马援之后。渭水一战杀得曹操割须弃袍，后归刘备，位列五虎。
>
> Splendid Ma Chao of Xiliang. At the Wei River he made Cao Cao cut his beard and shed his robe to escape; later one of Shu's Five Tigers.

**定位 Role** — 骑兵冲锋：常驻高移速，铁骑期间必中且破甲，冲锋撞开阵线。<br>Cavalry charger: permanent speed, undodgeable armor-piercing bursts, and a charge that bowls through lines.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **马术**<br>Horsemanship<br><sub>三国杀：马术</sub> | — | 始终骑乘西凉战马：移速 +20%（与坐骑不叠加，取较高者）。<br>Always rides a Xiliang warhorse: +20% move speed (does not stack with mounts; the higher applies). |
| Q | **铁骑**<br>Iron Cavalry<br><sub>三国杀：铁骑</sub> | 16 s | 6 秒内你的攻击无法被闪避且无视护甲，命中使目标沉默 1 秒。<br>For 6 s your attacks cannot be dodged and ignore armor; each hit silences the target for 1 s. |
| E | **西凉冲锋**<br>Xiliang Charge<br><sub>三国杀：铁骑</sub><br><sub>近战伤害 · Melee damage</sub> | 14 s | 策马冲锋 15 米，路径上的敌人受到 70 近战伤害并被击退。<br>Gallop 15 m forward: every enemy in your path takes 70 melee damage and is knocked back. |

**台词 Quotes**

- 「全军突击！」 — *All units, charge!*
- 「西凉铁骑，所向披靡！」 — *The Xiliang cavalry sweeps all before it!*
- 「曹贼，哪里走！」 — *Cao, you traitor — where do you think you're going!*

### 黄月英 Huang Yueying

*归隐的杰女 · The Reclusive Genius*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 3 (300) | ×1.00 | 白毦兵 White-Plume Rifleman ×4 | 机关连弩 Clockwork Repeater Crossbow | ★★☆ |

> 诸葛亮之妻，才貌兼备，精通机关之术。相传木牛流马与诸葛连弩皆出自她的巧思。
>
> Wife of Zhuge Liang and a master of mechanisms; legend credits her with the Wooden Ox and the repeating crossbow.

**定位 Role** — 阵地工程师：布置炮台守点，频繁使用锦囊刷新技能，奇才让火力网倍增。<br>Engineer: hold ground with turrets, chain items to refresh cooldowns, and overclock everything with Genius Inventor.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **集智**<br>Gathering Wisdom<br><sub>三国杀：集智</sub> | — | 每使用 1 个锦囊，你所有技能的剩余冷却 -3 秒。<br>Each item you use cuts 3 s off all your ability cooldowns. |
| Q | **木牛流马**<br>Wooden Ox Turret<br><sub>三国杀：木牛流马</sub> | 20 s | 在 6 米内部署自动炮台（200 生命，15 秒，机枪）；最多同时 2 座，超出时替换最早的。<br>Deploy an auto-turret within 6 m (200 HP, 15 s, turret gun). Up to 2 at once; extra ones replace the oldest. |
| E | **奇才**<br>Genius Inventor<br><sub>三国杀：奇才</sub> | 22 s | 6 秒内你的炮台与士兵射速 ×1.6，你的武器不消耗弹药。<br>For 6 s your turrets and soldiers fire ×1.6 faster and your weapon uses no ammo. |

**台词 Quotes**

- 「木牛流马，运粮如飞！」 — *Wooden oxen, gliding horses — supplies fly!*
- 「机关已备，请君入瓮。」 — *The mechanisms are set. Step right in.*
- 「哼，巧夺天工！」 — *Hmph — craftsmanship that rivals heaven!*

### 黄忠 Huang Zhong

*老当益壮 · Vigorous in Old Age*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 蜀 Shu | 4 (400) | ×0.95 | 白毦兵 White-Plume Rifleman ×4 | 烈弓 Liegong Sniper Bow | ★★☆ |

> 年近七旬仍勇冠三军，定军山阵斩夏侯渊，位列蜀汉五虎上将。
>
> Nearly seventy yet bravest in the army, he slew Xiahou Yuan at Mount Dingjun and joined the Five Tiger Generals.

**定位 Role** — 远程狙击：保持 30 米外距离输出必中伤害，百步穿杨一箭贯穿多人。<br>Long-range sniper: stay beyond 30 m for undodgeable bonus damage and skewer lines with the Hundred-Pace Shot.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **烈弓**<br>Fierce Bow<br><sub>三国杀：烈弓</sub> | — | 对 30 米外目标的攻击无法被闪避，且伤害 +25%。<br>Attacks against targets beyond 30 m cannot be dodged and deal +25% damage. |
| Q | **百步穿杨**<br>Hundred-Pace Shot<br><sub>三国杀：烈弓</sub><br><sub>穿透伤害 · Piercing damage</sub> | 12 s | 射出一支穿甲箭：140 伤害且无视护甲，最多穿透 3 个目标。<br>Loose an armor-piercing arrow: 140 damage that ignores armor, passing through up to 3 targets. |
| E | **老当益壮**<br>Old Soldier's Vigor<br><sub>三国杀：烈弓</sub> | 25 s | 回复 25% 最大生命，并获得 30% 加速 5 秒。<br>Heal 25% of your max HP and gain 30% haste for 5 s. |

**台词 Quotes**

- 「老夫虽老，尚能开弓！」 — *Old I may be, but I can still draw a bow!*
- 「百步之外，取尔首级！」 — *At a hundred paces I will take your head!*
- 「末将愿往！」 — *Let this general go!*

## 曹魏 · Cao Wei

### 曹操 Cao Cao ★

*魏武帝 · Martial Emperor of Wei*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 4 (400) | ×1.00 | 虎豹骑 Tiger-Leopard Trooper ×4 | 倚天 Heaven-Reliant DMR | ★★☆ |

> 挟天子以令诸侯，统一北方的一代枭雄。官渡以少胜多，唯才是举，诗文亦冠绝一时。
>
> He held the emperor hostage to command the lords and unified the north. Victor of Guandu, patron of talent, and a celebrated poet.

**定位 Role** — 以兵为盾：受伤转化护盾，驱使虎豹骑冲锋，主公时召唤亲卫并让部下替自己挡刀。<br>Army-as-shield: damage turns into shields, Tiger troopers charge on command, and as Lord his guards soak hits for him.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **奸雄**<br>Villainous Hero<br><sub>三国杀：奸雄</sub> | — | 受到武器伤害的 25% 转化为护盾（持续 5 秒，最多 100）。<br>25% of weapon damage you take becomes a shield for 5 s (max 100). |
| Q | **宁教我负天下人**<br>Betray the World<br><sub>三国杀：奸雄</sub> | 20 s | 6 秒内：士兵伤害 +50% 并冲向准星目标（无目标则自由冲锋），你获得 20% 吸血。<br>For 6 s your soldiers deal +50% damage and charge your crosshair target (none: charge freely); you gain 20% lifesteal. |
| E | **望梅止渴**<br>Plums Quench Thirst<br><sub>三国杀：奸雄</sub> | 25 s | 你的士兵生命回满，你回复 50；你与士兵获得 30% 加速 5 秒。<br>Fully heal your soldiers and heal yourself 50. You and your squad gain 30% haste for 5 s. |
| G<br>主公技 | **护驾**<br>Escort<br><sub>三国杀：护驾</sub> | 45 s | 召唤 3 名虎豹骑亲卫（30 秒）；6 秒内你受伤的 50% 转由 10 米内魏国单位承担。<br>Summon 3 Tiger Guards (30 s). For 6 s, 50% of damage you take is redirected to Wei units within 10 m. |

**台词 Quotes**

- 「宁教我负天下人，休教天下人负我！」 — *Better I betray the world than let the world betray me!*
- 「天下英雄，唯使君与操耳。」 — *The only true heroes under heaven are you and I.*
- 「吾好梦中杀人！」 — *I kill people in my sleep!*

### 司马懿 Sima Yi

*狼顾之鬼 · The Wolf Who Looks Back*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 3 (300) | ×1.00 | 虎豹骑 Tiger-Leopard Trooper ×4 | 寒冰 Frostbite Rifle | ★★★ |

> 魏国重臣，隐忍多谋，与诸葛亮数度对峙。高平陵之变一举夺权，为晋朝奠基。
>
> Wei's patient mastermind who outlasted Zhuge Liang, then seized power at Gaoping Tombs and laid the foundation of the Jin.

**定位 Role** — 反击型谋士：被打就偷锦囊，鬼才反弹子弹，狼顾揭露全场并加伤收割。<br>Counter-puncher: steal items from anyone who hits you, reflect bullets with Ghostly Talent, and expose everyone with Wolf's Glance.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **反馈**<br>Retaliation<br><sub>三国杀：反馈</sub> | — | 受到武将伤害时，偷取其 1 个随机锦囊（8 秒冷却）。<br>When a hero damages you, steal 1 random item from them (8 s cooldown). |
| Q | **鬼才**<br>Ghostly Talent<br><sub>三国杀：鬼才</sub><br><sub>普通伤害 · Normal damage</sub> | 16 s | 2.5 秒内受到的子弹伤害 -50%，并将原伤害的 100% 反弹给射手。<br>For 2.5 s, bullet damage you take is halved and 100% of the original is reflected back to the shooter. |
| E | **狼顾**<br>Wolf's Glance<br><sub>三国杀：狼顾</sub> | 20 s | 40 米内所有其他武将对你显形 5 秒（仅你可见）；期间你对它们伤害 +40%。<br>Reveal all other heroes within 40 m to you alone for 5 s. Meanwhile you deal +40% damage to them. |

**台词 Quotes**

- 「下次注意点。」 — *Be more careful next time.*
- 「天命？哈哈哈哈……」 — *The mandate of heaven? Hahaha…*
- 「吾乃天命之子！」 — *I am the child of destiny!*

### 夏侯惇 Xiahou Dun

*独眼的罗刹 · The One-Eyed Rakshasa*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 4 (400) | ×1.00 | 虎豹骑 Tiger-Leopard Trooper ×4 | 青釭 Qinggang Marksman Rifle | ★☆☆ |

> 曹操麾下元老。战吕布时左目中箭，拔矢啖睛：“父精母血，不可弃也！”
>
> Cao Cao's veteran general. Struck in the eye by an arrow, he pulled it out and ate the eye: "My parents' gift — I will not waste it!"

**定位 Role** — 反伤坦克：越挨打越痛的是对手，拔矢啖睛回血增伤，冲锋眩晕开团。<br>Thorns tank: attackers hurt themselves, Eat the Eye heals and empowers, and the charge stuns to start fights.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **刚烈**<br>Unyielding<br><sub>三国杀：刚烈</sub><br><sub>普通伤害 · Normal damage</sub> | — | 受到伤害时，将伤害的 30% 反弹给攻击者。<br>Whenever you take damage, 30% of it is dealt back to the attacker. |
| Q | **拔矢啖睛**<br>Eat the Eye<br><sub>三国杀：刚烈</sub> | 18 s | 回复已损失生命的 30%，6 秒内伤害 ×1.3。<br>Heal 30% of your missing HP and deal ×1.3 damage for 6 s. |
| E | **独目怒冲**<br>One-Eyed Charge<br><sub>三国杀：刚烈</sub><br><sub>近战伤害 · Melee damage</sub> | 16 s | 向前冲锋 12 米，撞到的首个武将受到 60 近战伤害并眩晕 1 秒。<br>Charge 12 m. The first hero you hit takes 60 melee damage and is stunned for 1 s. |

**台词 Quotes**

- 「父精母血，不可弃也！」 — *My parents' flesh and blood — I will not waste it!*
- 「以彼之道，还施彼身！」 — *I repay you in your own coin!*
- 「鼠辈，竟敢伤我！」 — *Rat! You dare wound me?!*

### 张辽 Zhang Liao

*前将军 · General of the Vanguard*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 4 (400) | ×1.03 | 虎豹骑 Tiger-Leopard Trooper ×4 | 制式冲锋枪 Service SMG | ★★☆ |

> 合肥之战率八百死士突袭十万吴军，威震逍遥津，令江东小儿闻“辽来”而不敢夜啼。
>
> At Hefei he led 800 men against 100,000 Wu troops; afterwards, Wu children stopped crying at night at the words "Liao is coming."

**定位 Role** — 刺客：突袭闪到背后偷锦囊、打背身加伤，威震逍遥津打断敌方技能与部队。<br>Assassin: blink behind targets to steal items and hit their backs for bonus damage; the Xiaoyao shout shuts down abilities and troops.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **辽来**<br>Liao Is Coming<br><sub>三国杀：突袭</sub> | — | 对背对你的目标伤害 +40%。<br>Deal +40% damage to targets facing away from you. |
| Q | **突袭**<br>Surprise Raid<br><sub>三国杀：突袭</sub> | 14 s | 闪至 12 米内准星目标身后，偷取 6 米内至多 2 名敌人各 1 个锦囊并减速 30%（2 秒）。<br>Blink behind the crosshair target (12 m). Steal 1 item from up to 2 enemies within 6 m and slow them 30% for 2 s. |
| E | **威震逍遥津**<br>Terror of Xiaoyao Ford<br><sub>三国杀：突袭</sub> | 20 s | 10 米内敌方武将沉默 2 秒并减速 30%，士兵与 NPC 眩晕 2.5 秒。<br>Enemy heroes within 10 m are silenced 2 s and slowed 30%; soldiers and NPCs are stunned for 2.5 s. |

**台词 Quotes**

- 「辽来了！」 — *Liao is coming!*
- 「张文远在此，谁敢一战！」 — *Zhang Wenyuan is here — who dares face me!*
- 「雁过拔毛！」 — *Nothing passes me without paying a toll!*

### 许褚 Xu Chu

*虎痴 · The Tiger Fool*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 4 (400) | ×0.92 | 虎豹骑 Tiger-Leopard Trooper ×5 | 虎贲机枪 Tiger Guard LMG | ★☆☆ |

> 曹操的贴身护卫，力大无穷。裸衣斗马超，勇猛如虎而憨直如痴，人称“虎痴”。
>
> Cao Cao's bodyguard of immense strength. He fought Ma Chao bare-chested; fierce as a tiger and simple as a fool — the Tiger Fool.

**定位 Role** — 重火力前排：机枪压制，裸衣爆发，跃起砸地击飞人群，且不会被击退。<br>Heavy frontliner: LMG suppression, Bare-Chested burst, a leaping slam that launches crowds, and immunity to knockback.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **虎痴**<br>Tiger Fool<br><sub>三国杀：裸衣</sub> | — | 免疫击退与击飞；带兵 +1。<br>Immune to knockback and knock-up. Squad +1. |
| Q | **裸衣**<br>Bare-Chested<br><sub>三国杀：裸衣</sub> | 20 s | 7 秒内伤害 ×1.5，但受到的伤害 ×1.25。<br>For 7 s deal ×1.5 damage but take ×1.25 damage. |
| E | **虎卫猛击**<br>Tiger Guard Slam<br><sub>三国杀：裸衣</sub><br><sub>近战伤害 · Melee damage</sub> | 14 s | 向前跃起 6 米砸地：6 米内敌人受到 80 近战伤害并被击飞。<br>Leap 6 m forward and slam down: enemies within 6 m take 80 melee damage and are knocked up. |

**台词 Quotes**

- 「谁来与我大战三百回合？」 — *Who will fight me three hundred rounds?*
- 「脱！」 — *Off comes the armor!*
- 「虎痴在此，谁敢近前！」 — *The Tiger Fool is here — come closer if you dare!*

### 郭嘉 Guo Jia

*早终的先知 · The Prophet Taken Early*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 3 (300) | ×1.00 | 虎豹骑 Tiger-Leopard Trooper ×4 | 制式卡宾枪 Service Carbine | ★★☆ |

> 曹操最倚重的谋士，算无遗策，十胜十败之论名垂青史。惜天妒英才，年仅三十八岁病逝。
>
> Cao Cao's most trusted adviser whose plans never missed. Heaven envied his genius: he died at just thirty-eight.

**定位 Role** — 补给军师：挨打反而得锦囊，遗计呼叫空投，鬼谋标记目标让全队集火。<br>Supply strategist: getting hit earns items, Legacy Stratagem calls supply drops, and Ghostly Scheme marks a target for focus fire.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **天妒**<br>Envy of Heaven<br><sub>三国杀：天妒</sub> | — | 单次受到至少 35 伤害时，获得 1 个随机锦囊并装满弹匣（5 秒冷却）。<br>When a single hit deals 35+ damage to you, gain 1 random item and refill your magazine (5 s cooldown). |
| Q | **遗计**<br>Legacy Stratagem<br><sub>三国杀：遗计</sub> | 20 s | 向 40 米内准星处呼叫补给空投，3 秒后落地，内含 2 个锦囊。<br>Call a supply drop at the crosshair (40 m). It lands after 3 s carrying 2 items. |
| E | **鬼谋**<br>Ghostly Scheme<br><sub>三国杀：遗计</sub> | 14 s | 标记准星处敌人 7 秒：其受到的所有伤害 +30% 并显形。<br>Mark the enemy under your crosshair for 7 s: it takes +30% damage from all sources and is revealed. |

**台词 Quotes**

- 「就这样吧。」 — *So be it.*
- 「也好。」 — *That works too.*
- 「锦囊妙计，尽在其中。」 — *Every clever plan is in these pouches.*

### 甄姬 Zhen Ji

*薄幸的美人 · The Ill-Fated Beauty*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 3 (300) | ×1.05 | 虎豹骑 Tiger-Leopard Trooper ×4 | 制式冲锋枪 Service SMG | ★★☆ |

> 三国第一美人，先嫁袁熙，后为曹丕之妻。曹植《洛神赋》相传即为她而作。
>
> Famed as the greatest beauty of the era, wed first to Yuan Xi, then to Cao Pi. Cao Zhi's "Ode to the Goddess of the Luo" is said to be about her.

**定位 Role** — 灵动游击：移动中闪避子弹，洛神赌锦囊，凌波微步闪现并留下减速冰霜。<br>Slippery skirmisher: dodge bullets on the move, gamble for items with Luo, and blink away leaving a slowing frost field.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **倾国**<br>Nation-Toppling Beauty<br><sub>三国杀：倾国</sub> | — | 移动中受到子弹攻击时，有 35% 几率完全闪避。<br>While moving, each incoming bullet has a 35% chance to be completely evaded. |
| Q | **洛神**<br>Goddess of the Luo<br><sub>三国杀：洛神</sub> | 16 s | 连续判定至多 4 次（60%/50%/40%/30%），每次成功得 1 个锦囊，失败即停。<br>Roll up to 4 times (60/50/40/30%); each success grants 1 item. Stops at the first failure. |
| E | **凌波微步**<br>Graceful Steps<br><sub>三国杀：倾国</sub><br><sub>穿透伤害 · Piercing damage</sub> | 12 s | 闪现 10 米：落点 4 米内敌人受 45 冰霜伤害并减速；原地留下 4 米冰霜区 4 秒，敌人减速 40%、每秒受 15 伤害。<br>Blink 10 m: 45 frost damage + slow within 4 m of the landing; the frost field left behind slows 40% and deals 15/s for 4 s. |

**台词 Quotes**

- 「仿佛兮若轻云之蔽月。」 — *Faint as the moon behind light clouds.*
- 「飘飖兮若流风之回雪。」 — *Drifting like snow whirled by the wind.*
- 「凌波微步，罗袜生尘。」 — *Treading the waves, my silk slippers raise dust.*

### 夏侯渊 Xiahou Yuan

*疾行的猎豹 · The Swift Leopard*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 魏 Wei | 4 (400) | ×1.00 | 虎豹骑 Tiger-Leopard Trooper ×4 | 制式卡宾枪 Service Carbine | ★★☆ |

> 曹操的族弟，用兵神速，“三日五百，六日一千”。定军山被黄忠阵斩。
>
> Cao Cao's kinsman, famed for lightning marches — "five hundred li in three days." He fell to Huang Zhong at Mount Dingjun.

**定位 Role** — 闪电突击：高移速且冲刺不断开镜，神速闪现立即齐射，虎步关右重置闪避再次切入。<br>Blitz attacker: flank fast while sprinting scoped, blink in with an instant volley, and reset dodges with Tiger Stride to go again.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **疾行**<br>Swift March<br><sub>三国杀：神速</sub> | — | 移速 +15%；冲刺时不会中断开镜瞄准。<br>+15% move speed. Sprinting does not break aim-down-sights. |
| Q | **神速**<br>Godspeed<br><sub>三国杀：神速</sub><br><sub>普通伤害 · Normal damage</sub> | 14 s | 闪现至 14 米内准星处，并立即向 30 米内最近的敌人齐射 5 发，每发 22 伤害。<br>Blink up to 14 m to the crosshair, then instantly volley 5 shots (22 damage each) at the nearest enemy within 30 m. |
| E | **虎步关右**<br>Tiger Stride<br><sub>三国杀：神速</sub> | 20 s | 获得 40% 加速 5 秒，并立即回满闪避次数。<br>Gain 40% haste for 5 s and instantly refill all dodge charges. |

**台词 Quotes**

- 「吾善于千里袭人！」 — *I excel at striking from a thousand li away!*
- 「取汝首级，犹如探囊取物！」 — *Taking your head is as easy as reaching into a bag!*
- 「疾如风，迅如电！」 — *Swift as wind, fast as lightning!*

## 东吴 · Eastern Wu

### 孙权 Sun Quan ★

*年轻的贤君 · The Young Sage Ruler*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 4 (400) | ×1.00 | 解烦军 Jiefan Marksman ×4 | 古锭 Guding Blade Shotgun | ★★☆ |

> 碧眼紫髯的东吴大帝。十九岁继承父兄基业，任用周瑜、陆逊，赤壁、夷陵两破强敌。
>
> The green-eyed, purple-bearded Emperor of Wu. Heir at nineteen, he trusted Zhou Yu and Lu Xun to win Red Cliffs and Yiling.

**定位 Role** — 资源调度：制衡刷新锦囊并瞬间换弹，随时征召援兵；主公时为吴军撑起减伤。<br>Resource juggler: Balance rerolls items and reloads instantly, recruits on demand, and as Lord shields the Wu line.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **权衡**<br>Deliberation<br><sub>三国杀：制衡</sub> | — | 所有武器换弹速度 +20%。<br>All your weapons reload 20% faster. |
| Q | **制衡**<br>Balance of Power<br><sub>三国杀：制衡</sub> | 24 s | 弃置所有锦囊，按所占格数 +1 重新获得；立即装满弹匣并回满闪避。<br>Discard all your items and draw 1 per slot they filled, +1. Instantly reload every weapon and refill your dodges. |
| E | **坐断东南**<br>Master of the Southeast<br><sub>三国杀：制衡</sub> | 35 s | 立即征召 2 名解烦军（最多超出带兵上限 2 名）。<br>Instantly recruit 2 Jiefan marksmen (up to 2 over your squad cap). |
| G<br>主公技 | **救援**<br>Rescue<br><sub>三国杀：救援</sub> | 40 s | 6 秒内你与 15 米内吴国单位受伤 -30%；范围内每名吴国武将（含你）使你每秒回复 10。<br>For 6 s you and Wu units within 15 m take 30% less damage; you regen 10 HP/s per Wu hero in range (you included). |

**台词 Quotes**

- 「容我三思。」 — *Let me think it over.*
- 「且慢，容我再想想。」 — *Wait — let me reconsider.*
- 「有汝辅佐，甚好！」 — *With you at my side, all is well!*

### 甘宁 Gan Ning

*锦帆游侠 · The Brocade Sail Rover*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 4 (400) | ×1.00 | 解烦军 Jiefan Marksman ×4 | 锦帆双铃 Brocade Bell SMGs | ★★☆ |

> 少时为锦帆贼，腰悬铜铃横行江上。归吴后率百骑夜袭曹营，无一伤亡。
>
> Once the "Brocade Sail" river pirate, bells at his waist. For Wu he raided Cao Cao's camp at night with a hundred riders and lost none.

**定位 Role** — 突袭游侠：潜行摸营，电磁弩打掉敌人装备，连杀不断弹。<br>Raider: sneak in with your squad, strip gear with the EMP bolt, and keep the kills (and magazines) flowing.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **锦帆**<br>Brocade Sails<br><sub>三国杀：奇袭</sub> | — | 移速 +10%；击杀任意单位后立即装满弹匣。<br>+10% move speed. Killing any unit instantly refills your magazine. |
| Q | **奇袭**<br>EMP Raid<br><sub>三国杀：奇袭</sub> | 18 s | 向准星处敌人射出电磁弩：其护甲与坐骑被震飞（5 秒内无法拾回）、护盾清空，并沉默 2.5 秒。<br>EMP bolt at the crosshair enemy: its armor and mount are knocked away (no pick-up for 5 s), shield cleared, silenced 2.5 s. |
| E | **百骑劫营**<br>Hundred Riders Raid<br><sub>三国杀：奇袭</sub> | 28 s | 你与士兵潜行 8 秒；潜行中的首轮攻击（至多 1 秒连射）伤害 +60%。<br>You and your squad turn stealthy for 8 s. Your first attack from stealth (a burst of up to 1 s) deals +60% damage. |

**台词 Quotes**

- 「锦帆游侠甘兴霸在此！」 — *Gan Xingba of the Brocade Sails is here!*
- 「接招吧！」 — *Take this!*
- 「百骑劫魏营，片甲不留！」 — *A hundred riders raid the Wei camp — nothing left standing!*

### 吕蒙 Lü Meng

*白衣渡江 · Crossing in White*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 4 (400) | ×1.02 | 解烦军 Jiefan Marksman ×4 | 白衣 White-Robe Suppressed DMR | ★★☆ |

> “士别三日，当刮目相待”。白衣渡江偷袭荆州，一举擒获关羽，东吴大都督。
>
> "After three days apart, look at a scholar with new eyes." He crossed the river disguised in white, took Jing Province and captured Guan Yu.

**定位 Role** — 潜伏猎手：耐心等待进入潜行，用消音步枪与攻心打出致命首轮。<br>Patient hunter: wait for stealth, then open with the suppressed DMR and Mind Assault for a lethal first volley.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **克己**<br>Self-Restraint<br><sub>三国杀：克己</sub> | — | 5 秒未开火且未受伤则进入潜行（最长 8 秒），开火或受伤即解除。<br>After 5 s without firing or taking damage, turn stealthy (up to 8 s). Firing or taking damage breaks it. |
| Q | **白衣渡江**<br>Crossing in White<br><sub>三国杀：克己</sub> | 18 s | 潜行 6 秒并获得 30% 加速；开火解除潜行。<br>Turn stealthy for 6 s with 30% haste. Firing breaks stealth. |
| E | **攻心**<br>Mind Assault<br><sub>三国杀：攻心</sub> | 18 s | 准星处敌人被缴械 2 秒，并被你偷取 1 个锦囊。<br>Disarm the enemy under your crosshair for 2 s and steal 1 item from it. |

**台词 Quotes**

- 「士别三日，当刮目相待！」 — *After three days apart, look at me with new eyes!*
- 「白衣渡江，兵不血刃！」 — *Crossing in white — victory without bloodshed!*
- 「克己复礼，方能成事。」 — *Restraint and discipline bring success.*

### 黄盖 Huang Gai

*轻身为国 · Body Given for the Realm*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 4 (400) | ×0.97 | 解烦军 Jiefan Marksman ×4 | 贯石 Guanshi Grenade Launcher | ★★☆ |

> 东吴三朝老将。赤壁之战献苦肉计诈降，率火船焚毁曹军连环战船。
>
> A veteran of three Wu lords. At Red Cliffs he took a flogging to fake a defection, then rammed Cao Cao's chained fleet with fire ships.

**定位 Role** — 以血换火：苦肉换锦囊与射速，残血时火焰爆炸更痛，火船一击清场。<br>Blood for fire: trade HP for items and fire rate, hit harder when low, and clear crowds with the fire ship.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **赤胆**<br>Burning Loyalty<br><sub>三国杀：苦肉</sub> | — | 生命低于 50% 时，你的火焰与爆炸伤害 +30%。<br>Below 50% HP, your fire and explosive damage is +30%. |
| Q | **苦肉**<br>Self-Injury<br><sub>三国杀：苦肉</sub> | 16 s | 失去 40 生命，获得 2 个锦囊并射速 ×1.4 持续 5 秒（生命需高于 40）。<br>Lose 40 HP to gain 2 items and ×1.4 fire rate for 5 s. Requires more than 40 HP. |
| E | **诈降火船**<br>Fire Ship Gambit<br><sub>三国杀：苦肉</sub><br><sub>火焰伤害 · Fire damage</sub> | 22 s | 火船无人机（12 米/秒）触碰或 3 秒后爆炸：6 米内 120 火焰伤害，留下 3 米火海 5 秒（每秒 15）。<br>Launch a fire-ship drone (12 m/s) that explodes on contact or after 3 s: 120 fire damage in 6 m + a 3 m fire field (15/s, 5 s). |

**台词 Quotes**

- 「请鞭挞我吧，公瑾！」 — *Flog me, Gongjin!*
- 「赴汤蹈火，在所不辞！」 — *Through boiling water and fire, I will not refuse!*
- 「火船已至，曹贼休走！」 — *The fire ships are here — no escape for Cao!*

### 周瑜 Zhou Yu

*大都督 · The Grand Commander*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 3 (300) | ×1.00 | 解烦军 Jiefan Marksman ×4 | 朱雀羽扇 Vermilion Phoenix Flamer | ★★★ |

> “美周郎”，精通音律，二十四岁拜建威中郎将。赤壁之战以火攻大破曹操八十万大军。
>
> "Handsome Zhou," a master musician and general at twenty-four. At Red Cliffs his fire attack shattered Cao Cao's vast armada.

**定位 Role** — 火攻指挥：喷火器近战压制，反间制造混乱，火烧赤壁封锁整条战线。<br>Fire commander: the flamer controls close range, Sow Discord creates chaos, and the Red Cliffs strike burns a whole front.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **英姿**<br>Heroic Bearing<br><sub>三国杀：英姿</sub> | — | 换弹速度 +25%；技能冷却 -20%。<br>Reload 25% faster. Ability cooldowns -20%. |
| Q | **反间**<br>Sow Discord<br><sub>三国杀：反间</sub> | 18 s | 魅惑准星处敌人 3 秒：它攻击 30 米内离它最近、它看得见的另一名武将（不会是你）；若无则缴械它 3 秒。<br>Charm the crosshair enemy for 3 s: it attacks the nearest other hero it can see within 30 m (never you). None: disarm it 3 s. |
| E | **火烧赤壁**<br>Red Cliffs Inferno<br><sub>三国杀：英姿</sub><br><sub>火焰伤害 · Fire damage</sub> | 24 s | 1.5 秒后沿前方 25 米直线投下 5 枚凝固汽油弹：110 火焰伤害，燃烧地面 6 秒（每秒 18）。<br>After 1.5 s, 5 napalm bombs hit a 25 m line ahead: 110 fire damage and burning ground for 6 s (18/s). |

**台词 Quotes**

- 「挣扎吧，在血和暗的深渊里！」 — *Struggle, in the abyss of blood and darkness!*
- 「既生瑜，何生亮！」 — *Heaven made Yu — why did it also make Liang?!*
- 「谈笑间，樯橹灰飞烟灭。」 — *Amid laughter, masts and oars turn to ash.*

### 大乔 Da Qiao

*矜持之花 · The Reserved Blossom*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 3 (300) | ×1.03 | 解烦军 Jiefan Marksman ×4 | 制式冲锋枪 Service SMG | ★★☆ |

> 江东二乔之姐，国色天香，嫁与“小霸王”孙策。
>
> Elder of the famed Qiao sisters of Jiangdong, a peerless beauty who married Sun Ce, the "Little Conqueror."

**定位 Role** — 辅助控制：流离把伤害甩给身边的人，国色让敌人跳舞，安娴群体治疗。<br>Support-control: Displacement shunts damage onto others, National Beauty makes enemies dance, and Serenity heals the group.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **流离**<br>Displacement<br><sub>三国杀：流离</sub> | — | 被子弹击中时，35% 几率将该伤害转移给 8 米内你看得见的另一单位（优先敌人，己方士兵最后，攻击者除外）。<br>When hit by a bullet, 35% chance to pass it to a unit in sight within 8 m: enemies first, your soldiers last, never the attacker. |
| Q | **国色**<br>National Beauty<br><sub>三国杀：国色</sub> | 14 s | 向 25 米内准星处敌人掷出乐不思蜀：其跳舞 3 秒，无法射击与使用技能。<br>Throw Indulgence at the crosshair enemy (25 m): it dances for 3 s, unable to shoot or use abilities. |
| E | **安娴**<br>Serenity<br><sub>三国杀：安娴</sub> | 15 s | 为你、你的士兵及 8 米内其他武将回复 90 生命。<br>Heal yourself, your soldiers and other heroes within 8 m for 90. |

**台词 Quotes**

- 「请休息吧。」 — *Please, have a rest.*
- 「你来嘛～」 — *Come on over~*
- 「江东之花，岂容轻侮。」 — *The flower of Jiangdong is not to be slighted.*

### 陆逊 Lu Xun

*儒生雄才 · The Scholar Hero*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 3 (300) | ×1.02 | 解烦军 Jiefan Marksman ×4 | 制式冲锋枪 Service SMG | ★★★ |

> 书生拜将，夷陵之战火烧连营七百里，大破刘备，以谦逊隐忍著称。
>
> A scholar made general, he burned Liu Bei's camps for seven hundred li at Yiling — famed for modesty and patience.

**定位 Role** — 火海法师：连营几乎不用换弹，火烧连营封路，燎原让火势蔓延；免疫魅惑与偷取。<br>Fire mage: Continuous Camps barely reloads, Burning Camps walls off paths, Wildfire spreads the flames; immune to charm and theft.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **谦逊**<br>Modesty<br><sub>三国杀：谦逊</sub> | — | 免疫魅惑、乐不思蜀（跳舞）与偷取。<br>Immune to charm, dance (Indulgence) and item theft. |
| 被动<br>Passive | **连营**<br>Continuous Camps<br><sub>三国杀：连营</sub> | — | 弹匣打空时立即从备弹装填半个弹匣（5 秒冷却）。<br>When your magazine empties, instantly load half a magazine from reserve (5 s cooldown). |
| Q | **火烧连营**<br>Burning Camps<br><sub>三国杀：连营</sub><br><sub>火焰伤害 · Fire damage</sub> | 14 s | 沿前方铺下 5 片火海（间隔 4 米，半径 2.5 米，5 秒，每秒 20 伤害）。<br>Lay 5 fire fields in a line ahead (4 m apart, 2.5 m radius, 5 s, 20 damage/s). |
| E | **燎原**<br>Wildfire<br><sub>三国杀：连营</sub> | 24 s | 6 秒内射击不消耗弹药；你的火海半径 ×1.5 并刷新持续时间。<br>For 6 s your shots use no ammo. Your fire fields grow ×1.5 in radius and refresh their duration. |

**台词 Quotes**

- 「牌不是万能的，但是没牌是万万不能的。」 — *Cards aren't everything — but without cards you have nothing.*
- 「火烧连营，片甲不留！」 — *Burn the camps — leave nothing standing!*
- 「谦谦君子，温润如玉。」 — *A modest gentleman, gentle as jade.*

### 孙尚香 Sun Shangxiang

*弓腰姬 · The Bow-Waisted Princess*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 吴 Wu | 3 (300) | ×1.05 | 解烦军 Jiefan Marksman ×4 | 枭姬弓 Xiaoji Blast Bow | ★★☆ |

> 孙权之妹，自幼好武，侍婢百余人皆执刀侍立。嫁与刘备，被称为“弓腰姬”。
>
> Sun Quan's martial sister, attended by a hundred armed maids. She married Liu Bei and was called the Bow-Waisted Princess.

**定位 Role** — 爆发射手：爆炸箭扇形齐射，逆境中枭姬补给，结姻为男性队友与自己回血。<br>Burst archer: fan out explosive arrows, recover with Warrior Princess when things go wrong, and heal with a male partner.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **枭姬**<br>Warrior Princess<br><sub>三国杀：枭姬</sub> | — | 失去护甲/坐骑或生命跌破 50% 时：加速 30% 3 秒、弹药全满并得 1 个锦囊（20 秒冷却）。<br>On losing armor/mount or dropping below 50% HP: 30% haste for 3 s, full ammo and 1 item (20 s cooldown). |
| Q | **结姻**<br>Marriage Bond<br><sub>三国杀：结姻</sub> | 16 s | 为准星处的男性武将与你各回复 100 生命。<br>Heal yourself and the male hero under your crosshair for 100 each. |
| E | **弓腰姬**<br>Arrow Fan<br><sub>三国杀：枭姬</sub><br><sub>爆炸伤害 · Explosive damage</sub> | 14 s | 扇形射出 5 支爆炸箭：每支命中 30 爆炸伤害，并在 2 米内爆炸造成 20 伤害。<br>Fire 5 explosive arrows in a 30° fan: 30 explosive damage per hit plus a 20-damage blast (2 m). |

**台词 Quotes**

- 「夫君，身体要紧。」 — *Husband, take care of yourself.*
- 「弓马娴熟，岂输男儿？」 — *Skilled with bow and horse — am I any less than a man?*
- 「哼！」 — *Hmph!*

## 群雄 · Warlords

### 华佗 Hua Tuo

*神医 · The Divine Physician*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 3 (300) | ×1.00 | 飞熊军 Flying Bear Raider ×4 | 青囊药镖 Qingnang Dart Pistol | ★★☆ |

> 东汉末年神医，发明麻沸散，擅长外科手术。欲为曹操开颅治疾，反遭猜忌下狱而死。
>
> The legendary surgeon who invented the anesthetic mafeisan. He offered to open Cao Cao's skull to cure him and died in prison for it.

**定位 Role** — 战地医生：救人极快且可免桃救人，青囊远程治疗并驱散，药镖吸血自保，麻沸散群体眩晕。<br>Combat medic: lightning-fast (even Peach-free) revives, Green Satchel heals and cleanses at range, darts heal you, and the gas stuns groups.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **急救**<br>First Aid<br><sub>三国杀：急救</sub> | — | 救起濒死者只需 0.5 秒且额外回复 80；每 30 秒可不消耗桃救人一次。<br>Revives take only 0.5 s and restore 80 extra HP. Once every 30 s you can revive without a Peach. |
| Q | **青囊**<br>Green Satchel<br><sub>三国杀：青囊</sub> | 14 s | 准星处武将（无则自己）3 秒内回复 150，并解除所有负面状态。<br>Heal the hero under your crosshair (or yourself) for 150 over 3 s and cleanse all debuffs. |
| E | **麻沸散**<br>Anesthetic Gas<br><sub>三国杀：青囊</sub> | 22 s | 向准星处投掷麻醉毒气（5 米）：敌人眩晕 1.2 秒，随后减速 40% 持续 4 秒。<br>Throw an anesthetic gas grenade (5 m) at the crosshair: enemies are stunned 1.2 s, then slowed 40% for 4 s. |

**台词 Quotes**

- 「救人一命，胜造七级浮屠。」 — *Saving a life beats building a seven-story pagoda.*
- 「早睡早起，方能养生。」 — *Early to bed, early to rise — that's the way to health.*
- 「越老越要补啊。」 — *The older you get, the more you need your tonics.*

### 吕布 Lü Bu

*武的化身 · Avatar of War*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 4 (400) | ×1.00 | 飞熊军 Flying Bear Raider ×4 | 无双战铳 Peerless Battle Rifle | ★☆☆ |

> “人中吕布，马中赤兔”。辕门射戟解围，虎牢关独战三英，天下无双而反复无常。
>
> "Among men, Lü Bu; among horses, Red Hare." He shot the halberd at the camp gate and fought three heroes at once at Hulao — peerless and faithless.

**定位 Role** — 纯粹的杀戮机器：一切伤害必中，画戟旋斩清场，辕门射戟远程眩晕点杀。<br>Pure killing machine: all damage is undodgeable, the halberd spin clears space, and the long shot stuns from range.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **无双**<br>Peerless<br><sub>三国杀：无双</sub> | — | 你的伤害无法被闪避，且无视目标 50% 的护盾；骑乘赤兔，移速 +15%。<br>Your damage cannot be dodged and ignores 50% of shields. Rides Red Hare: +15% move speed. |
| Q | **方天画戟**<br>Sky Piercer Sweep<br><sub>三国杀：无双</sub><br><sub>近战伤害 · Melee damage</sub> | 10 s | 挥舞方天画戟旋斩 5 米：造成 110 近战伤害并击退。<br>Spin the Sky Piercer halberd (5 m): 110 melee damage and knockback. |
| E | **辕门射戟**<br>Shot at the Camp Gate<br><sub>三国杀：无双</sub><br><sub>普通伤害 · Normal damage</sub> | 16 s | 射出精准长弹：命中的首个目标受到 140 伤害并眩晕 1 秒。<br>Fire a precise long shot: the first target hit takes 140 damage and is stunned for 1 s. |

**台词 Quotes**

- 「谁能挡我！」 — *Who can stop me!*
- 「神挡杀神，佛挡杀佛！」 — *Gods or buddhas — whoever blocks me dies!*
- 「人中吕布，马中赤兔！」 — *Among men, Lü Bu; among horses, Red Hare!*

### 貂蝉 Diaochan

*绝世的舞姬 · The Peerless Dancer*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 3 (300) | ×1.05 | 飞熊军 Flying Bear Raider ×4 | 雌雄双股 Yin-Yang Twin Pistols | ★★★ |

> 司徒王允的义女，美貌令明月躲进云中。以连环计离间董卓与吕布，使吕布手刃董卓。
>
> Wang Yun's adopted daughter, so lovely the moon hid behind the clouds. Her Chain Stratagem turned Lü Bu against Dong Zhuo.

**定位 Role** — 心理战高手：离间让敌人自相残杀，连环计为火雷队友创造连锁，脱战后自动回血。<br>Mind games: Sow Dissension turns enemies on each other, Chain Stratagem sets up fire/thunder combos, and she regenerates out of combat.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **闭月**<br>Moon Eclipse<br><sub>三国杀：闭月</sub> | — | 5 秒未受伤后，每秒回复 5 生命。<br>After 5 s without taking damage, regenerate 5 HP/s. |
| Q | **离间**<br>Sow Dissension<br><sub>三国杀：离间</sub> | 22 s | 魅惑准星处敌人及其 15 米内最近的另一名武将 2.5 秒，令二者互相攻击。<br>Charm the crosshair enemy and the nearest other hero within 15 m of it for 2.5 s; they attack each other. |
| E | **连环计**<br>Chain Stratagem<br><sub>三国杀：离间</sub> | 20 s | 连环准星处敌人及其 8 米内至多 2 名敌人 8 秒：减速 25%，火焰与雷电伤害相互传导。<br>Chain the crosshair enemy and up to 2 enemies within 8 m for 8 s: slowed 25%; fire and thunder damage spreads. |

**台词 Quotes**

- 「嗯呵呵～呵呵～」 — *Mm-hehe~ hehe~*
- 「失礼了～」 — *Pardon me~*
- 「将军，何不为妾身一战？」 — *General, won't you fight for me?*

### 张角 Zhang Jiao ★

*天公将军 · General of Heaven*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 3 (300) | ×0.98 | 飞熊军 Flying Bear Raider ×4 | 太平雷杖 Taiping Tesla Staff | ★★☆ |

> 太平道创始人，自称“天公将军”。以“苍天已死，黄天当立”为号，发动黄巾起义。
>
> Founder of the Way of Peace, the self-styled General of Heaven who launched the Yellow Turban Rebellion: "The blue sky is dead; the yellow sky shall rise!"

**定位 Role** — 雷法术士：特斯拉法杖跳跃电击，雷击先定身再连劈，雷云追踪目标；主公时召唤黄巾力士。<br>Storm caster: the tesla staff arcs between targets, Lightning Strike stuns then keeps striking, the storm cloud hunts a target, and as Lord he summons warriors.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **鬼道**<br>Ghostly Way<br><sub>三国杀：鬼道</sub> | — | 你造成的雷电伤害 +30%。<br>Your thunder damage is +30%. |
| Q | **雷击**<br>Lightning Strike<br><sub>三国杀：雷击</sub><br><sub>雷电伤害 · Thunder damage</sub> | 15 s | 在准星处连降 3 道落雷（间隔 0.6 秒），每道 3 米内 42 雷电伤害；首道眩晕 0.5 秒。<br>Call 3 lightning bolts at the crosshair, 0.6 s apart: 42 thunder damage each in 3 m; the first bolt stuns 0.5 s. |
| E | **太平要术**<br>Way of Peace<br><sub>三国杀：雷击</sub><br><sub>雷电伤害 · Thunder damage</sub> | 26 s | 雷云跟随准星处敌人 8 秒，每 1.5 秒劈下 35 雷电伤害（2.5 米）。<br>A storm cloud follows the crosshair enemy for 8 s, striking every 1.5 s for 35 thunder damage (2.5 m). |
| G<br>主公技 | **黄天**<br>Yellow Heaven<br><sub>三国杀：黄天</sub> | 45 s | 召唤 5 名黄巾力士为你作战，持续 30 秒。<br>Summon 5 Yellow Turban Warriors to fight for you for 30 s. |

**台词 Quotes**

- 「苍天已死，黄天当立！」 — *The blue sky is dead — the yellow sky shall rise!*
- 「岁在甲子，天下大吉！」 — *In the year of Jiazi, great fortune for all under heaven!*
- 「雷公助我！」 — *Lord of Thunder, aid me!*

### 袁绍 Yuan Shao ★

*高贵的名门 · The Noble Scion*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 4 (400) | ×0.97 | 飞熊军 Flying Bear Raider ×5 | 制式卡宾枪 Service Carbine | ★☆☆ |

> 四世三公的名门之后，讨董联军盟主，一度雄踞河北，官渡之战败于曹操。
>
> Heir of a family that produced top ministers for four generations; leader of the coalition against Dong Zhuo, he ruled the north until Guandu.

**定位 Role** — 人海统帅：士兵更多更耐打，召唤弩手、箭雨覆盖；主公时再多带 1 兵，并按群雄同僚人数提升体力上限。<br>Army commander: more and tougher soldiers, summoned crossbowmen and arrow rain; as Lord, 1 more soldier and bonus max HP per fellow Qun hero.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **名门**<br>Noble Lineage<br><sub>三国杀：血裔</sub> | — | 带兵 +1；你的士兵最大生命 +20%。<br>Squad +1. Your soldiers have +20% max HP. |
| Q | **乱击**<br>Chaotic Volley<br><sub>三国杀：乱击</sub><br><sub>普通伤害 · Normal damage</sub> | 16 s | 向准星处 10 米范围倾泻箭雨 3 秒，每 0.5 秒造成 16 伤害。<br>Rain arrows on a 10 m area at the crosshair for 3 s: 16 damage every 0.5 s. |
| E | **四世三公**<br>Four Generations of Nobility<br><sub>三国杀：乱击</sub> | 35 s | 召唤 4 名袁军弩手为你作战，持续 25 秒。<br>Summon 4 Yuan crossbowmen to fight for you for 25 s. |
| 被动主公技<br>Passive lord skill | **血裔**<br>Noble Bloodline<br><sub>三国杀：血裔</sub> | — | 被动主公技：每名存活的其他群雄武将使你最大生命 +50（至多 3 名）；带兵再 +1。<br>Passive lord skill: +50 max HP per other living Qun hero (max 3). Squad +1 more. |

**台词 Quotes**

- 「弓箭手，准备放箭！」 — *Archers — ready your volley!*
- 「四世三公，谁敢不从！」 — *Four generations of nobility — who dares disobey!*
- 「全都去死吧！」 — *Die, all of you!*

### 孟获 Meng Huo

*南蛮王 · King of the Nanman*

| 势力 Kingdom | 体力 HP | 移速 Speed | 带兵 Squad | 主武器 Signature weapon | 难度 Difficulty |
|---|---|---|---|---|---|
| 群 Qun | 4 (400) | ×0.95 | 飞熊军 Flying Bear Raider ×4 | 蛮王双管 Barbarian King Double-Barrel | ★☆☆ |

> 南中蛮王，七擒七纵后终被诸葛亮收服：“丞相天威，南人不复反矣。”
>
> King of the southern Nanman, captured and released seven times by Zhuge Liang until he swore: "The south will never rebel again."

**定位 Role** — 蛮王冲阵：召唤南蛮勇士与战象碾压敌阵，自己双管近身轰击，倒地还能再起。<br>Barbarian warlord: flood the field with warriors and a war elephant, blast up close with the double-barrel, and rise again once when downed.

| 键 Key | 技能 Ability | 冷却 CD | 效果 Effect |
|---|---|---|---|
| 被动<br>Passive | **祸首**<br>Chief Culprit<br><sub>三国杀：祸首</sub> | — | 南蛮单位（含南蛮入侵召唤物与战象）不会攻击你，也无法伤害你。<br>Barbarian units (including Barbarian Invasion summons and war elephants) never attack or damage you. |
| 被动<br>Passive | **再起**<br>Resurgence<br><sub>三国杀：再起</sub> | — | 每局一次：进入濒死时立即以 50% 生命站起。<br>Once per match: when downed, instantly get back up with 50% HP. |
| Q | **南蛮入侵**<br>Barbarian Invasion<br><sub>三国杀：祸首</sub> | 30 s | 召唤 4 名南蛮勇士（15 秒）冲向准星处。<br>Summon 4 barbarian warriors (15 s) that rush the crosshair point. |
| E | **象兵**<br>Elephant Corps<br><sub>三国杀：祸首</sub><br><sub>近战伤害 · Melee damage</sub> | 35 s | 战象向前冲锋 30 米，践踏路径上的敌人：100 近战伤害并击退；之后作战 12 秒。<br>A war elephant charges 30 m ahead, trampling enemies in its path for 100 melee damage + knockback, then fights for 12 s. |

**台词 Quotes**

- 「蛮王在此，谁敢放肆！」 — *The Nanman King is here — who dares!*
- 「七擒七纵？我还会再起！」 — *Captured seven times? I will rise again!*
- 「丞相天威，南人不复反矣。」 — *By your might, Chancellor, the south will never rebel again.*

## 附录：军械库 · Appendix: Arsenal

DPS = 单次扳机伤害 × 射速（不含换弹）；TTK 从第一发开始计算并包含换弹，全部身体命中。<br>
DPS = one trigger pull × fire rate (no reloads); TTK counts from the first shot, includes reloads, body shots only.

| 武器 Weapon | 原型 Card | 类型 Class | 稀有度 Rarity | DPS | TTK 300 / 400 | 特效 Special |
|---|---|---|---|---|---|---|
| **制式手枪** Service Pistol | — | 手枪 | 普通 Common | 108 | 3.97 / 4.86 s | 人手一把的副武器，精准可靠，换弹迅速。<br>The sidearm everyone carries: accurate, reliable and quick to reload. |
| **制式卡宾枪** Service Carbine<br><sub>郭嘉、夏侯渊、袁绍</sub> | — | 步枪 | 普通 Common | 158 | 1.87 / 2.53 s | 全能型步枪，中近距离皆可胜任，是衡量一切武器的标尺。<br>An all-round rifle, solid at every range — the yardstick for every other gun. |
| **制式冲锋枪** Service SMG<br><sub>张辽、甄姬、大乔、陆逊</sub> | — | 冲锋枪 | 普通 Common | 156 | 1.92 / 2.50 s | 高射速近战利器，距离一远伤害迅速衰减。<br>High fire rate for close quarters; damage drops off quickly at range. |
| **诸葛连弩** Zhuge Repeater<br><sub>诸葛亮</sub> | 诸葛连弩 | 冲锋枪 | 史诗 Epic | 160 | 1.86 / 2.48 s | 超高射速冲锋枪：持续射击 1.5 秒内射速逐渐提升至 1.5 倍。<br>Extreme fire-rate SMG: holding the trigger ramps fire rate up to ×1.5 over 1.5 s. |
| **青釭** Qinggang Marksman Rifle<br><sub>夏侯惇</sub> | 青釭剑 | 射手步枪 | 稀有 Rare | 135 | 1.92 / 2.69 s | 穿甲精确射手步枪：无视目标的一切护甲效果。<br>Armor-piercing DMR: ignores every armor effect on the target. |
| **雌雄双股** Yin-Yang Twin Pistols<br><sub>刘备、貂蝉</sub> | 雌雄双股剑 | 手枪 | 稀有 Rare | 153 | 1.89 / 2.56 s | 双持手枪：对异性武将伤害 +40%。<br>Akimbo pistols: +40% damage against heroes of the opposite gender. |
| **寒冰** Frostbite Rifle<br><sub>司马懿</sub> | 寒冰剑 | 步枪 | 稀有 Rare | 158 | 1.87 / 2.53 s | 低温步枪：每次命中叠加 6% 减速，叠满 8 层冻结目标 1.2 秒。<br>Cryo rifle: each hit stacks 6% slow; at 8 stacks the target freezes for 1.2 s. |
| **古锭** Guding Blade Shotgun<br><sub>孙权</sub> | 古锭刀 | 霰弹枪 | 稀有 Rare | 154 | 1.88 / 2.50 s | 带刃战斗霰弹枪：对没有装备护甲的目标伤害 +50%。<br>Bladed combat shotgun: +50% damage against targets without armor. |
| **青龙偃月** Green Dragon Rifle<br><sub>关羽</sub> | 青龙偃月刀 | 步枪 | 史诗 Epic | 180 | 1.60 / 2.13 s | 偃月刃突击步枪：子弹被闪避或格挡时返还弹药，2 秒内下一次命中伤害 +50%。<br>Crescent-bayonet assault rifle: dodged or blocked rounds are refunded and your next hit within 2 s deals +50%. |
| **丈八蛇矛** Serpent Spear Shotgun<br><sub>张飞</sub> | 丈八蛇矛 | 霰弹枪 | 史诗 Epic | 156 | 1.67 / 2.50 s | 蛇刃泵动霰弹枪：10 颗弹丸大范围散射，近身几乎弹无虚发。<br>Serpent-blade pump shotgun: 10 pellets in a very wide spread — nearly impossible to miss up close. |
| **贯石** Guanshi Grenade Launcher<br><sub>黄盖</sub> | 贯石斧 | 发射器 | 史诗 Epic | 116 | 1.82 / 2.73 s | 斧刃榴弹发射器：榴弹爆炸（3.5 米，80 伤害）无视闪避。<br>Axe-bladed grenade launcher: grenade blasts (3.5 m, 80 dmg) cannot be dodged. |
| **朱雀羽扇** Vermilion Phoenix Flamer<br><sub>周瑜</sub> | 朱雀羽扇 | 喷火器 | 史诗 Epic | 144 | 2.06 / 2.75 s | 凤羽火焰喷射器：造成火焰伤害并点燃目标（每秒 12，3 秒）。<br>Phoenix-feather flamethrower: deals fire damage and ignites targets (12/s for 3 s). |
| **方天画戟** Sky Piercer Rocket Pod | 方天画戟 | 发射器 | 传说 Legendary | 204 | 1.25 / 1.25 s | 三联装火箭发射器：每次齐射 3 枚火箭，自动追向准星附近至多 3 个不同目标。<br>Triple rocket pod: every volley fires 3 rockets that home onto up to 3 different targets near the aim point. |
| **麒麟弓** Qilin Anti-Materiel Rifle | 麒麟弓 | 狙击枪 | 传说 Legendary | 94 | 3.08 / 3.08 s | 反器材狙击枪（3.5 倍镜）：命中骑乘者将其击落下马（坐骑惊逃 2.5 米，5 秒内无法再骑）并减速 30%。<br>Anti-materiel sniper (3.5× scope): hits knock riders off their mount (it bolts 2.5 m away; no remounting for 5 s) and slow them 30%. |
| **龙胆亮银枪** Longdan Bayonet Carbine<br><sub>赵云</sub> | — | 步枪 | 专属 Signature | 168 | 1.75 / 2.38 s | 赵云的亮银刺刀卡宾枪，射速快、腰射稳定。<br>Zhao Yun's silver bayonet carbine: fast-firing and steady from the hip. |
| **烈弓** Liegong Sniper Bow<br><sub>黄忠</sub> | — | 弓 | 专属 Signature | 95 | 2.22 / 3.33 s | 黄忠的复合狙击弓：箭矢飞行下坠小，远距离一击重创。<br>Huang Zhong's compound sniper bow: flat-flying arrows that hit hard at long range. |
| **锦帆双铃** Brocade Bell SMGs<br><sub>甘宁</sub> | — | 冲锋枪 | 专属 Signature | 168 | 1.71 / 2.36 s | 甘宁的双持冲锋枪，枪身系铃，未见其人先闻其声。<br>Gan Ning's twin SMGs hung with bells — you hear him before you see him. |
| **枭姬弓** Xiaoji Blast Bow<br><sub>孙尚香</sub> | — | 弓 | 专属 Signature | 120 | 2.00 / 2.67 s | 孙尚香的复合弓：箭矢命中后爆炸（2.2 米，35 伤害）。<br>Sun Shangxiang's compound bow: arrows explode on impact (2.2 m, 35 dmg). |
| **太平雷杖** Taiping Tesla Staff<br><sub>张角</sub> | — | 步枪 | 专属 Signature | 120 | 2.33 / 3.17 s | 张角的特斯拉法杖：雷电伤害，可跳跃至 7 米内 2 个额外目标（50% 伤害）。<br>Zhang Jiao's tesla staff: thunder damage that arcs to 2 extra targets within 7 m (50% damage). |
| **无双战铳** Peerless Battle Rifle<br><sub>吕布</sub> | — | 步枪 | 专属 Signature | 180 | 1.60 / 2.20 s | 吕布的重型战斗步枪：单发威力巨大，后坐力凶猛。<br>Lü Bu's heavy battle rifle: brutal per-shot damage and fierce recoil. |
| **虎贲机枪** Tiger Guard LMG<br><sub>许褚</sub> | — | 轻机枪 | 专属 Signature | 171 | 1.67 / 2.33 s | 许褚的轻机枪：百发弹链火力压制，但换弹缓慢、移动笨重。<br>Xu Chu's LMG: a 100-round belt of suppression, but slow to reload and heavy to carry. |
| **青囊药镖** Qingnang Dart Pistol<br><sub>华佗</sub> | — | 手枪 | 专属 Signature | 105 | 2.57 / 3.71 s | 华佗的药镖手枪：回复自身所造成伤害的 40%。<br>Hua Tuo's dart pistol: heals you for 40% of the damage it deals. |
| **倚天** Heaven-Reliant DMR<br><sub>曹操</sub> | — | 射手步枪 | 专属 Signature | 160 | 1.75 / 2.25 s | 曹操的倚天剑刃精确射手步枪：半自动，爆头伤害极高。<br>Cao Cao's Yitian sword-bladed DMR: semi-automatic with a punishing headshot multiplier. |
| **虎头湛金枪** Tiger-Head Lance Rifle<br><sub>马超</sub> | — | 步枪 | 专属 Signature | 169 | 1.69 / 2.31 s | 马超的骑枪步枪：马上射击依旧精准。<br>Ma Chao's lance rifle: stays accurate from the saddle. |
| **机关连弩** Clockwork Repeater Crossbow<br><sub>黄月英</sub> | — | 弩 | 专属 Signature | 135 | 2.00 / 2.89 s | 黄月英亲手打造的机关弩：半自动快速连发，弩矢精准。<br>Huang Yueying's clockwork crossbow: fast semi-auto bolts with pin-point accuracy. |
| **蛮王双管** Barbarian King Double-Barrel<br><sub>孟获</sub> | — | 霰弹枪 | 专属 Signature | 378 | 2.67 / 3.00 s | 孟获的象牙双管霰弹枪：两发连射威力惊人，随后需要装填。<br>Meng Huo's ivory double-barrel: two devastating blasts back to back, then a reload. |
| **白衣** White-Robe Suppressed DMR<br><sub>吕蒙</sub> | — | 射手步枪 | 专属 Signature | 151 | 1.90 / 2.62 s | 吕蒙的消音射手步枪：后坐力极低，适合潜行狙杀。<br>Lü Meng's suppressed DMR: minimal recoil, made for stealthy picks. |

### 锦囊 · Items

| 图标 | 锦囊 Item | 类型 Kind | 效果 Effect |
|---|---|---|---|
| 杀 | **杀** Strike (Ammo Box) | 基本牌 Basic | 弹药箱：为两把武器补充 50% 最大备弹。<br>Ammo box: refills 50% of max reserve ammo for both weapons. |
| 闪 | **闪** Dodge | 基本牌 Basic | 立即获得 1 次闪避（可超出上限，最多 3 次）。<br>Instantly gain 1 dodge charge (can exceed your normal max, up to 3). |
| 桃 | **桃** Peach (Medkit) | 基本牌 Basic | 回复 120 生命；对濒死角色按住 F 1.5 秒可将其以 100 生命救起。<br>Restore 120 HP. Hold F on a downed hero for 1.5 s to revive them with 100 HP. |
| 酒 | **酒** Wine | 基本牌 Basic | 8 秒内你的下一次武器命中伤害 ×2（技能与锦囊伤害不受影响）；濒死时可饮用，以 50 生命自救。<br>Your next weapon hit within 8 s deals ×2 (ability and item damage are unaffected). While downed, drink it to revive with 50 HP. |
| 无 | **无中生有** Something from Nothing | 锦囊 Trick | 立即获得 2 个随机锦囊。<br>Instantly gain 2 random items. |
| 拆 | **过河拆桥** Dismantle (EMP Grenade) | 锦囊 Trick | 投掷电磁手雷（1.2 秒后于 4 米内生效）：敌人的护甲与坐骑被震落到 2.5 米外（本人 5 秒内无法拾回），护盾清空。<br>Throw an EMP grenade (4 m, 1.2 s fuse): enemies lose all shield, and their armor and mount are knocked 2.5 m away (they cannot pick them back up for 5 s). |
| 顺 | **顺手牵羊** Steal (Grapple) | 锦囊 Trick | 用钩索从 8 米内的敌方武将处偷取 1 个随机锦囊或装备。<br>Grapple-steal 1 random item or piece of equipment from an enemy hero within 8 m. |
| 斗 | **决斗** Duel | 锦囊 Trick | 与 20 米内敌方武将决斗 8 秒，双方士兵集火对方；结束（或相距超过 35 米）时，期间失血较多的一方再受 80 伤害。<br>Duel an enemy hero within 20 m for 8 s; each side's soldiers focus the other. When it ends (or you're 35 m+ apart), whoever lost more HP meanwhile takes 80 damage. |
| 借 | **借刀杀人** Borrowed Blade (Hack) | 锦囊 Trick | 入侵 40 米内敌方武将的士兵与炮台：6 秒内它们围攻离其主人最近的另一名武将（不会是你）；对方无兵或附近无人时无法使用。<br>Hack an enemy hero's soldiers and turrets (40 m): for 6 s they attack the hero nearest their commander (never you). Fails if they have none, or nobody is near. |
| 懈 | **无懈可击** Impeccable | 锦囊 Trick | 20 秒内，下一个针对你的负面状态或技能效果被抵消。<br>For 20 s, the next hostile status or ability effect aimed at you is cancelled. |
| 蛮 | **南蛮入侵** Barbarian Invasion | 锦囊 Trick | 召唤 5 名南蛮勇士冲向准星处（20 秒），它们攻击除你和你的士兵以外的所有人。<br>Summon 5 barbarian warriors (20 s) that rush the aim point and attack everyone but you and your soldiers. |
| 箭 | **万箭齐发** Arrow Barrage | 锦囊 Trick | 0.8 秒后，准星处 8 米范围箭如雨下 3 秒：每 0.5 秒造成 18 伤害。<br>After 0.8 s, arrows rain on an 8 m area at the aim point for 3 s: 18 damage every 0.5 s. |
| 园 | **桃园结义** Peach Garden Oath | 锦囊 Trick | 为 15 米内所有武将（包括敌人）与士兵回复 80 生命。<br>Heal every hero (enemies included) and soldier within 15 m for 80. |
| 谷 | **五谷丰登** Bountiful Harvest | 锦囊 Trick | 在身边 3 米内撒出 4 个随机锦囊，先到先得。<br>Burst 4 random items onto the ground within 3 m of you — first come, first served. |
| 火 | **火攻** Fire Attack (Incendiary) | 锦囊 Trick | 投掷燃烧弹（1.5 秒后爆炸）：4 米内 40 火焰伤害并点燃，留下火海 6 秒（每秒 15）。<br>Throw an incendiary (1.5 s fuse): 40 fire damage in 4 m and ignites, leaving a fire field for 6 s (15/s). |
| 锁 | **铁索连环** Iron Chains | 锦囊 Trick | 锁住准星处 6 米内至多 3 个敌人 10 秒：火焰与雷电伤害在被锁者之间传导。<br>Chain up to 3 enemies within 6 m of the aim point for 10 s: fire and thunder damage spreads between them. |
| 乐 | **乐不思蜀** Indulgence (Trap) | 延时锦囊 Delayed Trick | 布置隐蔽陷阱（敌人靠近才能发现；1 秒后生效，存在 60 秒）：首个踏入的敌方武将跳舞 3 秒，无法射击与使用技能。<br>Place a hidden trap (enemies only spot it up close; arms in 1 s, lasts 60 s): the first enemy hero to step in dances for 3 s, unable to shoot or use abilities. |
| 粮 | **兵粮寸断** Supply Shortage (Trap) | 延时锦囊 Delayed Trick | 布置隐蔽陷阱（敌人靠近才能发现；1 秒后生效，存在 60 秒）：首个踏入的敌方武将定身 2.5 秒并失去 50% 备弹。<br>Place a hidden trap (enemies only spot it up close; arms in 1 s, lasts 60 s): the first enemy hero to step in is rooted 2.5 s and loses 50% reserve ammo. |
| 电 | **闪电** Lightning (Storm Cloud) | 延时锦囊 Delayed Trick | 在准星处召出雷云（18 秒）：以 3.5 米/秒飘向最近的武将（可能是你！），每 3 秒对其下方 3 米内所有人劈下 70 雷电伤害。<br>Summon a storm cloud (18 s) that drifts at 3.5 m/s toward the nearest hero — maybe you! — striking everyone within 3 m below it for 70 thunder every 3 s. |
| 兵 | **征兵令** Conscription Order | 军令 Utility | 引导 1.5 秒，征召 2 名本国士兵（最多超出带兵上限 2 名）。<br>Channel 1.5 s to recruit 2 soldiers of your kingdom (up to 2 over your squad cap). |

### 防具与坐骑 · Armor & Mounts

| 装备 Gear | 类型 Type | 效果 Effect |
|---|---|---|
| **八卦阵** Bagua Deflector | 防具 Armor | 偏导力场：每颗子弹有 35% 几率被完全闪避。<br>Deflector field: each incoming bullet has a 35% chance to be completely evaded. |
| **仁王盾** Benevolent King Shield | 防具 Armor | 前置防弹盾：来自正面 90° 的子弹伤害 -70%。<br>Front ballistic shield: bullet damage from your front 90° is reduced by 70%. |
| **藤甲** Rattan Armor | 防具 Armor | 子弹伤害 -40%，免疫士兵、NPC 与炮台的子弹；但受到的火焰伤害 ×2。<br>Bullet damage -40% and immune to soldier, NPC and turret bullets — but fire damage taken ×2. |
| **白银狮子** Silver Lion | 防具 Armor | 任何单次伤害最多 60 点；被卸下、拆除或偷走时回复 100 生命。<br>No single hit can deal more than 60 damage. When removed, stripped or stolen, heal 100 HP. |
| **赤兔** Red Hare | -1 马 Offensive mount | -1 马：移动速度 +40%。人中吕布，马中赤兔。<br>Offensive mount: +40% move speed. "Among men, Lü Bu; among horses, Red Hare." |
| **大宛** Ferghana Steed | -1 马 Offensive mount | -1 马：移动速度 +35%。<br>Offensive mount: +35% move speed. |
| **紫骍** Purple Stallion | -1 马 Offensive mount | -1 马：移动速度 +30%。<br>Offensive mount: +30% move speed. |
| **的卢** Dilu | +1 马 Defensive mount | +1 马：移动速度 +18%，受到伤害 -12%。<br>Defensive mount: +18% move speed, 12% less damage taken. |
| **绝影** Shadowrunner | +1 马 Defensive mount | +1 马：移动速度 +12%，受到伤害 -18%。<br>Defensive mount: +12% move speed, 18% less damage taken. |
| **爪黄飞电** Flying Lightning | +1 马 Defensive mount | +1 马：移动速度 +18%，受到伤害 -18%。<br>Defensive mount: +18% move speed, 18% less damage taken. |
