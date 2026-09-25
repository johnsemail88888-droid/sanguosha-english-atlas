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
