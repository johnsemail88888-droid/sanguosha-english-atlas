// Downed / death / spectate HUD (src/ui/hud/fallen.ts). Same --u unit as styles/hud.ts.
const u = (n: number): string => `calc(var(--u) * ${n})`;
const fs = (n: number, min = 11): string => `max(${min}px, calc(var(--u) * ${n}))`;

export const FALLEN_CSS = /* css */ `
/* ── downed: the world drains of colour, the heart pounds ─────────────── */
.hud-fallen-downed { position: absolute; inset: 0; display: none; }
.hud-fallen-downed.on { display: block; }
.hud-fallen-downed .dn-tint {
  position: absolute; inset: 0;
  -webkit-backdrop-filter: grayscale(0.85) brightness(0.82) contrast(1.05);
  backdrop-filter: grayscale(0.85) brightness(0.82) contrast(1.05);
  background: radial-gradient(ellipse at center, transparent 34%, rgba(120, 0, 0, 0.42) 70%, rgba(45, 0, 0, 0.85));
  animation: sg-dn-beat 1.05s ease-in-out infinite;
}
.hud-fallen-downed.critical .dn-tint { animation-duration: 0.62s; }
.hud-fallen-downed.saving .dn-tint { background: radial-gradient(ellipse at center, transparent 40%, rgba(20, 60, 30, 0.35) 75%, rgba(8, 24, 12, 0.7)); animation: none; opacity: 0.9; }
@keyframes sg-dn-beat { 0%, 100% { opacity: 0.72; } 14% { opacity: 1; } 28% { opacity: 0.8; } 42% { opacity: 1; } }
/* low, just above the item bar: you crawl and look in the middle of the screen */
.hud-fallen-downed .dn-box { position: absolute; left: 50%; bottom: ${u(134)}; transform: translateX(-50%); width: ${u(520)}; max-width: 92vw; display: flex; flex-direction: column; gap: ${u(6)}; }
.hud-fallen-downed.collapsed .dn-box { width: ${u(460)}; }
.hud-fallen-downed .dn-head { display: flex; align-items: baseline; justify-content: space-between; gap: ${u(12)}; }
.hud-fallen-downed .dn-ttl { font-family: var(--font-display); font-size: ${fs(40, 22)}; font-weight: 900; color: #ff5a48; letter-spacing: 0.25em; line-height: 1; text-shadow: 0 0 ${u(14)} rgba(255, 40, 20, 0.55), 0 2px 0 #000; }
.hud-fallen-downed .dn-state { font-size: ${fs(16, 12)}; font-weight: 700; color: #ffc9b8; }
.hud-fallen-downed.saving .dn-ttl { color: #9fe8a8; text-shadow: 0 0 ${u(14)} rgba(40, 200, 90, 0.5), 0 2px 0 #000; }
.hud-fallen-downed.saving .dn-state { color: #bdf5c4; }
.hud-fallen-downed .dn-bar { display: flex; align-items: center; gap: ${u(12)}; }
.hud-fallen-downed .dn-track { position: relative; flex: 1; height: ${u(16)}; border-radius: ${u(8)}; overflow: hidden; background: rgba(0, 0, 0, 0.6); border: 1px solid rgba(255, 120, 100, 0.55); box-shadow: 0 0 ${u(10)} rgba(0, 0, 0, 0.6); }
.hud-fallen-downed .dn-fill { position: absolute; inset: 0; transform-origin: left center; background: linear-gradient(90deg, #7a0d08, #e0301f 70%, #ff6a50); }
.hud-fallen-downed.critical .dn-fill { animation: sg-dn-blink 0.5s steps(2, jump-none) infinite; }
.hud-fallen-downed.saving .dn-fill { background: linear-gradient(90deg, #6b5410, #d6ad52); }
.hud-fallen-downed.saving .dn-track { border-color: rgba(159, 232, 168, 0.7); }
@keyframes sg-dn-blink { 50% { filter: brightness(1.6); } }
.hud-fallen-downed .dn-secs { min-width: ${u(84)}; text-align: right; font-size: ${fs(30, 18)}; font-weight: 900; font-variant-numeric: tabular-nums; color: #fff; }
.hud-fallen-downed .dn-rescue { display: flex; align-items: center; gap: ${u(10)}; padding: ${u(6)} ${u(12)}; border-radius: ${u(5)}; background: rgba(12, 40, 20, 0.78); border: 1px solid rgba(120, 220, 140, 0.6); color: #c8f7cf; font-weight: 700; font-size: ${fs(16, 12)}; }
.hud-fallen-downed .dn-rtxt { flex: 0 0 auto; }
.hud-fallen-downed .dn-rtrack { position: relative; flex: 1; height: ${u(8)}; border-radius: ${u(4)}; overflow: hidden; background: rgba(0, 0, 0, 0.5); }
.hud-fallen-downed .dn-rtrack i { position: absolute; inset: 0; transform-origin: left center; background: #7fe09a; }
.hud-fallen-downed .dn-hints { display: flex; flex-direction: column; gap: ${u(5)}; padding: ${u(8)} ${u(12)}; border-radius: ${u(5)}; background: var(--hud-bg); border: 1px solid var(--hud-line); }
.hud-fallen-downed .dn-hint { display: flex; align-items: center; gap: ${u(10)}; font-size: ${fs(15, 11)}; }
.hud-fallen-downed .dn-hint .sg-key { flex: 0 0 auto; min-width: 2.2em; }
.hud-fallen-downed .dn-hint.good { color: #bdf5c4; font-weight: 700; }
.hud-fallen-downed .dn-hint.done { color: #f2d27a; }
.hud-fallen-downed .dn-hint.dim { opacity: 0.72; font-size: ${fs(13, 11)}; }
/* the one action that matters: bigger, framed; its key pulses when time runs short */
.hud-fallen-downed .dn-hint.best { font-size: ${fs(17, 12)}; font-weight: 800; padding: ${u(4)} ${u(6)}; margin: 0 ${u(-6)}; border-radius: ${u(4)}; background: rgba(255, 255, 255, 0.06); }
.hud-fallen-downed .dn-hint.best.good { background: rgba(60, 170, 90, 0.2); box-shadow: inset 0 0 0 1px rgba(127, 224, 154, 0.55); }
.hud-fallen-downed .dn-hint.urgent .sg-key { animation: sg-dn-key 0.55s ease-in-out infinite alternate; }
@keyframes sg-dn-key { from { transform: scale(1); box-shadow: 0 0 0 rgba(255, 90, 60, 0); } to { transform: scale(1.18); box-shadow: 0 0 ${u(12)} rgba(255, 90, 60, 0.95); } }
.hud-fallen-downed.collapsed .dn-hints { padding: ${u(6)} ${u(12)}; }
.hud-fallen-downed.collapsed .dn-hint.best { margin: 0; }
/* phones: the bar sits above the touch buttons, the guide card is gone while you are down */
.sg-hud.touch .hud-fallen-downed .dn-box { bottom: auto; top: 18%; width: min(420px, 70vw); }
.sg-hud.touch .hud-fallen-downed .dn-hint.dim { display: none; }

/* the moment of death: the world drains of colour while the camera pulls back over your body */
.sg-hud.dying::before { content: ''; position: absolute; inset: 0; pointer-events: none; -webkit-backdrop-filter: grayscale(1) brightness(0.7); backdrop-filter: grayscale(1) brightness(0.7); background: radial-gradient(ellipse at center, transparent 30%, rgba(40, 0, 0, 0.55)); animation: sg-dying 0.5s ease-out; }
@keyframes sg-dying { from { opacity: 0; } to { opacity: 1; } }

/* ── revive markers over downed heroes ─────────────────────────────── */
.hud-rv-marks { position: absolute; inset: 0; overflow: hidden; }
.rv-mark { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: center; gap: ${u(2)}; will-change: transform; }
.rv-mark .rv-ico { position: relative; display: grid; place-items: center; width: ${u(34)}; height: ${u(34)}; border-radius: 50%; background: radial-gradient(circle at 50% 35%, #ff7a5c, #b3261e 70%); border: 2px solid #ffe2b8; box-shadow: 0 0 ${u(10)} rgba(255, 60, 30, 0.7); font-family: var(--font-display); font-weight: 900; font-size: ${fs(18, 12)}; color: #fff; }
.rv-mark.called .rv-ico::after { content: ''; position: absolute; inset: ${u(-6)}; border-radius: 50%; border: 2px solid rgba(255, 110, 80, 0.9); animation: sg-rv-ping 1.2s ease-out infinite; }
@keyframes sg-rv-ping { from { transform: scale(0.8); opacity: 1; } to { transform: scale(1.7); opacity: 0; } }
.rv-mark.ally .rv-ico { border-color: #f2c14e; }
.rv-mark.reviving .rv-ico { background: radial-gradient(circle at 50% 35%, #9ff0b0, #1f7a3a 70%); border-color: #d9ffe0; box-shadow: 0 0 ${u(10)} rgba(60, 220, 110, 0.7); }
.rv-mark .rv-dist { font-size: ${fs(14, 11)}; font-weight: 900; color: #fff; padding: 0 ${u(6)}; border-radius: ${u(3)}; background: rgba(0, 0, 0, 0.55); }
.rv-mark.reviving .rv-dist { color: #bdf5c4; }
.rv-mark .rv-name { font-size: ${fs(12, 10)}; color: #ffd9c8; white-space: nowrap; }
/* your own victim: a dark red 倒 「补刀」 chip (never 救) */
.rv-mark.finish .rv-ico { background: radial-gradient(circle at 50% 35%, #5a1410, #1e0404 75%); border-color: #ff5a48; box-shadow: 0 0 ${u(8)} rgba(255, 40, 20, 0.6); color: #ff8a70; }
.rv-mark.finish .rv-dist { color: #ff9a80; background: rgba(60, 0, 0, 0.7); }
.rv-mark.finish .rv-name { color: #ffb8a8; }
.sg-hud.dead .hud-rv-marks { display: none; }

/* ── the reviver's ring around the crosshair ───────────────────────── */
.hud-rv-ring { position: absolute; left: 50%; top: 50%; transform: translate(-50%, ${u(-48)}); display: none; flex-direction: column; align-items: center; gap: ${u(8)}; }
.hud-rv-ring.on { display: flex; }
.hud-rv-ring .rr-wrap { position: relative; width: ${u(96)}; height: ${u(96)}; }
.hud-rv-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.hud-rv-ring circle { fill: none; stroke-width: 6; }
.hud-rv-ring circle.bg { stroke: rgba(0, 0, 0, 0.45); }
.hud-rv-ring circle.fg { stroke: #7fe09a; stroke-linecap: round; filter: drop-shadow(0 0 3px rgba(60, 220, 110, 0.8)); }
.hud-rv-ring .rr-pct { position: absolute; inset: 0; display: grid; place-items: center; font-size: ${fs(18, 12)}; font-weight: 900; color: #d9ffe0; }
.hud-rv-ring .rr-txt { font-size: ${fs(15, 11)}; font-weight: 700; color: #c8f7cf; background: var(--hud-bg); padding: ${u(3)} ${u(12)}; border-radius: ${u(4)}; white-space: nowrap; }
.sg-hud.reviving .hud-channel { display: none; }
/* 招魂: the ring glows the colour of the 魂幡 */
.hud-rv-ring.recall circle.fg { stroke: #b9a6ff; filter: drop-shadow(0 0 3px rgba(150, 120, 255, 0.85)); }
.hud-rv-ring.recall .rr-pct { color: #e4dcff; }
.hud-rv-ring.recall .rr-txt { color: #e4dcff; }

/* ── 击倒 stamp (the 斩 kill stamp is red and big; a knock is an amber badge between the
   announcements and the crosshair) ─────────────────────────────────────── */
.hud-knockstamp { position: absolute; left: 50%; top: 41%; display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto; column-gap: ${u(10)}; align-items: center; opacity: 0; transform: translate(-50%, -50%); padding: ${u(4)} ${u(14)} ${u(4)} ${u(6)}; border-radius: ${u(6)}; background: rgba(40, 22, 4, 0.55); }
.hud-knockstamp .ks-seal { grid-row: 1 / 3; display: grid; place-items: center; width: ${u(46)}; height: ${u(46)}; border-radius: ${u(8)}; background: #d98a1c; border: 2px solid #ffe2a0; box-shadow: 0 0 ${u(12)} rgba(255, 170, 40, 0.6); font-family: var(--font-display); font-size: ${fs(28, 18)}; font-weight: 900; color: #fff8e6; transform: rotate(-6deg); }
.hud-knockstamp .lbl { font-family: var(--font-display); font-size: ${fs(19, 13)}; font-weight: 800; color: #ffd27a; letter-spacing: 0.06em; white-space: nowrap; }
.hud-knockstamp .sub { font-size: ${fs(12, 10)}; color: #ffe8c0; opacity: 0.85; white-space: nowrap; }

/* ── death recap card ──────────────────────────────────────────────── */
.hud-deathcard { position: absolute; left: ${u(28)}; top: 50%; transform: translateY(-50%); width: ${u(500)}; max-width: calc(100vw - 32px); max-height: 84vh; overflow: auto; display: none; padding: ${u(18)} ${u(22)}; pointer-events: auto; z-index: 9; font-size: ${fs(15, 11)}; text-shadow: none; }
.hud-deathcard.on { display: block; }
.hud-deathcard .dc-head { display: flex; align-items: center; justify-content: space-between; gap: ${u(12)}; flex-wrap: wrap; margin-bottom: ${u(10)}; }
.hud-deathcard .dc-ttl { font-family: var(--font-display); font-size: ${fs(34, 20)}; font-weight: 900; color: #ff6a50; letter-spacing: 0.2em; }
.hud-deathcard .dc-role { display: flex; align-items: center; gap: ${u(8)}; padding: ${u(3)} ${u(10)}; border-radius: ${u(4)}; background: rgba(0, 0, 0, 0.35); font-size: ${fs(13, 11)}; color: #e8d8b8; }
.hud-deathcard .dc-role b { font-size: ${fs(17, 12)}; }
.hud-deathcard .dc-killer { display: flex; align-items: center; gap: ${u(12)}; padding: ${u(10)} ${u(12)}; border-radius: ${u(5)}; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(214, 173, 82, 0.35); }
.hud-deathcard .dc-ava { --sz: ${u(64)}; flex: 0 0 auto; }
.hud-deathcard .dc-kinfo { display: flex; flex-direction: column; gap: ${u(5)}; min-width: 0; flex: 1; }
.hud-deathcard .dc-line { display: flex; align-items: center; gap: ${u(8)}; font-size: ${fs(18, 13)}; font-weight: 800; color: #fff0d8; }
.hud-deathcard .dc-line .kf-how { height: ${u(26)}; width: auto; max-width: ${u(90)}; }
.hud-deathcard .dc-kstats { display: flex; align-items: center; gap: ${u(4)} ${u(8)}; flex-wrap: wrap; white-space: nowrap; font-size: ${fs(13, 11)}; color: #e8d8b8; }
.hud-deathcard .dc-hp { position: relative; width: ${u(80)}; flex: 0 1 auto; height: ${u(8)}; border-radius: ${u(4)}; overflow: hidden; background: rgba(0, 0, 0, 0.55); }
.hud-deathcard .dc-hp i { position: absolute; inset: 0; transform-origin: left center; background: linear-gradient(90deg, #2f9e4f, #7fe09a); }
.hud-deathcard .dc-krole { font-weight: 700; }
.hud-deathcard .dc-krole.unknown, .hud-deathcard .dc-krole.claim { color: #b9a37a; font-weight: 400; }
.hud-deathcard .dc-dist { opacity: 0.8; }
.hud-deathcard .dc-sub { font-size: ${fs(13, 11)}; color: #ffc07a; }
.hud-deathcard .dc-recap { margin-top: ${u(12)}; }
.hud-deathcard .dc-rhead { display: flex; justify-content: space-between; align-items: baseline; font-size: ${fs(13, 11)}; color: #cbb892; border-bottom: 1px solid rgba(214, 173, 82, 0.3); padding-bottom: ${u(4)}; margin-bottom: ${u(6)}; }
.hud-deathcard .dc-rhead b { color: #ff9a7a; font-size: ${fs(15, 12)}; }
.hud-deathcard .dc-rows { display: flex; flex-direction: column; gap: ${u(6)}; }
.hud-deathcard .dc-row { display: flex; align-items: center; gap: ${u(10)}; }
.hud-deathcard .dc-rava { --sz: ${u(34)}; flex: 0 0 auto; }
.hud-deathcard .dc-who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.hud-deathcard .dc-who .n { display: flex; align-items: center; gap: ${u(6)}; font-weight: 700; color: #f5ead0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud-deathcard .dc-who small { color: #b9a37a; font-size: ${fs(12, 10)}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud-deathcard .dc-tag { font-size: ${fs(11, 10)}; font-weight: 800; padding: 0 ${u(5)}; border-radius: ${u(3)}; }
.hud-deathcard .dc-tag.kill { background: #b3261e; color: #fff; }
.hud-deathcard .dc-tag.knock { background: #d98a1c; color: #fff; }
.hud-deathcard .dc-dmg { font-size: ${fs(20, 13)}; font-weight: 900; color: #ff9a7a; font-variant-numeric: tabular-nums; }
.hud-deathcard .dc-none { color: #b9a37a; }
.hud-deathcard .dc-drop { margin-top: ${u(8)}; font-size: ${fs(13, 11)}; color: #e8d8b8; }
.hud-deathcard .dc-drop::before { content: '◆ '; color: #d6ad52; }
.hud-deathcard .dc-soul { margin-top: ${u(8)}; padding: ${u(6)} ${u(10)}; border-radius: ${u(4)}; font-size: ${fs(13, 11)}; color: #d8d0ff; background: rgba(60, 40, 120, 0.35); border: 1px solid rgba(170, 150, 255, 0.45); }
.hud-deathcard .dc-soul.active { color: #fff; background: rgba(90, 60, 180, 0.55); border-color: #b9a6ff; }
.hud-deathcard .dc-actions { display: flex; gap: ${u(10)}; margin-top: ${u(14)}; }
.hud-deathcard .dc-actions .sg-btn { flex: 1; }
.hud-deathcard .dc-actions .sg-key { margin-left: ${u(6)}; font-size: 0.7em; }
.hud-deathcard .dc-note { margin-top: ${u(8)}; font-size: ${fs(12, 10)}; color: #b9a37a; }

/* phones / short windows: the recap is a centred sheet over the touch bar, the spectate panel waits behind it */
.sg-hud.touch .hud-deathcard { z-index: 24; }
@media (max-height: 520px) {
  .hud-deathcard { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, 78vw); max-height: calc(100vh - 16px); padding: 8px 14px; z-index: 24; }
  .hud-deathcard .dc-head { margin-bottom: 4px; }
  .hud-deathcard .dc-ttl { font-size: 20px; }
  .hud-deathcard .dc-ava { --sz: 44px; }
  .hud-deathcard .dc-killer { padding: 6px 8px; }
  .hud-deathcard .dc-recap { margin-top: 6px; }
  .hud-deathcard .dc-rows > :nth-child(n + 3) { display: none; }
  .hud-deathcard .dc-actions { margin-top: 8px; }
  .hud-deathcard .dc-note { display: none; }
  .hud-spectate2.on.behind-card { display: none; }
}
.sg-hud.touch .hud-deathcard .dc-actions .sg-key { display: none; }

/* ── spectate panel ────────────────────────────────────────────────── */
.hud-spectate2 { position: absolute; left: 50%; bottom: ${u(26)}; transform: translateX(-50%); display: none; flex-direction: column; align-items: center; gap: ${u(6)}; padding: ${u(10)} ${u(18)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: ${u(6)}; pointer-events: auto; z-index: 8; min-width: ${u(460)}; }
.hud-spectate2.on { display: flex; }
.hud-spectate2 .sp-ttl { font-family: var(--font-display); font-size: ${fs(18, 13)}; font-weight: 900; color: #ff8a6a; letter-spacing: 0.15em; }
.hud-spectate2 .sp-main { display: flex; align-items: center; gap: ${u(12)}; }
.hud-spectate2 .sp-target { display: flex; align-items: center; gap: ${u(10)}; min-width: ${u(300)}; }
.hud-spectate2 .sp-face:empty { display: none; }
.hud-spectate2 .sp-face .sg-ava { --sz: ${u(44)}; }
.hud-spectate2 .sp-col { display: flex; flex-direction: column; gap: ${u(4)}; min-width: 0; flex: 1; }
.hud-spectate2 .sp-line { display: flex; align-items: center; gap: ${u(8)}; font-size: ${fs(16, 12)}; font-weight: 700; white-space: nowrap; }
.hud-spectate2 .sp-tag { font-size: ${fs(11, 10)}; font-weight: 800; padding: 0 ${u(6)}; border-radius: ${u(3)}; background: #b3261e; color: #fff; }
.hud-spectate2 .sp-role { display: inline-flex; align-items: center; gap: ${u(4)}; font-size: ${fs(13, 11)}; }
.hud-spectate2 .sp-role .claim { color: #cbb892; font-weight: 400; }
.hud-spectate2 .sp-hp { display: flex; align-items: center; gap: ${u(8)}; }
.hud-spectate2 .sp-track { position: relative; flex: 1; height: ${u(7)}; border-radius: ${u(4)}; overflow: hidden; background: rgba(0, 0, 0, 0.55); }
.hud-spectate2 .sp-track i { position: absolute; inset: 0; transform-origin: left center; background: linear-gradient(90deg, #2f9e4f, #7fe09a); }
.hud-spectate2 .sp-hpt { font-size: ${fs(12, 10)}; color: #e8d8b8; white-space: nowrap; }
.hud-spectate2 .sp-foot { display: flex; align-items: center; gap: ${u(10)}; font-size: ${fs(12, 10)}; color: #cbb892; }
.hud-spectate2 .sp-soul { font-size: ${fs(13, 11)}; color: #d8d0ff; padding: ${u(2)} ${u(10)}; border-radius: ${u(4)}; background: rgba(60, 40, 120, 0.35); }
.hud-spectate2 .sp-soul.active { color: #fff; background: rgba(90, 60, 180, 0.6); }
.hud-spectate2 .sp-hint { margin-right: ${u(6)}; }
.hud-spectate2.behind-card .sp-ttl { display: none; }
`;
