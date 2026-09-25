# SIM requests (wave 2)

Change requests for files owned by SIM-CORE / other engineers. Append one section per request:
file · function · exact proposed change · why · which ability needs it. The integrator applies them.

## ABILITIES-SHU (蜀) — 4 requests

### SHU-1 · dash / knockback overshoot (post-forced-movement slide) — correctness, affects every hero
- **Files / functions:** `src/sim/world.ts` `updateHero` (the `else { if (e.forced) e.forced = undefined; … predictMove }` branch);
  `src/sim/troops.ts` `driveUnit` (`if (u.forced) u.forced = undefined;`); `src/net/clientView.ts` `stepPrediction`
  (when `forced.left` runs out) so client prediction stays bit-identical.
- **Problem:** `moveCharacter` sets `vel = displacement / dt`, so when `e.forced` expires the unit still carries the forced
  velocity and `predictMove` / `steerMove` brake it at `GROUND_ACCEL` (60 m/s²): it slides on for v²/120 m.
  Dodge roll (12.9 m/s) +1.4 m; 七进七出 7 m dash (28 m/s) +6.5 m; 长坂救主 (≈39 m/s) +12.6 m; 青龙斩 charge passes
  *through* the enemy it should stop at; a knockback of 10 (33 m/s) travels ≈19 m instead of 10.
- **Proposed change:** at the moment forced movement ends (`e.forced` defined but `now >= e.forced.until`), cap the horizontal
  speed at walking speed before `predictMove` runs:
  ```ts
  if (e.forced) { e.forced = undefined; const v = Math.hypot(e.vel.x, e.vel.z); if (v > WALK_SPEED) { e.vel.x *= WALK_SPEED / v; e.vel.z *= WALK_SPEED / v; } }
  ```
  (same 3 lines in `driveUnit` with the unit's `baseSpeed`, and in `clientView.stepPrediction` when a replayed forced
  segment ends). Knockback distances in the data (据水断桥 10, 西凉冲锋 9, 青龙斩 7…) then mean what they say.
- **Who needs it:** all dashes/knockbacks. Shu works around it for its own casters (`sim/abilities/shu/util.ts`
  `charge()` → `brake()` on the last dash tick) and, since the review, for the victims of its shoves
  (`strikeUnit()` → `brakeAfterForced()`: watches the knockback it just applied and brakes after its last tick; measured
  据水断桥 10 → 10.4 m, 西凉冲锋 9 → 8.6 m, was 13.3 / 18.3 m). Both use exactly the cap proposed here, so they become
  harmless no-ops once this lands. Knockbacks applied by the engine itself (explosions, weapon specials) still slide.
  Until the `clientView.stepPrediction` part lands, a remote client whose own hero is braked this way predicts the old
  slide for a few ticks and is pulled back (smoothed) by the next snapshot — one more reason to apply all three parts.
- **Related (dash length):** a dash moves on every tick with `time < until`, so a duration that is not a whole number of
  ticks moves one tick more than `distance` (七进七出 7 m → 7.6 m). Shu's `charge()` rounds to n ticks and passes
  `(n − ½)·SIM_DT` (with `distance·(n − ½)/n`) so float rounding of `until` can never add or drop a tick. Consider doing the
  same inside `World.dash` (`const n = max(1, round(duration / SIM_DT))`, `until = time + (n − 0.5) * SIM_DT`,
  `speed = distance / (n * SIM_DT)`) — every hero's dash then covers exactly its data distance.

### SHU-2 · piercing projectiles re-hit their first target up to 4× in one tick — correctness
- **File / function:** `src/sim/combat.ts` `updateProjectiles`.
- **Problem:** `const pierced = w.projPierced.get(p.id)` is read once, before the hit loop. On the first pierce the set is
  created (`w.projPierced.set(p.id, set)`) but the `skip` closure still sees the stale `undefined`, so the next raycast
  from the hit point finds the same entity at t≈0 and hits it again (up to the 4-iteration guard). 百步穿杨 (pierce 3,
  140) dealt 560 to its first target in the test world — far over the 300 burst cap.
- **Proposed change:** make the skip test read the live set:
  `const skip = (x: Entity): boolean => x.id === owner || (ownerCredit !== undefined && w.creditOf(x.id) === ownerCredit) || (w.projPierced.get(p.id)?.has(x.id) ?? false);`
- **Who needs it:** 黄忠 百步穿杨 (and any future `pierce` projectile). Workaround in `sim/abilities/shu/huangzhong.ts`
  `seedPierceSet()` (creates the empty set right after `spawnProjectile`, duck-typed on `World.projPierced`).

### SHU-3 · let an ability tell the world where its cast really happened ({ t: 'ability' } event) — VFX/audio accuracy
- **File / function:** `src/sim/world.ts` `activateAbility` (+ an additive type, e.g. in `src/sim/ext.ts`:
  `export interface AbilityCast { pos?: Vec3; target?: EntityId; dir?: Vec3 }`).
- **Problem:** the event always carries `pos: aimPoint(e, 60)`, `target: input.aimTargetId`, `dir: aimRay.dir`. For many
  abilities that is not where the effect is: 八阵图 is clamped to 30 m, 蜀汉旌旗/咆哮/空城 happen at the caster's feet,
  济民/长坂救主 resolve a different hero than the raw aim id (or fall back to the caster), charges end `dash` m ahead.
  The renderer then draws the stone ring / heal / afterimages at the wrong place.
- **Proposed change:** after `ok = impl.activate!(ctx) === true`, read an optional override the ability wrote on its ctx:
  ```ts
  const c = (ctx as AbilityCtx & { cast?: AbilityCast }).cast;
  this.emit({ t: 'ability', src: e.id, ability: id, pos: c?.pos ?? this.aimPoint(e, 60), target: c?.target ?? rt.input.aimTargetId, dir: c?.dir ?? ray.dir });
  ```
- **Who needs it:** every Shu active (they already set it through `sim/abilities/shu/util.ts` `setCast()`); other kingdoms
  can adopt the same helper. Without the change the events simply keep today's values.
- **Render side:** `src/render/vfx/abilities-shu.ts` already copes with both: `near()` / `within()` accept ev.pos /
  ev.target only when they are plausible for the ability's range, direction dashes (七进七出, 西凉冲锋) always use the data
  length, and 青龙斩 estimates its stop point from the aimed unit. After SHU-3, `qinglong()` may take its end point from
  `near(ctx, dash, …)` instead (the sim then writes the real stop point).

### SHU-4 · `SimExt.dropAggro(unitId, seconds)` — 空城 writes brain state directly — robustness
- **Files / functions:** `src/sim/ext.ts` (`SimExt`), `src/sim/world.ts` (implementation), `src/sim/ai/troopBrain.ts` +
  `src/sim/ai/npcBrain.ts` (honour it).
