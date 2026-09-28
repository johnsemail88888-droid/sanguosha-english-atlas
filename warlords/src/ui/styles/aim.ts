// Aiming on the HUD (src/ui/hud/aim.ts): per-class crosshair tweaks, hit / knock
// / kill markers, the scope lens overlay, near sights (red dot, holo, iron), the
// bow's draw ring, the weapon stat card and the pickup comparison.
const u = (n: number): string => `calc(var(--u) * ${n})`;
const fs = (n: number, min = 11): string => `max(${min}px, calc(var(--u) * ${n}))`;

/** Lens radius of the sniper scope / the marksman scope. */
const R_SCOPE = 'min(44vh, 42vw)';
const R_DMR = 'min(47vh, 45vw)';

export const AIM_CSS = /* css */ `
/* ── crosshair per class (the base look: styles/hud.ts) ─── */
.hud-xhair[data-cls="pistol"] { --len: ${u(7)}; }
.hud-xhair[data-cls="smg"] { --len: ${u(8)}; }
.hud-xhair[data-cls="lmg"] { --th: 3px; --len: ${u(13)}; }
.hud-xhair[data-cls="dmr"] { --th: 1.5px; --len: ${u(14)}; }
.hud-xhair[data-cls="crossbow"] .chev { border-radius: 0; }

/* ── hit / knock / kill markers (visible through a scope too) ── */
.hud-hitmark { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
.hitmarker[data-kind="down"] { width: ${u(36)}; height: ${u(36)}; }
.hitmarker[data-kind="down"] i { background: #ffa23a; width: 3px; }
.hitmarker[data-kind="down"] i:nth-child(3), .hitmarker[data-kind="down"] i:nth-child(4) { height: 3px; width: 32%; }
.hitmarker[data-kind="kill"] { width: ${u(46)}; height: ${u(46)}; }
.hitmarker[data-kind="kill"] i { width: 4px; box-shadow: 0 0 3px #000, 0 0 6px rgba(255, 60, 40, 0.8); }
.hitmarker[data-kind="kill"] i:nth-child(3), .hitmarker[data-kind="kill"] i:nth-child(4) { height: 4px; width: 34%; }
.hm-ring { position: absolute; left: 0; top: 0; width: ${u(70)}; height: ${u(70)}; border-radius: 50%; border: 3px solid #ff4a3a; box-shadow: 0 0 8px rgba(255, 60, 40, 0.7); opacity: 0; transform: translate(-50%, -50%); }
.hm-ring[data-kind="down"] { border-color: #ffa23a; box-shadow: 0 0 6px rgba(255, 160, 60, 0.6); border-width: 2px; }

/* ── scope lens overlay (sniper / marksman) ──────────────── */
.hud-scope { position: absolute; inset: 0; display: none; overflow: hidden; pointer-events: none; }
.hud-scope.on { display: block; }
/* looking through a scope: no F prompt inside the lens under the reticle (COMBAT-11) */
.hud-scope.on ~ .hud-interact { visibility: hidden; }
.hud-scope .sc-lens { --r: ${R_SCOPE}; position: absolute; left: 50%; top: 50%; width: calc(var(--r) * 2); height: calc(var(--r) * 2); border-radius: 50%; transform: translate(-50%, -50%);
  box-shadow: inset 0 0 calc(var(--r) * 0.18) calc(var(--r) * 0.02) rgba(0, 0, 0, 0.85), inset 0 0 0 2px rgba(120, 170, 200, 0.25), 0 0 0 3px #0b0b0b, 0 0 0 200vmax #000;
  background: radial-gradient(circle at 34% 30%, rgba(255, 255, 255, 0.07), transparent 38%), radial-gradient(circle, transparent 72%, rgba(40, 60, 80, 0.18) 100%); }
.hud-scope[data-kind="marksman"] .sc-lens { --r: ${R_DMR}; box-shadow: inset 0 0 calc(var(--r) * 0.14) rgba(0, 0, 0, 0.8), 0 0 0 ${u(12)} #16130f, 0 0 0 ${u(14)} #2a241a, 0 0 0 200vmax rgba(4, 3, 2, 0.9); }
.hud-scope .sc-ret { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; }
.hud-scope .sc-svg { width: 100%; height: 100%; display: block; }
.hud-scope .sc-svg .ctr { filter: drop-shadow(0 0 1.2px #ff5030); }
.hud-scope .sc-svg .chev { filter: drop-shadow(0 0 1.6px rgba(255, 170, 40, 0.9)); }
.hud-scope .sc-zoom { position: absolute; right: 17%; bottom: 15%; font-family: var(--font-display); font-weight: 900; font-size: ${fs(20, 13)}; color: #ffcf6a; text-shadow: 0 0 3px #000, 0 1px 0 #000; }
.hud-scope .sc-hint { position: absolute; left: 50%; top: 83%; transform: translateX(-50%); padding: ${u(2)} ${u(12)}; font-size: ${fs(13, 11)}; white-space: nowrap; color: #f5ead0; background: rgba(0, 0, 0, 0.55); border-radius: 999px; }
.hud-scope .sc-hint:empty { display: none; }
.hud-scope .sc-hint.warn { color: #ffb09a; }
.hud-scope .sc-breath { position: absolute; left: 50%; top: 78%; width: 22%; height: ${u(5)}; transform: translateX(-50%); background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 999px; overflow: hidden; display: none; }
.hud-scope .sc-breath.on { display: block; }
.hud-scope .sc-breath i { position: absolute; inset: 0; background: linear-gradient(90deg, #7ab8ff, #cfe6ff); transform-origin: left center; }
.hud-scope .sc-breath.low i { background: linear-gradient(90deg, #ff6a4a, #ffb09a); }
.hud-scope .sc-blink { position: absolute; inset: 0; background: #000; opacity: 0; }

/* ── near sights: red dot / holo / iron, and the bow's draw ── */
.hud-sight { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; pointer-events: none; }
.hud-sight:not(.on) { visibility: hidden; }
.hud-sight .ns-svg { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); overflow: visible; }
.hud-sight[data-kind="reddot"] .ns-svg { width: min(26vh, 24vw); height: min(26vh, 24vw); }
.hud-sight[data-kind="holo"] .ns-svg { width: min(30vh, 28vw); height: min(30vh, 28vw); }
.hud-sight[data-kind="iron"] .ns-svg { width: min(13vh, 12vw); height: min(13vh, 12vw); }
.hud-sight .glass { fill: rgba(150, 205, 255, 0.07); }
.hud-sight.tps :is(.glass, .rim) { display: none; }
.hud-sight .rim { fill: none; stroke: rgba(12, 12, 12, 0.72); stroke-width: 4; }
.hud-sight[data-kind="holo"] .rim { stroke-width: 3.2; stroke: rgba(12, 12, 12, 0.6); }
.hud-sight .dotc { fill: #ff3020; filter: drop-shadow(0 0 1.6px #ff2a10) drop-shadow(0 0 3px rgba(255, 40, 20, 0.7)); }
.hud-sight .lit { stroke: #ff3a26; fill: none; filter: drop-shadow(0 0 1.4px rgba(255, 50, 30, 0.9)); }
.hud-sight .metal { fill: #17171a; stroke: rgba(255, 255, 255, 0.22); stroke-width: 0.6; opacity: 0.92; }
.hud-sight .tri { fill: #d8ffb0; filter: drop-shadow(0 0 1.2px rgba(170, 255, 120, 0.9)); }
.hud-draw { position: absolute; left: 0; top: 0; width: ${u(64)}; height: ${u(64)}; transform: translate(-50%, -50%); display: none; }
.hud-sight[data-kind="bow"] .hud-draw { display: block; }
.hud-draw .dr-svg { width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
.hud-draw .trk { fill: none; stroke: rgba(255, 255, 255, 0.22); stroke-width: 2.2; }
.hud-draw .arc { fill: none; stroke: #e8b14a; stroke-width: 2.8; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; filter: drop-shadow(0 0 1px #000); }
.hud-draw.full .arc { stroke: #ffe08a; filter: drop-shadow(0 0 3px rgba(255, 210, 90, 0.95)); }
.hud-draw.tired .arc { stroke: #ff6a4a; }
.hud-draw.tired { animation: sg-draw-shake 0.18s linear infinite; }
.hud-draw .dr-lbl { position: absolute; left: 50%; top: calc(100% + ${u(4)}); transform: translateX(-50%); font-size: ${fs(12, 10)}; font-weight: 700; color: #ffe08a; white-space: nowrap; }
.hud-draw.tired .dr-lbl { color: #ff9a7a; }
@keyframes sg-draw-shake { 0% { margin-left: 0; } 25% { margin-left: 1.5px; } 75% { margin-left: -1.5px; } 100% { margin-left: 0; } }

/* ── weapon stat card / pickup comparison ─────────────────── */
.hud-wcard, .hud-lootcmp { --rc: #b9b2a2; position: absolute; width: ${u(300)}; padding: ${u(8)} ${u(12)} ${u(8)} ${u(12)}; background: linear-gradient(270deg, rgba(18, 12, 7, 0.92), rgba(18, 12, 7, 0.76)); border: 1px solid var(--hud-line); border-radius: ${u(6)}; pointer-events: none; }
.hud-wcard { right: ${u(16)}; bottom: ${u(154)}; border-right: ${u(4)} solid var(--rc); opacity: 0; transform: translateY(${u(10)}); transition: opacity 0.25s, transform 0.25s; visibility: hidden; }
.hud-wcard.on { opacity: 1; transform: none; visibility: visible; }
.hud-lootcmp { left: 50%; top: calc(50% + ${u(116)}); transform: translateX(-50%); border-left: ${u(4)} solid var(--rc); display: none; }
.hud-lootcmp.on { display: block; }
.wst-head { display: flex; align-items: center; gap: ${u(7)}; font-size: ${fs(12.5, 10)}; color: #e0cfa2; }
.wst-icon { width: ${u(46)}; height: ${u(19)}; flex: none; fill: var(--rc); color: var(--rc); filter: drop-shadow(0 1px 0 #000); }
.wst-cls { font-weight: 800; letter-spacing: 0.04em; }
.wst-rar { margin-left: auto; font-weight: 800; color: var(--rc); }
.wst-vs { margin-left: auto; font-size: 0.92em; opacity: 0.85; white-space: nowrap; }
.wst-name { font-family: var(--font-display); font-size: ${fs(19, 13)}; font-weight: 900; margin: ${u(2)} 0 ${u(6)}; color: #fff2d6; }
.wst-card { font-size: 0.68em; color: var(--gold-hi); margin-left: ${u(4)}; }
.wst-row { display: grid; grid-template-columns: ${u(46)} 1fr ${u(56)} ${u(12)}; align-items: center; column-gap: ${u(7)}; font-size: ${fs(12.5, 10)}; line-height: 1.55; }
.wst-lbl { color: #d9c9a0; }
.wst-bar { position: relative; height: ${u(7)}; background: rgba(255, 255, 255, 0.1); border-radius: ${u(3)}; overflow: hidden; }
.wst-bar > i, .wst-bar > u { position: absolute; inset: 0; transform-origin: left center; border-radius: inherit; }
.wst-bar > u { background: rgba(255, 255, 255, 0.34); }
.wst-bar > i { background: linear-gradient(90deg, color-mix(in srgb, var(--rc) 65%, #fff 20%), var(--rc)); opacity: 0.95; }
.wst-val { text-align: right; font-variant-numeric: tabular-nums; color: #fff2d6; white-space: nowrap; }
.wst-d { font-size: 0.8em; text-align: center; }
.wst-d.up { color: #7fe09a; }
.wst-d.dn { color: #ff7a6a; }
.wst-aim { margin-top: ${u(6)}; font-size: ${fs(12, 10)}; color: #cfe2ff; opacity: 0.92; }
.sg-hud.dead :is(.hud-wcard, .hud-lootcmp, .hud-sight), .sg-hud.downed :is(.hud-wcard, .hud-lootcmp) { display: none; }
/* touch: the weapon panel sits top right with the kill feed under it — the card goes top centre, under the zone timer */
.sg-hud.touch .hud-wcard { bottom: auto; right: auto; left: 50%; top: ${u(78)}; transform: translate(-50%, ${u(-8)}); }
.sg-hud.touch .hud-wcard.on { transform: translate(-50%, 0); }
.sg-hud.touch .hud-lootcmp { display: none; }
@media (max-height: 560px) { .hud-wcard .wst-aim { display: none; } .hud-lootcmp { top: calc(50% + ${u(104)}); } }
`;
