# Integration requests

Requests from the APP INTEGRATOR (src/main.ts, src/game/**, e2e) for files owned by other
engineers (src/sim/**, src/net/**). One section per request: file · function · exact change · why.
Append new sections at the end; mark `Status:` when applied.

## APP-1 · NET · formal debug time scale for the host sim (e2e / play-testing)
- **Status:** applied (G2) — `HostSession.setDebugTimeScale(scale)` (clamped 0.1..10, remembered for the next
  match's loop) → `FixedStepLoop.setTimeScale(k)` (`acc += elapsed × k`, catch-up cap `ceil(5 × k)`).
  `__sgwl.cheats.timeScale` now takes the formal path; the `loop.stepMs` fallback in debug.ts still works
  (field names unchanged). Unit tests: tests/unit/net/ticker.test.ts, contracts.test.ts.
- **File / function:** `src/net/hostSession.ts` (`HostSession`), `src/net/ticker.ts` (`FixedStepLoop`).
- **Change:** add
  ```ts
  /** Debug / e2e only: run the sim `scale`× faster than real time (0.1..10). */
  setDebugTimeScale(scale: number): void // → this.loop?.setTimeScale(scale); remember it for the next match's loop
  ```
  and in `FixedStepLoop` a `setTimeScale(k)` that multiplies the accumulated real time by `k` in `pump()`
  (`this.acc += (now - this.last) * this.scale`) and raises `maxCatchUp` to `ceil(5 * k)`.
- **Why:** the e2e "bots fight" check (tests/e2e/game.spec.ts) needs a few sim-minutes; at SwiftShader
  speed that is too slow in real time. `src/game/debug.ts` (`__sgwl.cheats.timeScale`) calls
  `session.setDebugTimeScale` when it exists and otherwise shortens the private `loop.stepMs` at
  runtime — works today but relies on private field names.

## APP-2 · NET · tick worker watchdog degrades to setInterval whenever the main thread stalls at match start
- **Status:** applied (G2) — the watchdog re-arms (never re-posting the start to the worker) when its own timer
  fired late (> 2 × 400 ms: the main thread was busy), degrades only after `WORKER_WATCHDOG_MISSES` (3)
  consecutive on-time misses (a dead worker falls back after ~1.2 s), and gives up after 15 s without any tick
  whatever the stalls. Unit tests: tests/unit/net/ticker.test.ts ("watchdog vs main-thread stalls").
- **File / function:** `src/net/ticker.ts` `WorkerTicker.start()` watchdog.
- **Observed:** every single-player / host match logs
  `[net] tick worker unavailable (worker never ticked); falling back to setInterval`. The worker is
  fine: the main thread is blocked for seconds right after `beginPlaying()` (first-frame shader
  compilation — 2–5 s in SwiftShader, 0.3–1 s on real GPUs), so the 400 ms watchdog `setTimeout` runs
  before the queued worker `message` task. The host then ticks from `setInterval`, which browsers
  throttle to ≥ 1 s in background tabs — exactly what the worker exists to prevent (an alt-tabbed
  host freezes every client).
- **Change:** in the watchdog callback, only degrade if the main thread was actually responsive:
  ```ts
  const armedAt = performance.now();
  this.watchdog = setTimeout(() => {
    this.watchdog = null;
    if (!this.running || this.ticked) return;
    // the timer itself fired late → the main thread was busy, not the worker: re-arm
    if (performance.now() - armedAt > this.watchdogMs * 2) { this.start(); return; }
    this.degrade('worker never ticked');
  }, this.watchdogMs);
  ```
  (guard `start()` so re-arming does not post a second interval to the worker — e.g. split the
  watchdog arming into its own method). Alternatively degrade only after N consecutive missed
  watchdog periods.

## APP-3 · NET · let the host's own 3D view finish loading before the sim starts
- **Status:** applied (G2) — `GameSession.setLocalLoading?(ready)`: the host keeps its own seat in the load gate until
  `ready` settles (a rejection counts as settled; capped by `timings.loadTimeout`); `matchStart` is emitted before
  `maybeBeginPlaying()`. Clients accept the promise while emitting the phase change / `matchStart` and send
  `{t:'loaded'}` once it settles. Never called ⇒ unchanged behaviour. Unit tests: tests/unit/net/contracts.test.ts.
- **Was:** open (the UI side is done) — **still hurts players:** measured on the host (single player, SwiftShader) the sim
  reaches `phase:playing` 3.3–4.8 s before the host's view is ready (`__sgwl.timings`: phase:playing 22 289 ms vs
  load:ready 25 618 ms). Bots move, shoot and loot during that time while the human sits on the loading screen; with a
  close spawn (see APP-8) 吕布 wiped a player's whole squad 38 s into a match.
- **File / function:** `src/net/hostSession.ts` `onSimReady` / `maybeBeginPlaying`; `src/net/clientSession.ts` `buildMatch`.
- **Now:** `matchStart` is emitted and `beginPlaying()` runs synchronously right after, so the host's sim
  (and the bots) start while the host's renderer is still building the scene and compiling shaders
  (render/mountGame.ts now does this in stages behind the loading screen: ~1–3 s on real GPUs,
  5–8 s in SwiftShader). The host's hero stands idle meanwhile. Clients send `loaded` *before* they
  emit `matchStart`, so the host never waits for their renderer either.
- **Change (additive, optional):** a `GameSession.setLocalLoading?(p: Promise<void>)` (or
  `markLocalReady()`) that the app calls from `mountGame` with the view's ready promise
  (`GameHandle.isReady()` / `onLoadProgress` stage `'ready'` exist now). Host: keep `waitingLoad` open
  for the local player until it resolves (still capped by `timings.loadTimeout`). Client: send
  `{ t: 'loaded' }` when it resolves instead of before `emit('matchStart')`.
  The UI already keeps the loading screen (with real progress) up until the view is ready.

## APP-4 · NET · expose the debug cheats the e2e / play-test hooks use
- **Status:** applied (G2) — `HostSession.debugCheats: HostDebugCheats` with `god(playerId, on)` (re-applied every
  tick), `give(playerId, itemId, count?)`, `giveWeapon`, `teleport(playerId, x, z)`, `killHero(entityId)`,
  `setCooldownsReady(playerId)`; each returns false without a match or when the sim lacks the hook.
  `src/game/debug.ts` may switch to it (its current `simHost` path keeps working).
- **File / function:** `src/net/hostSession.ts`.
- **Change:** a small typed `debugCheats` object on `HostSession` (only meaningful on the host):
  `god(playerId, on)`, `give(playerId, itemId)`, `giveWeapon`, `teleport(playerId, x, z)`,
  `killHero(entityId)`, `setCooldownsReady(playerId)`. `src/game/debug.ts` currently reaches into
  `session.simHost` and calls `World.applyStatus / giveItem / giveWeapon / teleport / killHero /
  setCooldown` directly (structurally typed) — a formal API would survive World refactors.

## APP-5 · SIM · tell the player when an ability press did nothing (no target under the crosshair)
- **Status:** open (UI + audio already react to it)
- **File / function:** `src/sim/world.ts` `activateAbility` — the `if (!ok) return;` after `impl.activate(ctx)`.
- **Observed in play-testing:** pressing E as 关羽 (义绝), 甘宁 Q (奇袭), 貂蝉 Q (离间)… with no enemy under the
  crosshair silently does nothing: no cooldown, no sound, no hint — new players think the key is broken.
  Cards already do this (`inventory.ts itemDenied` → `{ t: 'sfx', name: 'itemDenied', privateTo }`).
- **Change:** when `ok` is false for a human hero, emit the same kind of private event:
  ```ts
  if (!ok) {
    if (!this.isBotHero(e)) this.emit({ t: 'sfx', name: 'abilityDenied', pos: { ...e.pos }, privateTo: e.id });
    return;
  }
  ```
  The HUD shows a warning for `itemDenied` / `abilityDenied` (throttled; text from `deniedText()`, 「准星需对准目标」 when
  the event carries `reason: 'noTarget'` — see APP-7) and the
  audio catalog maps both to the UI error blip (`src/audio/catalog.ts` aliases) — until now `itemDenied` was dropped
  by the audio resolver, so card denials were silent too.

## APP-6 · NET · connection watchdogs must not fire right after the page itself was frozen
- **Status:** applied (G2) — both checks skip one round after a gap > 2 × interval + 1 s (client: `checkHost`,
  host: `pingPeers`); guests emit `status {key:'waitingHost'}` "等待主机响应… / Waiting for host…" after 3 s of
  host silence and `{key:'waitingHost', clear:true}` "主机已恢复响应 / Host is responding again" when it speaks
  again. Until the first snapshot of a match arrives (the host is still building its own scene) a guest tolerates
  `hostLoadingTimeoutMs` (45 s) of host silence instead of 15 s. The host exempts a peer that is loading a match from `peerTimeout` until it reports `loaded`
  (≤ `timings.loadGrace`, 30 s), and keeps a closed connection's seat for `timings.dropGrace` (5 s) before a bot
  takes over, so a blip + auto-rejoin never bounces the seat. Unit tests: tests/unit/net/rejoin.test.ts.
- **Files / functions:** `src/net/clientSession.ts` `checkHost()` (1 s interval, `hostTimeoutMs` 15 s);
  `src/net/hostSession.ts` the peer-timeout check (`t - peer.lastSeen > this.timings.peerTimeout * 1000`, run from the ping timer).
- **Observed:** e2e `tests/e2e/game-online.spec.ts` (host + 2 guests, SwiftShader, busy 4-CPU box) intermittently shows
  「客人乙 断开连接，由人机接管 / 客人甲 重新连接」 loops during match start. When a page's main thread is blocked for a
  long time (first-frame shader compilation; also a backgrounded/throttled tab or a laptop waking from sleep), the
  interval callback can run *before* the WebSocket/DataChannel messages that queued up during the freeze are
  dispatched, so `now - lastHostMsgAt` (or `lastSeen`) looks like 15+ s of silence although the link is fine →
  false `connectionLost` → rejoin → the seat bounces to a bot and back.
- **Change:** make both checks stall-aware — remember when the check last ran and skip one round after a gap:
  ```ts
  const t = now();
  const gap = t - this.lastCheckAt; this.lastCheckAt = t;
  if (gap > 2 * CHECK_INTERVAL_MS + 1000) { this.lastHostMsgAt = Math.max(this.lastHostMsgAt, t - CHECK_INTERVAL_MS); return; }
  ```
  (host: the same around the per-peer `lastSeen` test). Queued messages are then processed before the next check.
- **APP side (done):** `GameRenderer.warmup()` now compiles + links shaders in batches with yields, so the longest
  loading freeze dropped from ~4–5 s to ~1.3 s in SwiftShader (measured with a `longtask` observer), which makes the
  false timeouts much rarer — but real browsers can still freeze longer (tab throttling, sleep).

## APP-7 · SIM · say *why* a card / ability was refused (`reason`, `item` on the denied sfx event)
- **Status:** open (the HUD already reads the optional fields; without them it shows a neutral text)
- **File / function:** `src/sim/inventory.ts` `itemDenied(w, e)` and its two call sites; `src/sim/world.ts` the
  `abilityDenied` emit of APP-5 (when applied).
- **Observed:** every `itemDenied` showed 「准星需对准目标 / Aim at a target first」, but the sim also emits it whenever a
  card's `use()` returns false — 桃 at full HP, 闪 at its dodge cap… — which misled players (shots/p2-02-denied-peach.png).
  The HUD now says 「现在无法使用 / Can't use that now」 unless it is told the reason.
- **Change (additive, optional fields on the existing event):**
  ```ts
  function itemDenied(w: World, e: Entity, itemId: string, reason?: 'noTarget' | 'fullHp' | 'cap' | 'blocked'): void {
    if (!w.isBotHero(e)) w.emit({ t: 'sfx', name: 'itemDenied', pos: { ...e.pos }, privateTo: e.id, item: itemId, reason } as GameEvent);
  }
  ```
  - `useItem` enemy targeting with no `aimTarget` → `reason: 'noTarget'`;
  - after `impl.use(ctx)` returned false → let the card say why: `ctx.deniedReason` (optional `ItemCtx` field that
    `tao` / `jiu` set to `'fullHp'`, `shan` to `'cap'`, …); `undefined` is fine (neutral text).
  - `abilityDenied` (APP-5): `reason: 'noTarget'` when the ability needed a target and `aimTarget` found none.
  The HUD mapping lives in `src/ui/hud/logic.ts` `deniedText()` (unit-tested). If `sfx` must stay `{ name, pos }` in
  `core/types.ts`, add `item?: string; reason?: string` there (additive).

## APP-8 · SIM · minimum distance between hero spawns
- **Status:** open
- **Files / functions:** `src/sim/world.ts` `spawnHeroes()`; `src/sim/map/spots.ts` `chooseSpawns()`.
- **Observed:** `generateMap` spawns for seeds 1 and 2 are as close as 36.8 m (the ring keeps only a 36 m minimum pair
  distance, and the angular offsets let neighbouring sectors slide together). `spawnHeroes` takes the *shuffled* list in
  order, so in an 8-player match two heroes regularly start 20–40 m apart — 吕布 spawned ~25 m from the player and killed
  the whole squad at 0:38 (shots/gy-10-e.png, 「麾下已无兵」), before the player had even left the loading screen (APP-3).
- **Change:**
  1. `spawnHeroes`: pick spawns by farthest-point assignment instead of list order — keep the shuffle for fairness, then
     for each non-lord seat take the remaining spawn that maximises the minimum distance to every spawn already used
     (seed the "used" set with `map.lordSpawn`). Deterministic (same rng), O(n²) for n ≤ 10.
  2. `chooseSpawns`: raise the pair-distance rejection from 36 m to ~55 m (fall back to the old 36 m only if a sector
     would otherwise stay empty), so 8 players on the ~110 m ring are ≥ 60 m apart in practice.
  3. (nice to have) a unit test: for seeds 1..20 and 8 seats, min pairwise hero spawn distance ≥ 55 m.

## NET-1 · UI · fresh, ranked LAN addresses on the desktop app
- **Status:** open (the NET/desktop side is done)
- **Files / functions:** `src/ui/desktop.ts` `desktopInfo()` / `shareBase()`; `src/ui/screens/online.ts` `lanBox()`.
- **Now available:** `window.sgwlDesktop.getLanUrls(): string[]` (electron/preload.cjs → main via IPC) returns the
  machine's `http://<ip>:<port>/` list *right now*, best first (Wi-Fi / Ethernet before VirtualBox 192.168.56.x,
  Hyper-V / WSL vEthernet, Docker, VPN adapters — ranking in server/lan.mjs). `sgwlDesktop.lanUrls` stays the list
  from window creation (also ranked).