- **Problem:** 诸葛亮 空城 ("soldiers / NPCs within 15 m lose aggro") has no API, so `sim/abilities/shu/zhugeliang.ts`
  `loseAggro()` clears `troop.targetId` / `npc.targetId` and pushes the brains' private `ai.nextScan` timer 3 s ahead. It
  works with today's brains (both gate target acquisition on `ai.nextScan`), but any brain rewrite that renames or stops
  reading that field silently breaks 空城 (the units would re-acquire him on the next tick).
- **Proposed change:** `dropAggro(unitId: EntityId, seconds: number): void` on SimExt — clears the unit's target and sets
  a documented field (e.g. `ai.aggroHoldUntil`) that both brains check before (re)acquiring any target:
  `if ((ai.aggroHoldUntil ?? 0) > now) { tr.targetId = undefined; /* hold / follow only */ }`. The NPC "fight back when
  hurt" path may still override it (being shot breaks the spell).
- **Who needs it:** 空城 (and any future "calm / taunt-off" effect). Shu switches to it once it exists; until then the
  workaround above stays (limited to units fighting 诸葛亮's side since the review).

## ABILITIES-QUN (群) — 7 requests (QUN-3 and QUN-5 withdrawn)

### QUN-1 · +1 for SHU-3 (ability event override) — same `ctx.cast` property
- **File / function:** `src/sim/world.ts` `activateAbility` — exactly the SHU-3 change (read `ctx.cast` → `pos` / `target` / `dir`).
- **Why (Qun):** 麻沸散 (≤ 30 m), 雷击 (≤ 50 m), 乱击 (≤ 60 m) and 南蛮入侵 (≤ 50 m) land at the range-clamped point, not at
  `aimPoint(e, 60)`; 青囊 falls back to Hua Tuo himself (the raw aim id may be an enemy hero → the heal VFX plays on the
  enemy); 辕门射戟 wants the real impact point / unit; 离间 puts the *second* charmed hero in `pos` so the renderer can draw
  the pink tether between the pair (the event has only one `target`).
- **Status:** every Qun active already writes `ctx.cast` through `sim/abilities/qun/util.ts` `setCastEvent()` (same shape as
  Shu's `setCast`). Until the world reads it, `render/vfx/abilities-qun.ts` clamps `ev.pos` to the ability's range itself.

### QUN-2 · shieldPierce should come from the hero's own hits, not its troops/summons — correctness (吕布 无双)
- **File / function:** `src/sim/combat.ts` `dealDamage`, step 5 (shield):
  `const pierceFrac = credit?.hero ? Math.min(1, Math.max(0, w.modifiers(credit.id).shieldPierce)) : 0;`
- **Problem:** the pierce is looked up on the *credited* hero, so Lü Bu's squad, and any other `shieldPierce` hero's
  troops, turrets and summoned NPCs also ignore 50 % of shields. 无双 says "**your** damage".
- **Proposed change:** `const pierceFrac = src?.hero ? Math.min(1, Math.max(0, w.modifiers(src.id).shieldPierce)) : 0;`
  (his bullets, rockets, ability hits and his own hazards all carry `sourceId` = the hero, so they keep piercing).
- **Who needs it:** 吕布 无双 (`lubu_wushuang.modifiers().shieldPierce`). No workaround on the ability side.

### QUN-3 · ~~basic bot: a failed activation locks the bot onto that slot forever~~ — WITHDRAWN
- Already solved: `src/sim/ai/abilityUse.ts` `AbilityUser.checkPending` backs a slot off for ~5 s (`FAIL_BACKOFF`) when a
  press started no cooldown / spent no charge, and falls through to the next slot. In current all-Qun bot matches 离间
  and 连环计 are both cast. Nothing to apply.

### QUN-4 · HeroBot: the 急救 free revive is assumed ready while it is on cooldown — AI (华佗)
- **File / function:** `src/sim/ai/heroBot.ts` `HeroBot.canReviveFree()` (used by `reviveCandidate()`).
- **Problem:** it only checks that one of the hero's passives *has* a `canReviveFree` hook, not that the free revive is
  ready. A 华佗 bot without a 桃 walks to downed allies while `huatuo_jijiu` is on its 30 s cooldown, and
  `inventory.startRevive` then refuses silently (`!hasTao && !hooks.canReviveFree(e)`) — a wasted, dangerous trip.
- **Proposed change:** ask the real hook (it already checks the cooldown and that the bot can act):
  `return (this.sim as World).hooks.canReviveFree(this.self);` — or, data-driven like the HUD
  (`ui/hud/logic.ts canReviveFree`): `def.abilities.some((a) => a.slot === 'passive' && !!getAbility(a.id)?.canReviveFree
  && this.sim.cooldownLeft(this.self.id, a.id) <= 0)`.
- **Who needs it:** 华佗 急救. (A bot that carries a 桃 is unaffected: the ability side makes a ready free revive go
  first, see QUN-6.)

### QUN-5 · ~~basic bot: self-centred melee abilities are cast from 27 m away~~ — WITHDRAWN
- Already solved: `abilityUse.ts` `abilityReach()` falls back to `params.radius`, and an 'offense' ability with
  `targeting: 'self'` and a radius ≤ 12 m is only pressed with ≥ 2 enemy points inside that radius
  (`enemiesWithin(p.radius)`), so 方天画戟 is no longer cast from afar. Nothing to apply.

### QUN-6 · a ready 急救 free revive should be used before the 桃 — gameplay (华佗) — worked around, please still apply
- **File / function:** `src/sim/inventory.ts` `updateChannel`, the `ch.kind === 'revive'` completion
  (`const taoSlot = h.items.findIndex(...); if (taoSlot >= 0) { …consume… } else if (w.hooks.canReviveFree(e)) free = true;`).
- **Problem:** Hua Tuo carrying a 桃 always spends it, even while his once-per-30 s free revive is ready. Every hero spawns
  with a 桃, so without a workaround the free revive almost never happened (0 in two full all-Qun bot matches).
- **Workaround in place:** `huatuo_jijiu.onRevive(free = false)` with the free revive ready gives the spent 桃 back
  (`giveItem`, or drops it at his feet when the bag is full) and starts the 30 s timer — both for the F-revive and for the
  桃 item used on a downed ally. Remaining wart: the world still emits `{ t: 'itemUse', item: 'tao' }` for that revive.
- **Proposed change:** check the free revive first:
  ```ts
  let free = false;
  if (w.hooks.canReviveFree(e)) free = true;
  else { const taoSlot = …; if (taoSlot < 0) return; …consume one 桃… }
  ```
  (`huatuo_jijiu.onRevive(free = true)` then starts its 30 s timer; the workaround simply stops triggering.) Optionally
  the same in `completeItem` for a 桃 used on a downed ally (skip the consume + `itemUse` when `hooks.canReviveFree(e)`).
- **Who needs it:** 华佗 急救. The HUD's "need a 桃" hint (`ui/hud/logic.ts`) already treats a ready free revive as enough.

### QUN-7 · 铁索连环: an area fire / thunder hit multiplies on every chained unit inside it — correctness / balance
- **File / function:** `src/sim/combat.ts` `dealDamage`, step 9 (chained spread).
- **Problem:** an area ability hits each unit in its area directly, and each direct hit on a 'chained' unit spreads to
  every other chained unit. With N chained units inside one blast, each takes the hit N times (3 chained heroes in one
  雷击 took 3 × 3 × 71.5 = 643.5 each — far past the "no single cast deals ≥ 300 to one target" rule).
- **Worked around for Qun:** 雷击 / 太平要术 (`qun/zhangjiao.ts` `bolt()`) strike the unchained enemies plus only ONE
  chained enemy and let the spread cover the rest (tested: each link takes each bolt exactly once). Every other area
  fire / thunder source still multiplies: 黄盖 诈降火船 (120 in 6 m), 周瑜 napalm line, 陆逊 燎原 fields, the tesla
  staff's chain jumps, fire hazards (`hazards.ts` fieldEffects), 火攻-style items, explosions (`explode`).
- **Proposed change:** keep a per-tick "already hit by this" set in World, keyed on `(creditId, abilityId ?? weaponId,
  tick)`, for fire / thunder hits only:
  ```ts
  // before step 1 (fire/thunder, no weaponId — weapon pellets must keep hitting):
  const key = `${creditId}|${req.abilityId}|${w.tick}`;
  if (chainedOnly && w.chainHit.get(key)?.has(target.id)) return res;   // already took this strike via the chain
  // step 9: add target + every spread target to w.chainHit.get(key); skip spread targets already in it
  ```
  (clear the map at the start of each tick). Restricting it to targets that carry 'chained' keeps everything else
  exactly as today; restricting it to ability / status / hazard hits (no `weaponId`) keeps multi-pellet weapons intact.
- **Who needs it:** everyone who deals area fire / thunder (Wu above, items, hazards); 貂蝉 连环计 / 铁索连环 item make
  it common. The Qun workaround stays correct (and becomes a no-op) once this lands.

## ITEMS (锦囊 / 装备) — 12 requests

### ITEMS-1 · expose the 无懈可击 / 谦逊 gates on SimExt — needed by 5 items (worked around)
- **File:** `src/sim/ext.ts` `interface SimExt` (World already implements both as public methods — declaration only).
- **Proposed change:** add
  ```ts
  /** 无懈可击 gate for a hostile source-less effect on `target` (true = cancelled, charge consumed) */
  nullifies(target: Entity, sourceId?: EntityId): boolean;
  /** 谦逊-style vetoes (AbilityImpl.canBeAffected) */
  canBeAffected(target: Entity, status: StatusId | 'steal', sourceId?: EntityId): boolean;
  ```
- **Why:** 过河拆桥's EMP strip has no damage/status to carry the check; 决斗 applies 'marked', which is NULLIFY_EXEMPT, so the
  duel needs an explicit gate; 借刀杀人 is a squad order; 顺手牵羊 must pre-check 谦逊 so the card is not wasted; traps skip
  heroes immune to their status. `src/sim/items/util.ts` duck-types both today (`nullified()`, `vetoes()`) and falls back
  to "not cancelled / not vetoed" if they ever disappear — switch to `ext(sim).nullifies(...)` once declared.

### ITEMS-2 · `SimExt.squadCap(heroId)` — 征兵令 (and 孙权 坐断东南)
- **Files:** `src/sim/ext.ts` (declare), `src/sim/world.ts` (implement with the formula already in `spawnHeroes`):
  `settings.troopsPerHero + heroDef.troopBonus + (role lord|double ? 2 : 0) + modifiers(id).squadBonus`.
- **Why:** items only see SimApi; `items/util.ts troopsPerHero()` reads `world.settings` by duck-typing (default 4).

### ITEMS-3 · item-use events and hidden information (trap spot — worked around; stealthed users — open)
- **Files:** `src/sim/ext.ts` `ItemImplEx` (+ `hiddenUse?: boolean`), `src/sim/inventory.ts` `completeItem`.
- **Problem 1 (worked around, no longer leaks):** `completeItem` emits `{ t: 'itemUse', who, item, pos: point }` publicly,
  so every client (and the renderer's ring/sparkle at `pos`) learned exactly where each 乐不思蜀 / 兵粮寸断 trap was laid.
  Workaround in ITEMS-owned files: both traps are now `targeting: 'self'` in `data/items.ts` (no `point` to publish;
  `use()` reads the crosshair itself via `sim.aimPoint(self, range)`, clamped to 8 m) — the event now only says "X used a
  trap card" at X, like playing a card. Tested in `tests/unit/items/delayed.test.ts` ("publishes no position").
- **Problem 2 (open):** the same public event is emitted for a user in stealth (白衣渡江 / 克己 / 百骑劫营 …) — the
  renderer sparkles at `who` and audio plays at `who`, giving the invisible hero away (the item twin of WU-2).
- **Proposed change:** in `completeItem`, before `impl.use(ctx)`:
  `const hidden = impl.hiddenUse === true || (findStatus(e, 'stealth', w.time) !== undefined && !revealedTo(e, undefined, w.time));`
  and emit `w.emit({ t: 'itemUse', who: e.id, item: itemId, pos: point, target: target?.id, ...(hidden ? { privateTo: e.id } : {}) })`
  (net/eventFilter already routes `privateTo`). With `hiddenUse` declared, ITEMS can switch the traps back to
  `targeting: 'point'` + `hiddenUse: true` if the UI wants a placement reticle.
- **Also (VFX accuracy, low priority):** let `use()` override the event position (`ctx.eventPos?: Vec3`, same idea as
  SHU-3's `ctx.cast`): 过河拆桥 / 火攻 grenades stop at walls, so the generic itemUse ring at the *aim* point can be metres
  from where the grenade actually lands (`items/util.ts throwItem` knows the landing point).

### ITEMS-4 · hidden hazards should be sent within 6 m, not 8 m (low priority)
- **File / function:** `src/sim/snapshot.ts` `hiddenFrom`.
- **Current:** traps hide themselves with a keep-`stealth` instance on the hazard entity (`items/delayed.ts placeTrap`), so
  snapshots omit them for enemies beyond `STEALTH_SEND_RANGE` (8 m); the item design (data/items.ts header) says 6 m.
- **Proposed change:** `const range = e.kind === 'hazard' ? 6 : STEALTH_SEND_RANGE; return d > range;`

### ITEMS-5 · source-scoped status removal — 决斗 early end (worked around, low priority)
- **Files:** `src/sim/ext.ts` + `src/sim/world.ts`: `removeStatusFrom(targetId: EntityId, id: StatusId, sourceId: EntityId): void`
  → `const e = this.get(targetId); if (e) removeStatusFrom(this, e, id, sourceId);` (status.ts already has it).
- **Why:** when a duel ends early (35 m apart, someone downed) its two 'marked' instances should go, but
  `SimApi.removeStatus` would also wipe other commanders' squad marks. Workaround (same as WU-3's): `items/tricks.ts
  endDuelMark()` sets `until = sim.time` on the duel's own instances (matched by source and end time), so `tickStatuses`
  removes them that tick with their 'off' events. Same need as WU-3 — one API serves both.

### ITEMS-6 · discrete custom hazard kinds (low priority, worked around)
- **File / function:** `src/sim/hazards.ts` `updateHazards` + `HazardKindImpl`.
- **Problem:** a custom `tick()` always runs inside `periodic()`, so a custom *discrete* effect (trap springing, lightning
  bolt) can neither consume nor be cancelled by 无懈可击. Items resolve such effects via `sim.schedule(0, …)` from `tick()`.
- **Proposed change:** `HazardKindImpl.discrete?: boolean`; when set, call `safeKind(...)` without the `periodic()` wrapper.

### ITEMS-7 · feedback when an item cannot be used (UX, low priority)
- **File / function:** `src/sim/inventory.ts` `useItemSlot` (no aim target for an 'enemy' item) and `completeItem` (`use()`
  returned false: nothing to steal, nobody hurt, squad full …).
- **Proposed change:** `w.emit({ t: 'sfx', name: 'itemDenied', pos: { ...e.pos }, privateTo: e.id })` so the HUD/audio can
  play a "denied" cue instead of silently doing nothing.

### ITEMS-8 · `DamageRequest.noNullify` — 决斗's penalty must not be cancellable (worked around)
- **Files:** `src/sim/api.ts` `DamageRequest` (+ `noNullify?: boolean` — additive, optional), `src/sim/combat.ts`
  `isNullifiableHit`: `if (isZone || req.noNullify || req.sourceId === undefined || req.weaponId !== undefined) return false;`
- **Problem:** the duel loser's 80 damage is an item hit with a source, so the loser's 无懈可击 cancelled it (bots carry
  one in every hero fight) — though the target's 无懈可击 was already checked when the duel started.
- **Workaround:** the penalty uses `abilityId: 'status:juedou'` (`items/tricks.ts DUEL_PENALTY`), which combat exempts.
  Side effect: 'status:*' hits also count as *indirect* for passives that react to direct hits (`shu/util.ts isDirectHit`,
  `wei/shared.ts`) and skip 酒 (irrelevant: weapon-only). With the flag, switch back to `abilityId: 'juedou', noNullify: true`.

### ITEMS-9 · loot pickup lock on SimApi — 过河拆桥 flings gear out of its owner's reach (worked around)
- **Files:** `src/sim/api.ts` `spawnLoot(pos, what, ammo?, lock?)` (declaration only — `World.spawnLoot` already takes
  `lock: { heroId, seconds }` 4th); optionally `SimExt.dismount(heroId, opts?: { at?: Vec3; lock?: number })` /
  `stripArmor(heroId, drop?, opts?)` with the same options.
- **Why:** 过河拆桥 used to drop armor and mount at the victim's feet with no lock — two F presses and the victim had
  everything back. Now the EMP strips with `stripArmor(id, false)`, clears `hero.mount` itself (= `dismount()` minus the
  drop; onEquipmentLost still fires from the per-tick diff), and spawns the gear 2.5 m away locked 5 s for the victim
  via `items/util.ts spawnLockedLoot()` (a cast to World's 4-argument `spawnLoot`). Note WU-4 (nullify inside
  `dismount` / `stripArmor`): the EMP checks 无懈可击 itself and no longer calls `dismount`, so WU-4 cannot double-consume it.

### ITEMS-10 · RENDER + AUDIO: the EMP looks and sounds like a frag grenade; item-use VFX registry
- **RENDER, `src/render/vfx/effects.ts` `explosion()`:** add `case 'emp':` — expanding blue-white shock ring on the ground
  (`fx.ring`, radius0 0.3 → radius × 1.2, color ~C(0.6, 1.2, 2.4)), a thin translucent sphere pulse (`fx.sphere`, 0.3 s),
  a handful of short electric sparks (`PT.spark`, blue, low gravity), a small cold light flash — no fireball, no smoke,
  **no `shakeAt`** (it deals no damage). Today `'emp'` falls into the default fire/frag branch (fireball + screen shake).
- **AUDIO, `src/audio/router.ts` explosion variant:** map `/emp|shock/` to an electric discharge (the existing `'thunder'`
  variant at low size is acceptable) instead of `'frag'`.
- **RENDER, `src/render/vfx/eventVfx.ts` `case 'itemUse'`:** an item VFX registry like `registerAbilityVfx` (id → fn with
  who / pos / target) so cards can get bespoke casts. Suggested looks (ITEM color from data/items.ts):
  sha — brass ammo glints at the user; shan — blue afterimage ring; tao / taoyuan — peach petals + green rise (taoyuan: a
  15 m gold ring); jiu — amber steam puff; wuzhong / wugu — card-flip glyphs (wugu: grain burst on the 4 loot spots);
  guohe / huogong — throw flick only (the warning disc + explosion already show the landing); shunshou — a grapple
  line user → target; juedou — two crossed-blade glyphs over both duelists + a red tether while `abilityState
  ['item:juedou:vs']` holds; jiedao — red "hack" glitch on the victim's soldiers; wuxie — golden seal glyph on the user;
  nanman — dust burst where they spawn; wanjian — volley streaks rising from the user; tiesuo — chain links flying to the
  chained units; lebusishu / bingliang — a tiny puff at the user only (never at the trap); shandian — dark cloud swirl
  at pos; zhengbing — banner wave.
- **UI (HUD):** a duel indicator — opponent name + seconds left — from `hero.abilityState['item:juedou:vs']` (entity id)
  and `['item:juedou:until']` (sim time) in the local player's private view (no reader in `src/ui` yet).

### ITEMS-11 · AI planner (`src/sim/ai/itemUse.ts ItemUser.plan`) second-guesses three item hints
- **决斗:** `if (id === 'juedou' && hpFrac < (t.hp / Math.max(1, t.maxHp)) + 0.1) return null;` rejects every even duel.
  `botShouldUse` now accepts fair fights (≥ 50 % HP, ≥ 90 % of the foe's HP + shield) and finishing blows — drop the line
  (or `if (id === 'juedou' && gate !== true && …)`).
- **征兵令:** `case 'zhengbing': return h.squad.length < 4 || fighting ? base : null;` — with a squad cap above 4 (lord,
  troopBonus heroes) or the card's +2 over-cap allowance the hint says yes (calm, squad below cap / nearly full bag /
  foe in sight) and the planner refuses. Real-map probe (2 seeds × 150 s, `tests/unit/items/match.test.ts`): hint yes
  820 / 938 calls, cards played 2. Proposed: `case 'zhengbing': return gate === true ? base : null;`.
- **Traps (FYI, no change needed):** 乐不思蜀 / 兵粮寸断 are now `targeting: 'self'`, `aiHint: 'utility'`, so the planner's
  default branch returns the plan when the hint says yes; the hint also chooses the spot (the bot's crosshair is not
  used). The planner's 'point' + 'defense' branch (≤ 10 m midpoint) no longer applies to them.

### ITEMS-12 · docs: regenerate HEROES.md, align GAME_SPEC §7 决斗
- `docs/HEROES.md` is stale (tests/unit/data/heroes-doc.test.ts fails): item text in data/items.ts changed (借刀杀人,
  南蛮入侵, 乐不思蜀, 兵粮寸断, 闪电, and now 过河拆桥's knock-away + 5 s lock) plus Wu's 百骑劫营. Run
  `UPDATE_DOCS=1 npx vitest run tests/unit/data` (docs/ is outside the ITEMS paths).
- `docs/GAME_SPEC.md` §7 still describes 决斗 as "tether duel 10 s (damage between you ×1.5, others ×0.5)"; the data and
  the implementation are an 8 s duel (each side's soldiers focus the other; the one who lost more HP + shield takes 80,
  ends early at 35 m or when someone falls). Please align the spec text with data/items.ts.

## ABILITIES-WU (吴) — 9 requests

Wu lives in `src/sim/abilities/wu/*.ts` (entry `wu.ts`); every workaround below sits in `wu/util.ts` and becomes
redundant (not wrong) once the request lands.

### WU-1 · +1 for SHU-3 (ability event override) — same `ctx.cast` property
- **File / function:** `src/sim/world.ts` `activateAbility` — exactly the SHU-3 change.
- **Why (Wu):** 火烧赤壁's 1.5 s warning needs the *line*: Wu writes `pos` = far end of the 25 m line on the ground and
  `dir` = its flat direction (the default `aimPoint(e, 60)` / 3D aim ray point elsewhere). 反间 writes `pos` = the hero
  the charmed enemy turns on (discord line target → pos). 奇袭 / 攻心 / 国色 / 结姻 resolve a different unit than the raw
  `aimTargetId` (hero-first targeting through soldiers, downed bodies skipped, female heroes skipped). 火烧连营 writes the
  last field actually laid (walls stop the line); self-centred casts (制衡, 坐断东南, 救援, 苦肉, 白衣渡江, 百骑劫营,
  安娴, 燎原) write the caster's chest. Helper: `wu/util.ts setCast()` (same shape as Shu/Qun).

### WU-2 · activation events leak the position of a stealthed caster — hidden information
- **File / function:** `src/sim/world.ts` `activateAbility` (the `this.emit({ t: 'ability', … })` after a successful activate).
- **Problem:** the event is public and carries `src`, so every client plays the cast VFX/SFX at the caster: a hero in
  stealth (吕蒙 克己 / 白衣渡江, 甘宁 百骑劫营, 孙尚香 … any hero with a stealth item) who casts 攻心 / 奇袭 / 国色 …
  is revealed to everyone, exactly when stealth matters most.
- **Proposed change:** remember `const hidden = findStatus(e, 'stealth', this.time) !== undefined && !revealedTo(e, undefined, this.time);`
  *before* calling `impl.activate`, and emit with `privateTo: e.id` when `hidden` (casting 白衣渡江 from plain sight stays
  public: the smoke puff where he vanished is fair). Wu's own passive-trigger events already do this (`wu/util.ts emitTrigger`).

### WU-3 · remove one status instance, not every instance of the id — needed by 吕蒙 克己
- **File / function:** `src/sim/ext.ts` (SimExt) + `src/sim/world.ts`: add
  `removeStatusWhere(targetId: EntityId, id: StatusId, pred: (s: StatusInstance) => boolean): void` → `status.ts removeStatusIf(this, e, id, pred)`
  (or an optional `sourceId` on `removeStatus`, mapping to `removeStatusFrom(w, e, id, sourceId)`).
- **Why:** 克己's stealth breaks on damage, 白衣渡江's does not; `SimApi.removeStatus(id, 'stealth')` would strip both.
  Workaround: `lumeng.ts breakKeji()` finds its own instance (tagged `params.keji`) and sets `until = sim.time`, so
  `tickStatuses` removes it (with its 'off' event) later in the same tick.

### WU-4 · `dismount` / `stripArmor` ignore 无懈可击 — needed by 甘宁 奇袭 (and 过河拆桥)
- **File / function:** `src/sim/world.ts` `dismount(heroId)` / `stripArmor(heroId, drop)` (→ `inventory.ts`).
- **Problem:** unlike `takeRandomItem` / `stealItem` / `knockback` / `teleport`, these never consult the nullify gate, so an
  enemy trick that strips gear goes through a 无懈可击. Gating on `actorId` would be wrong for 麒麟弓's weapon special
  (weapon hits never touch nullify), so make it explicit:
  `dismount(heroId, opts?: { sourceId?: EntityId })` / `stripArmor(heroId, drop = true, opts?: { sourceId?: EntityId })` →
  `if (opts?.sourceId !== undefined && this.nullifies(e, opts.sourceId)) return;` (additive optional arg).
- **Workaround:** 奇袭 applies its silence first and treats a nullified silence as the whole bolt being cancelled
  (`ganning.ts`); the echo rule then keeps the rest of the cast consistent.

### WU-5 · let abilities ask "can this status land?" before committing — 谦逊 / 无懈可击 outcomes
- **File / function:** `src/sim/ext.ts` (SimExt) + `src/sim/world.ts`: `canBeAffected(targetId: EntityId, what: StatusId | 'steal', sourceId?: EntityId): boolean`
  → `this.hooks.canBeAffected(e, what, sourceId)` (the method exists on World, just not on the interface).
- **Why:** in 三国杀 a card cannot be aimed at an immune hero (乐不思蜀 / 反间 on 陆逊), while 无懈可击 cancels a card that
  was played. Wu keeps the cooldown when the target is immune and spends it when nullified; today it infers which one
  happened from the target's nullify charges before/after `applyStatus` (`wu/util.ts applyDebuff`). With the query the
  immune case is decided up front and no status is ever attempted.

### WU-6 · squad cap query — needed by 孙权 坐断东南 (and 征兵令)
- **File / function:** `src/sim/ext.ts` + `src/sim/world.ts`: `squadCap(heroId: EntityId): number` =
  `settings.troopsPerHero + def.troopBonus + (role lord/double ? 2 : 0) + modifiers(id).squadBonus` (the spawn rule in the
  World constructor, factored out so both use one formula).
- **Workaround:** `sunquan.ts squadCap()` re-derives it and reads `World.settings` through a structural cast.

### WU-7 · projectile detonation callback — needed by 黄盖 诈降火船
- **File / function:** `src/sim/combat.ts` `updateProjectiles` / `detonate` (+ a registry next to `registerHazardKind`):
  `registerProjectileKind({ kind, onDetonate?(sim, proj: Entity, at: Vec3, hitId?: EntityId): void })`, called once when the
  projectile explodes, hits a unit (before `removeEntity`), hits a wall or expires.
- **Why:** the fire ship must blast and leave its burning field exactly where it went off. Workaround:
  `wu/util.ts whenProjectileGone()` polls the projectile every tick with `schedule(0)` and uses its last position
  (≤ 0.4 m early at 12 m/s).

### WU-8 · non-stacking fields of one cast, and the hazard dtype for custom kinds
- **File / function:** `src/sim/hazards.ts` `fieldEffects` / `HazardKindImpl.tick`.
- **Problem:** a line of overlapping fields from one cast (火烧连营 4 m apart with r 2.5 → ×1.5 under 燎原; 火烧赤壁's
  5 napalm fields) burns a unit standing in the overlap 2–3× per tick. Custom kind ticks also cannot read the spec's
  `dtype` (`hazardRt` is private), so they hard-code it.
- **Proposed change:** optional `HazardSpec.params.group` (number): in `fieldEffects`, skip a unit already damaged this tick by a
  hazard with the same `(ownerId, group)`; and pass the runtime to custom kinds: `tick?(sim, hazard, affected, rt: { dtype: DamageType })`.
- **Also:** `queryRadius`'s vertical test (±radius) lets a ground fire on a roof burn whoever stands on the floor under it
  (火烧赤壁 bombs land on the top-most surface, like any `groundAt`). Suggest skipping units whose feet are > 2 m above the
  field or whose head is below it (`u.pos.y > h.pos.y + 2 || u.pos.y + u.height < h.pos.y - 0.5`) in `updateHazards`.
- **Workaround:** `wu/util.ts registerFieldKind()` registers `luxun_fire` / `chibi_napalm` / `huochuan_fire` with a custom
  tick that dedupes per (kind, owner, unit, tick), applies that floor test and deals 'fire'.

### WU-9 · bots: 结姻 only works on male heroes — AI (`src/sim/ai/abilityUse.ts` `allyInNeed`)
- **Problem:** 孙尚香 结姻 (`targeting: 'ally'`, aiHint heal) refuses a female ally, so the bot aims at 大乔/貂蝉/甄姬, fails and
  backs off.
- **Proposed change:** data now carries `params.maleOnly = 1` on `sunshangxiang_jieyin`; in `allyInNeed` (heal/ally plans) skip
  candidates with `def.params.maleOnly && sim.heroDef(a)?.gender !== 'male'`.

### Data note (integrator)
- `src/data/heroes-wu.ts`: 百骑劫营 text/params now describe the implemented "first attack" = one trigger pull, ≤ `burst` 1 s
  (+`burst: 1`), and 结姻 gained the `maleOnly: 1` hint → `docs/HEROES.md` must be regenerated
  (`UPDATE_DOCS=1 npx vitest run tests/unit/data`; it is also stale from item-text edits by others).

## ABILITIES-WEI (魏) — 11 requests + a data note

### WEI-1 · redirected damage must not run the attacker's outgoing pipeline again — correctness (曹操 护驾, 大乔 流离)
- **File / function:** `src/sim/combat.ts` `dealDamage` (+ `isNullifiableHit`).
- **Problem:** a redirect re-deals damage whose `amount` already includes the attacker's multipliers. If it keeps the
  attacker as `sourceId` (kill credit, `recordAttack`, troop retaliation) the pipeline applies `beforeDamageDealt`,
  `dmgBoost`, 酒, `troopDmgMul`, `weaponOutgoingMul` and every `modifyOutgoing` (辽来 +40 %, 裸衣 ×1.5, 武圣…) a second
  time, and 无懈可击 treats it as the attacker's ability hit. `DamageRequest.redirected` exists but nothing reads it.
- **Proposed change:** `const redirected = req.redirected === true;` then skip `w.hooks.beforeDamageDealt` and the whole
  step 3 (`if (!isZone && src && !redirected)`) when set, and make `isNullifiableHit` return false for it. Incoming
  modifiers (armor, dmgTakenUp/Down, the new victim's hooks), shield, reflect/lifesteal stay as they are.
- **Who needs it:** 护驾 (`sim/abilities/wei/caocao.ts`) currently deals the redirected half *source-less* (correct
  amount, no kill credit / attack memory). Once this lands, add `sourceId: req.sourceId` to that `dealDamage` call
  (one line). 流离 has the same double-multiplier problem today.

### WEI-2 · `fireHitscan` with a `weaponId` should apply the weapon's on-hit special — correctness (夏侯渊 神速)
- **File / function:** `src/sim/combat.ts` `fireHitscanShot` (+ optional additive `HitscanOptions.weaponSpecials?: boolean`
  in `src/sim/ext.ts` if you prefer opt-in).
- **Problem:** `params.weaponHit = 1` means "fired with the held weapon: falloff and weapon specials apply" (data/heroes.ts
  header). Falloff / `weaponOutgoingMul` / 酒 already work, but on-hit specials (寒冰 freeze stacks, 朱雀 burn, 麒麟
  dismount, 太平 chain lightning) are only applied by `fireOne`.
- **Proposed change:** after the `dealDamage` in the loop: `if (wdef && src && (!res.blocked || res.blocked === 'shield'))
  applyWeaponSpecialOnHit(w, src, wdef, target, res.dealt + res.absorbed);` (gated by `o.weaponSpecials !== false`).
  神速 already passes `ignoreArmor` for `pierceArmor` weapons and the weapon's `headshotMul` itself.
- **Who needs it:** 夏侯渊 神速 (`sim/abilities/wei/xiahouyuan.ts` `fireVolleyRound`), any future weaponHit ability.

### WEI-3 · +1 for SHU-3 (ability event override) — same `ctx.cast` property
- **File / function:** `src/sim/world.ts` `activateAbility` — exactly the SHU-3 change.
- **Why (Wei):** 突袭 / 凌波微步 / 神速 land somewhere else than the crosshair, 独目怒冲 / 虎卫猛击 end `dash`/`leap` m ahead,
  遗计 is clamped to 40 m, 鬼谋 / 宁教我负天下人 resolve their own target, self casts (鬼才, 狼顾, 裸衣…) happen at the
  caster. Every Wei active already writes `ctx.cast` via `sim/abilities/wei/shared.ts` `setCast()`; until the world
  reads it, `render/vfx/abilities-wei.ts` derives the geometry from the ability data instead of `ev.pos`.
- **Wei convention for blinks:** 突袭 / 凌波微步 / 神速 record the blink's *start* as `pos` (remote events play at their
  tick, when the caster is already drawn at the landing, so `pos → caster` is the path; `blinkPath()` in the VFX file
  handles both before and after this lands). The world should copy `ctx.cast.pos` verbatim — no "must be near the
  crosshair" sanity clamp.

### WEI-4 · +1 for SHU-1 (post-dash slide) — Wei works around it
- 独目怒冲 (24 m/s) slid to 16.4 m instead of 12, 虎卫猛击 to 7.0 m instead of 6. `sim/abilities/wei/shared.ts`
  `brakeAtDashEnd()` caps the speed on the dash's last tick (now 12.1 m / 6.1 m); it becomes a no-op once SHU-1 lands.

### WEI-5 · expose the dodge-charge maximum — small (夏侯渊 虎步关右 "refill all dodge charges")
- **File / function:** `src/sim/world.ts` (`BASE_DODGE_CHARGES` is module-private) — export it (or add
  `SimExt.maxDodgeCharges(heroId): number` = `BASE_DODGE_CHARGES + modifiers(id).extraDodgeCharges`).
- **Why:** `sim/abilities/wei/shared.ts` mirrors the constant (`BASE_DODGE_CHARGES = 2`); it silently drifts if the base changes.

### WEI-6 · a way to end your own dash — small API gap (夏侯惇 独目怒冲 "stops at the first hero")
- **File / function:** `src/sim/ext.ts` / `src/sim/world.ts`: `endDash(id: EntityId): void` — clears `e.forced` (only when
  it is a dash, not a knockback) and caps horizontal velocity at walking speed.
- **Why:** 独目怒冲 stops on impact by writing `self.forced = undefined; self.vel.x = self.vel.z = 0` directly
  (`sim/abilities/wei/xiahoudun.ts` `endCharge`). Works, but ability code mutating movement state is fragile.

### WEI-7 · (render / input, not sim) face the target after 张辽 突袭 — UX
- **File / function:** the client input controller (`src/game/input.ts` / render InputController) on `{ t: 'ability',
  ability: 'zhangliao_tuxi', src: <local hero> }`.
- **Problem:** 突袭 teleports *behind* the target; when the target was facing Zhang Liao, "behind" is on the far side, so
  the local camera ends up looking away from it (the host cannot turn a client's camera).
- **Proposed change:** ease the camera yaw toward the event's `target` (the raided hero; note `pos` is the blink *start*
  under the WEI-3 convention above, not something to face) over ~0.15 s. Bots already re-aim every think.
- **Scheduling:** please land it together with WEI-3 — the back-stab bonus (辽来 +40 %) is the point of the kit, and a
  human who blinked from in front of the target currently lands looking away from it.

### WEI-8 · reflected damage must skip the reflector's outgoing multipliers — correctness (刚烈, 鬼才, every reflect/thorns)
- **File / function:** `src/sim/combat.ts` `dealDamage`, step 3 "outgoing modifiers".
- **Problem:** reflect and thorns are re-dealt with the *reflecting* hero as `sourceId` (kill credit), so step 3 applies
  its `dmgBoost`, `weaponOutgoingMul`, `troopDmgMul` and every `modifyOutgoing` to them. Probed: 刚烈 returns 39 instead
  of 30 of a 100 hit during 夏侯惇's own 拔矢啖睛 (dmgBoost ×1.3); any dmgBoost on Sima Yi (an item, an ally's buff) inflates 鬼才 the same way.
- **Proposed change:** next to WEI-1's `redirected` flag:
  `const reflected = req.abilityId === 'status:reflect' || req.abilityId === 'status:thorns';` and
  `if (!isZone && src && !redirected && !reflected) { …step 3… }`. Incoming modifiers (armor is already ignored via
  `ignoreArmor`, dmgTakenUp/Down, the victim's hooks) stay.
- **Wei side (done):** the Wei `modifyOutgoing` hooks (狼顾 ×1.4, 辽来 ×1.4) already return reflections unchanged
  (`sim/abilities/wei/shared.ts` `isReflected`), so only the engine's `dmgBoost` / weapon / troop multipliers remain.

### WEI-9 · (net) statuses "until consumed" arrive as expired on remote clients — correctness, HUD
- **File / function:** `src/net/codec.ts`, the `you.statuses` loop (`w.u16(csQ(s.remaining))`).
- **Problem:** `sim/status.ts` `statusRows` reports an `Infinity` status as `remaining: -1`; `csQ(-1)` clamps to 0, so
  remote clients get `remaining 0` — the HUD shows a blinking "0 / expiring" icon and `estimateMoveMods`' `has()` treats
  the status as off. (`csDQ` already decodes 0xffff as Infinity.)
- **Proposed change:** `w.u16(s.remaining < 0 ? 0xffff : csQ(s.remaining));` (the panel already shows no number for a
  non-finite remaining). Optionally make `has()` in `net/clientView.ts` accept `remaining !== 0`.
- **Wei side (worked around):** 刚烈 now keeps a 60 s thorns status topped up (refreshed below 30 s, silently — equal
  params replace the instance without a status event) instead of an infinite one; revert to `Infinity` once this lands
  if a timer-less HUD icon is preferred.

### WEI-10 · mark passive procs on the ability event — UX (render gesture + audio), all kingdoms
- **Files:** `src/core/types.ts` (the `{ t: 'ability' }` event), `src/net/codec.ts` (one flag bit),
  `src/render/vfx/eventVfx.ts` (`case 'ability'`), `src/audio/router.ts` (`case 'ability'`).
- **Problem:** passive triggers are announced as `{ t: 'ability' }` events (Wei `emitProc`: 奸雄 / 反馈 / 天妒; Wu
  `emitTrigger`: 流离 / 连营 / 枭姬 / 克己). Clients play the caster's cast gesture (`src.onCast()`) and the full
  'abilityCast' sound for them, which reads as an active cast — 奸雄 under sustained fire did it every 3 s.
- **Proposed change:** add `proc?: boolean` to the ability event (codec: one bit); in eventVfx skip `src?.onCast()` when
  `ev.proc`; in the audio router play a lighter cue (e.g. `abilityCast` at gain ×0.5 / size 0.6, or a dedicated 'proc'
  recipe). Then set `proc: true` in `sim/abilities/wei/shared.ts` `emitProc` and `wu/util.ts` `emitTrigger` (one line each).
- **Wei side (interim):** 奸雄's proc event is throttled to one per 8 s (was 3 s).

### WEI-11 · (AI) two bot heuristics keep Wei actives idle — AI (`src/sim/ai/abilityUse.ts`, bot movement)
- **Evidence:** the 8-bot all-Wei match casts 11–16 of the 17 actives per seed (seeds 3/5/7/11/21; the union of 3/7/21
  is all 17). In the scripted close-fight test (`tests/unit/abilities/wei.test.ts` "魏 bots": an enemy kept at 8 m that
  shoots back) every Wei bot casts every active, so the gaps are engagement heuristics, not failed activations (no Wei
  activation by a bot failed in any probe).
- **狼顾 blocked by `areaClear`:** 狼顾 is `targeting: 'self'`, `radius: 40`, and `areaClear` treats that radius as a
  harmful area: any believed-ally or neutral hero within 41 m vetoes the cast. With bystanders 30 m away it was never cast
  in 20 s; with them 85 m away it was cast after 4 s. It only reveals (privately) and buffs Sima Yi's own damage.
  **Proposed:** in `safeForFriends` (or `areaClear`), return true when `def.params.privateReveal` is set; more generally,
  radius-only self casts that apply nothing to others should skip the check.
- **突袭 range vs hover distance:** a Zhang Liao bot facing a passive enemy at 9 m backs off to 12.1–12.6 m and hovers there,
  just outside 突袭's 12 m `range`, so the `mobility`/`enemy` plan (`d <= reach`) never presses it. Held at 8 m, it casts 突袭
  4.5 s in. **Proposed:** while an enemy-targeted mobility ability is ready (and HP > 45 %), cap the preferred engagement
  distance at `abilityReach(def) − 1.5`, so the bot steps into reach before pressing.

### Data note (Wei)
- `simayi_guicai` deals reflected damage but carries no `dtype`: `tests/unit/data/data.test.ts` requires every damaging
  active to have a fixed size (`castDamage > 0`), which a reflect has not. If the data owner wants the header rule
  ("dtype on reflected damage too") enforced, teach `castDamage` / `DAMAGE_KEYS` about reflect abilities (e.g. rate
  them 0 and skip the "recognised" assertion when `params.reflect` is set); then add `dtype: 'normal'` to 鬼才 — the
  code already deals `ctx.def.dtype ?? 'normal'`. 刚烈 keeps `dtype: 'normal'` (engine thorns are always 'normal').

## RENDER — 1 request

### RENDER-1 · mounted heroes are hit where they are drawn (rider on horseback) — correctness, 马超 / 吕布 always, anyone with a 马
- **File / function:** `src/sim/combat.ts` `hitbox()` and `raycastEntities()` (hit tests only — the physics capsule,
  `e.radius` / `e.height`, stays CHAR_RADIUS × CHAR_HEIGHT so riders still fit through 2.5 m doors).
- **Problem:** riders are drawn seated on a horse (head ≈ 2.07 m) but the hero hit box is the 1.8 m foot capsule
  (head sphere at 1.58 m): shots at the rider's visible head miss, shots at the rider's belly count as head shots.
  马超 (HeroVisual.mount 'horse') and 吕布 ('redHare') are drawn mounted permanently; other heroes while a mount item is
  equipped (VF_MOUNTED).
- **Proposed change:** size a mounted hero's hit box like horse cavalry (`unitSize` for `mountedOn: 'horse'`):
  ```ts
  /** hit-test size of a hero on horseback (= horse cavalry, sim/troops.ts unitSize) — render/camera/pick.ts mirrors it */
  export const MOUNTED_HIT = { radius: 0.6, height: 2.3 } as const;
  const ridesForHits = (e: Entity): boolean =>
    !!e.hero && !e.hero.downed && (!!e.hero.mount || !!heroDef(e.hero.heroId).visual.mount);
  // hitbox(e):
  const height = downed ? 0.6 : ridesForHits(e) ? MOUNTED_HIT.height : e.height;
  // raycastEntities(), instead of `const r = e.radius + inflate;`:
  const r = (ridesForHits(e) ? MOUNTED_HIT.radius : e.radius) + inflate;
  ```
  (the head sphere then follows from the existing formula: r 0.281 centred at 2.019 m, body up to 1.85 m).
- **Who needs it:** everyone shooting a rider. The renderer already draws riders inside this box and `pick()` /
  `aimTargetId` already use it; tests: `tests/unit/render/pick.test.ts` ("mirrors the sim hitbox").

## AI (bots / troop & NPC brains) — 3 requests

### AI-1 · public event tap for brains (exact 跳身份 evidence, human quick-chat) — fairness & quality
- **Files / functions:** `src/sim/ext.ts` (additive: `SimExt.publicEventsSince?(seq: number): { seq: number; events: readonly GameEvent[] }`),
  `src/sim/world.ts` `emit()` (+ a small ring buffer, e.g. 2048 entries, of every event **without** `privateTo`, each stamped
  with a monotonically increasing seq; `drainEvents()` keeps working unchanged).
- **Why:** bots may only use what a human in their seat sees; everything they learn about other players comes from public
  events (`hit` src/target, `heal`, `revived` by, `downed` src, `death` killer+role, `claim`, `quickchat`). Brains cannot see
  events today, so `sim/ai/observer.ts` reconstructs them by polling public state once per tick (`recentAttackers` + HP deltas,
  heal/rescue counters, downed/dead flags, claims). That works but is approximate (damage is split evenly among
  simultaneous attackers, direct vs. field damage is guessed from the attack-log source kinds, heals are attributed from
  counter deltas) and it cannot see **quick-chat at all** — so bots ignore a human's 集火此人 / 需要桃 / 保护主公.
- **Proposed change:** in `World.emit(ev)`: `if (ev.privateTo === undefined) { this.pubLog.push({ seq: ++this.pubSeq, ev }); if (this.pubLog.length > 2048) this.pubLog.shift(); }`
  and `publicEventsSince(seq)` returns the entries with a larger seq. `observer.ts` already has the consumer shape
  (per-bot cursor over a shared log); it would switch to the tap when `typeof ext(sim).publicEventsSince === 'function'`.
- **Who needs it:** `sim/ai/observer.ts`, `sim/ai/beliefs.ts`.

### AI-2 · public match info for brains — fairness (no casts)
- **File / function:** `src/sim/ext.ts` (additive: `SimExt.matchInfo?(): { playerCount: number; mode: GameMode }`), implemented
  in `World` from `this.settings`.
- **Why:** the role table (how many 反贼/忠臣/内奸 are still unaccounted for) is public in 身份局 and depends on mode + player
  count (乱世 has two variants per count). `sim/ai/knowledge.ts` currently reads `(sim as { settings?: MatchSettings }).settings`
  through a cast; a typed accessor removes the cast and documents that only the public part is used.

### AI-3 · hazard harmfulness in HazardState — robustness
- **Files / functions:** `src/core/types.ts` `HazardState` (additive optional `harmful?: boolean` or `dtype?: DamageType`),
  filled in `World.spawnHazard` from the spec (`params.damage/strike/slow > 0 || spec.status !== undefined`).
- **Why:** bots, soldiers and NPCs step out of harmful fields (`sim/ai/perception.ts` `harmfulHazard`), which today guesses
  from `params.damage / strike / slow / dps`. Status-only fields (麻沸散 gas, traps) and custom `registerHazardKind` kinds that
  deal damage in their own tick are invisible to that guess.
