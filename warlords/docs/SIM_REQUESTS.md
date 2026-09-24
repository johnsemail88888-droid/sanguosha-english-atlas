# SIM requests (wave 2)

Change requests for files owned by SIM-CORE / other engineers. Append one section per request:
file · function · exact proposed change · why · which ability needs it. The integrator applies them.

## ABILITIES-SHU (蜀) — 3 requests

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
  `charge()` → `brake()` on the last dash tick); that workaround becomes a harmless no-op once this lands.

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

## ABILITIES-QUN (群) — 6 requests

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

### QUN-3 · basic bot: a failed activation locks the bot onto that slot forever — AI (貂蝉 连环计 never cast)
- **File / function:** `src/sim/ai/basicBot.ts` `tryAbility`.
- **Problem:** the first slot whose aiHint condition holds is pressed and the loop returns. If `activate()` refuses (no valid
  target: 离间 needs a *hero* under the crosshair plus someone within 15 m; the bot's target is often a bandit NPC), no
  cooldown starts and the next attempt picks the same slot again, so E is never tried. In three 8-bot all-Qun matches
  离间 failed 31× and 连环计 was cast only 4×.
- **Proposed change:** remember the attempt: `this.tried = { slot, abilityId, at: now }`; at the next `tryAbility`, if
  `sim.cooldownLeft(self.id, tried.abilityId) <= 0` (it did not fire), skip that slot for ~4 s
  (`this.skipUntil[slot] = now + 4`) and fall through to the next slot.
- **Who needs it:** every activate() that can legitimately refuse (离间, 太平要术 / 连环计 without a target, …).

### QUN-4 · basic bot: 华佗 never goes for a 桃-free revive — AI (急救)
- **File / function:** `src/sim/ai/basicBot.ts` `reviveGoal` — `if (!h.items.some((s) => s?.id === 'tao')) return null;`
- **Problem:** 华佗's passive lets him revive without a 桃 once per 30 s (`hooks.canReviveFree`), but the bot only looks
  for downed allies when it carries a 桃.
- **Proposed change:** also accept a ready free revive, with the same data-driven test the HUD uses
  (`ui/hud/logic.ts canReviveFree`): an ability of the bot's hero with `params.freeReviveCd` whose
  `sim.cooldownLeft(self.id, a.id) <= 0`. (Or expose `canReviveFree(heroId)` on SimExt → `this.hooks.canReviveFree(e)`.)
- **Who needs it:** 华佗 急救 (`huatuo_jijiu.canReviveFree` / `onRevive`).

### QUN-5 · basic bot: self-centred melee abilities are cast from 27 m away — AI (吕布 方天画戟)
- **File / function:** `src/sim/ai/basicBot.ts` `tryAbility`: `const range = ab.params.range ?? ab.params.dash ?? 25;`
- **Problem:** `lubu_fangtian` (targeting 'self', `radius` 5, no `range`) passes the 'offense' test at up to 27 m and whiffs
  (same for 许褚 虎卫猛击-style slams).
- **Proposed change:** `const range = ab.params.range ?? ab.params.dash ?? (ab.targeting === 'self' && ab.params.radius !== undefined ? ab.params.radius : 25);`
- **Who needs it:** 吕布 方天画戟 (and other `targeting: 'self'` damage abilities with a `radius`).

### QUN-6 · a ready 急救 free revive should be used before the 桃 — gameplay (华佗)
- **File / function:** `src/sim/inventory.ts` `updateChannel`, the `ch.kind === 'revive'` completion
  (`const taoSlot = h.items.findIndex(...); if (taoSlot >= 0) { …consume… } else if (w.hooks.canReviveFree(e)) free = true;`).
- **Problem:** Hua Tuo carrying a 桃 always spends it, even while his once-per-30 s free revive is ready — the free revive
  only ever triggers when he has no 桃 at all, so the passive silently burns his heals.
- **Proposed change:** check the free revive first:
  ```ts
  let free = false;
  if (w.hooks.canReviveFree(e)) free = true;
  else { const taoSlot = …; if (taoSlot < 0) return; …consume one 桃… }
  ```
  (`huatuo_jijiu.onRevive(free = true)` then starts its 30 s timer; nothing else changes.)
- **Who needs it:** 华佗 急救. The HUD's "need a 桃" hint (`ui/hud/logic.ts`) already treats a ready free revive as enough.

## ITEMS (锦囊 / 装备) — 7 requests

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

### ITEMS-3 · trap placement is broadcast to everyone (hidden information leak) — please apply
- **Files:** `src/sim/ext.ts` `ItemImplEx` (+ `hiddenUse?: boolean`), `src/sim/inventory.ts` `completeItem`.
- **Problem:** `completeItem` emits `{ t: 'itemUse', who, item, pos: point }` publicly, so every client (and the renderer's
  ring/sparkle at `pos`) learns exactly where each 乐不思蜀 / 兵粮寸断 trap was laid, defeating the hidden trap.
- **Proposed change:** `w.emit({ t: 'itemUse', who: e.id, item: itemId, pos: point, target: target?.id, ...(impl.hiddenUse ? { privateTo: e.id } : {}) })`
  (net/eventFilter already routes `privateTo`). ITEMS will then add `hiddenUse: true` to lebusishu / bingliang in
  `items/delayed.ts` (an object literal cannot carry the field before it is declared).

### ITEMS-4 · hidden hazards should be sent within 6 m, not 8 m (low priority)
- **File / function:** `src/sim/snapshot.ts` `hiddenFrom`.
- **Current:** traps hide themselves with a keep-`stealth` instance on the hazard entity (`items/delayed.ts placeTrap`), so
  snapshots omit them for enemies beyond `STEALTH_SEND_RANGE` (8 m); the item design (data/items.ts header) says 6 m.
- **Proposed change:** `const range = e.kind === 'hazard' ? 6 : STEALTH_SEND_RANGE; return d > range;`

### ITEMS-5 · source-scoped status removal — 决斗 early end
- **Files:** `src/sim/ext.ts` + `src/sim/world.ts`: `removeStatusFrom(targetId: EntityId, id: StatusId, sourceId: EntityId): void`
  → `const e = this.get(targetId); if (e) removeStatusFrom(this, e, id, sourceId);` (status.ts already has it).
- **Why:** when a duel ends early (35 m apart, someone downed) its two 'marked' instances should go, but
  `SimApi.removeStatus` would also wipe other commanders' squad marks; today they simply run out at 8 s.

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

## ABILITIES-WEI (魏) — 7 requests

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
- **Proposed change:** ease the camera yaw toward the event's `target` (or `pos` once WEI-3 lands) over ~0.15 s. Bots
  already re-aim every think.

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