- **Change:** in `desktopInfo()`, prefer `typeof d.getLanUrls === 'function' ? d.getLanUrls() : d.lanUrls` (filter as
  today), and call it each time the online screen renders its LAN box / builds an invite link, so the first
  (copied) address is the reachable one even after the Wi-Fi changed.

## NET-2 · UI · lobby notices as system chat lines, "waiting for host" status
- **Status:** open (the session side is done)
- **Files:** `src/ui/screens/lobby.ts` (`session.on('chat')`), `src/ui/hud/hud.ts` (`'chat'`, `'status'`).
- **Now emitted:** `chat` events may carry `system: true` with `from: ''` and localized `zh` / `en` (player joined /
  left / was kicked — host and guests). `status` events may carry `key` and `clear` (today only
  `key: 'waitingHost'`); `session.waitingForHost` (guests) mirrors it.
- **Change:** lobby: `appendChat({ from: tx('系统', 'System'), text: tx(c.zh ?? c.text, c.en ?? c.text), system: true })`
  when `c.system`; HUD: show a keyed status as one persistent line that the `clear` event removes (instead of an
  announcement + a chat line for both).

## NET-3 · E2E · rejoin / host-freeze checks for tests/e2e/game-online.spec.ts
- **Status:** open — proposed checks, verified by G2 with a scratch spec against the same server:
  after the match starts, on a guest `__sgwl.session.transport.ws.close()` → that guest is back on screen `match`
  within 3 s with the same `<canvas>` element, and no 「断开连接」 announce reaches anyone; then on the host
  `page.evaluate(() => { const end = performance.now() + 20000; while (performance.now() < end); })` → no guest is
  announced as dropped and the guests' `__sgwl.session.waitingForHost` became true meanwhile.

