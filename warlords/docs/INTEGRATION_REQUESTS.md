# Integration requests

Requests from the APP INTEGRATOR (src/main.ts, src/game/**, e2e) for files owned by other
engineers (src/sim/**, src/net/**). One section per request: file · function · exact change · why.
Append new sections at the end; mark `Status:` when applied.

## APP-1 · NET · formal debug time scale for the host sim (e2e / play-testing)
- **Status:** open (a fallback is in place, see below)
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
- **Status:** open
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
- **Status:** open (the UI side is done)
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
- **Status:** open (works today through `HostSession.simHost` + `World` methods)
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
  The HUD shows 「准星需对准目标 / Aim at a target first」 for `itemDenied` / `abilityDenied` (throttled) and the
  audio catalog maps both to the UI error blip (`src/audio/catalog.ts` aliases) — until now `itemDenied` was dropped
  by the audio resolver, so card denials were silent too.

## APP-6 · NET · connection watchdogs must not fire right after the page itself was frozen
- **Status:** open
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
