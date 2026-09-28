// Aiming on the HUD (src/ui/hud/aim.ts): per-class crosshair tweaks, hit / knock
// / kill markers, the scope lens overlay, near sights (red dot, holo, iron), the
// bow's draw ring, the weapon stat card and the pickup comparison.
const u = (n: number): string => `calc(var(--u) * ${n})`;
const fs = (n: number, min = 11): string => `max(${min}px, calc(var(--u) * ${n}))`;

/** Lens radius of the sniper scope; the marksman near sight's window (55 % of the screen height across). */
const R_SCOPE = 'min(44vh, 42vw)';
const R_MARKSMAN = 'min(27.5vh, 30vw)';

export const AIM_CSS = /* css */ `
/* ── crosshair per class (the base look: styles/hud.ts) ─── */
/* third person, a wall between your eye and the crosshair point: the crosshair greys (the mark: .am-blocked) */
.hud-xhair.blocked { color: rgba(170, 170, 170, 0.75); }
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
/* a headshot: a gold X with longer arms */
.hitmarker[data-kind="head"] { width: ${u(40)}; height: ${u(40)}; }
.hitmarker[data-kind="head"] i { height: 40%; }
.hitmarker[data-kind="head"] i:nth-child(3), .hitmarker[data-kind="head"] i:nth-child(4) { width: 40%; height: 3px; }
.hitmarker[data-kind="kill"] { width: ${u(46)}; height: ${u(46)}; }
.hitmarker[data-kind="kill"] i { width: 4px; box-shadow: 0 0 3px #000, 0 0 6px rgba(255, 60, 40, 0.8); }
.hitmarker[data-kind="kill"] i:nth-child(3), .hitmarker[data-kind="kill"] i:nth-child(4) { height: 4px; width: 34%; }
.hm-ring { position: absolute; left: 0; top: 0; width: ${u(70)}; height: ${u(70)}; border-radius: 50%; border: 3px solid #ff4a3a; box-shadow: 0 0 8px rgba(255, 60, 40, 0.7); opacity: 0; transform: translate(-50%, -50%); }
.hm-ring[data-kind="down"] { border-color: #ffa23a; box-shadow: 0 0 6px rgba(255, 160, 60, 0.6); border-width: 2px; }

/* ── scope lens overlay (sniper / marksman) ──────────────── */
.hud-scope { position: absolute; inset: 0; display: none; overflow: hidden; pointer-events: none; }
.hud-scope.on { display: block; }
/* looking through a scope: no F prompt inside the lens under the reticle (COMBAT-11), no first-match guide over the lens edge */
.hud-scope.on ~ .hud-interact { visibility: hidden; }
.sg-hud:has(.hud-scope.on) .hud-guide { visibility: hidden; }
/* a holdover ladder on screen (launchers, bows): the F prompt steps under it */
.sg-hud:has(.am-ladder.on) .hud-interact { top: calc(50% + ${u(118)}); }
/* a marksman near sight up: the F prompt goes under its (bigger) window */
.sg-hud:has(.hud-sight.on[data-kind="marksman"]) .hud-interact { top: calc(50% + ${R_MARKSMAN} + ${u(58)}) !important; }
/* red dot / holo / reflex / iron sights up: the F prompt steps below the sight's window */
.sg-hud:has(.hud-sight.on:not([data-kind="bow"])) .hud-interact { top: calc(50% + min(17vh, 16vw)); opacity: 0.7; }
.hud-scope .sc-lens { --r: ${R_SCOPE}; position: absolute; left: 50%; top: 50%; width: calc(var(--r) * 2); height: calc(var(--r) * 2); border-radius: 50%; transform: translate(-50%, -50%);
  box-shadow: inset 0 0 calc(var(--r) * 0.18) calc(var(--r) * 0.02) rgba(0, 0, 0, 0.85), inset 0 0 0 2px rgba(120, 170, 200, 0.25), 0 0 0 3px #0b0b0b, 0 0 0 200vmax #000;
  background: radial-gradient(circle at 34% 30%, rgba(255, 255, 255, 0.07), transparent 38%), radial-gradient(circle, transparent 72%, rgba(40, 60, 80, 0.18) 100%); }
.hud-scope .sc-ret { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; }
.hud-scope .sc-svg { width: 100%; height: 100%; display: block; }
.hud-scope .sc-svg .ctr { filter: drop-shadow(0 0 1.2px #ff5030); }
.hud-scope .sc-zoom { position: absolute; right: 17%; bottom: 15%; font-family: var(--font-display); font-weight: 900; font-size: ${fs(20, 13)}; color: #ffcf6a; text-shadow: 0 0 3px #000, 0 1px 0 #000; }
/* rangefinder: metres to the crosshair point, amber beyond the gun's full-damage range */
.hud-scope .sc-range { position: absolute; right: 17%; top: 56%; font-family: var(--font-body); font-weight: 800; font-size: ${fs(15, 11)}; font-variant-numeric: tabular-nums; color: #d8f0d0; text-shadow: 0 0 3px #000, 0 1px 0 #000; }
.hud-scope .sc-range::before { content: '◁ '; opacity: 0.7; }
.hud-scope .sc-range.far { color: #ffb42a; }
.hud-scope .sc-hint { position: absolute; left: 50%; top: 83%; transform: translateX(-50%); padding: ${u(2)} ${u(12)}; font-size: ${fs(13, 11)}; white-space: nowrap; color: #f5ead0; background: rgba(0, 0, 0, 0.55); border-radius: 999px; }
.hud-scope .sc-hint:empty { display: none; }
.hud-scope .sc-hint.warn { color: #ffb09a; }
.hud-scope .sc-breath { position: absolute; left: 50%; top: 78%; width: 22%; height: ${u(5)}; transform: translateX(-50%); background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 999px; overflow: hidden; display: none; }
.hud-scope .sc-breath.on { display: block; }
.hud-scope .sc-breath i { position: absolute; inset: 0; background: linear-gradient(90deg, #7ab8ff, #cfe6ff); transform-origin: left center; }
.hud-scope .sc-breath.low i { background: linear-gradient(90deg, #ff6a4a, #ffb09a); }
.hud-scope .sc-blink { position: absolute; inset: 0; background: #000; opacity: 0; }
/* after a shot of a slow gun: the next round chambering (the scoped bow: the next arrow nocked) */
.hud-scope .sc-bolt { position: absolute; left: 17%; bottom: 15%; display: none; align-items: center; gap: ${u(6)}; font-size: ${fs(13, 11)}; font-weight: 800; color: #ffcf6a; text-shadow: 0 0 3px #000, 0 1px 0 #000; }
.hud-scope .sc-bolt.on { display: flex; }
.hud-scope .bl-svg { width: ${u(26)}; height: ${u(26)}; transform: rotate(-90deg); overflow: visible; }
.hud-scope .bl-svg .trk { fill: none; stroke: rgba(255, 255, 255, 0.25); stroke-width: 4; }
.hud-scope .bl-svg .arc { fill: none; stroke: #ffcf6a; stroke-width: 5; stroke-dasharray: 100; stroke-dashoffset: 100; filter: drop-shadow(0 0 1px #000); }
/* touch, scoped: 4×/8× (the wheel on desktop) and 屏息 (hold breath, Shift on desktop) — 56 px, above the fire thumb's buttons */
.hud-scopebtn { --b: clamp(44px, 12vmin, 62px); display: none; position: absolute; z-index: 6; width: 56px; height: 56px; border-radius: 50%; border: 2px solid rgba(255, 207, 106, 0.85); background: rgba(12, 9, 6, 0.82); color: #ffcf6a; font-family: var(--font-display); font-weight: 900; font-size: 15px; line-height: 1; padding: 0; pointer-events: auto; touch-action: none; }
/* (above the 镜 / 跃 buttons, clear of the skill buttons and the minimap) */
.hud-zoombtn { right: calc(var(--b) * 2.8); bottom: calc(var(--b) * 3.6); }
.hud-breathbtn { right: calc(var(--b) * 1.4); bottom: calc(var(--b) * 3.4); color: #cfe6ff; border-color: rgba(150, 200, 255, 0.85); }
.hud-breathbtn.down, .hud-breathbtn.holding { background: rgba(40, 90, 160, 0.9); color: #fff; }
.hud-breathbtn.winded { border-color: #ff8a6a; color: #ffb09a; }
.sg-hud.touch .hud-scopebtn.on { display: grid; place-items: center; }
.sg-hud.touch .hud-scope .sc-zoom { display: none; }
/* a phone: the lens hint and the breath meter sit above the vitals panel */
.sg-hud.touch .hud-scope .sc-hint { top: 62%; }
.sg-hud.touch .hud-scope .sc-breath { top: 58.5%; }

/* ── near sights: red dot / holo / iron, and the bow's draw ── */
.hud-sight { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; pointer-events: none; }
.hud-sight:not(.on) { visibility: hidden; }
.hud-sight .ns-svg { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); overflow: visible; }
.hud-sight[data-kind="reddot"] .ns-svg { width: min(26vh, 24vw); height: min(26vh, 24vw); }
.hud-sight[data-kind="holo"] .ns-svg { width: min(30vh, 28vw); height: min(30vh, 28vw); }
.hud-sight[data-kind="iron"] .ns-svg { width: min(13vh, 12vw); height: min(13vh, 12vw); }
.hud-sight[data-kind="reflex"] .ns-svg { width: min(32vh, 30vw); height: min(32vh, 30vw); }
/* the marksman near sight (DMRs): a round window 55 % of the screen height across, the gun still in view */
.hud-sight[data-kind="marksman"] .ns-svg { width: calc(${R_MARKSMAN} * 2); height: calc(${R_MARKSMAN} * 2); }
.hud-sight[data-kind="marksman"] .glass { fill: rgba(170, 215, 255, 0.05); }
.hud-sight[data-kind="marksman"] .rim { stroke: rgba(10, 9, 8, 0.9); stroke-width: 7; filter: drop-shadow(0 0 5px rgba(0, 0, 0, 0.7)); }
.hud-sight .mk-lines { stroke: #0c0c0c; fill: none; }
.hud-sight .mk-stadia { stroke: #111; fill: none; }
.hud-sight .st-lbl { fill: #111; stroke: none; font: 700 6.5px var(--font-body); text-anchor: middle; }
.hud-sight .mk-chev { stroke: #ffb42a; filter: drop-shadow(0 0 1.6px rgba(255, 170, 40, 0.95)); }
.hud-sight.tps .mk-lines, .hud-sight.tps .mk-stadia { stroke: rgba(255, 244, 220, 0.85); }
.hud-sight.tps .st-lbl { fill: rgba(255, 244, 220, 0.9); }
.hud-sight .ns-breath, .hud-sight .ns-hint { display: none; }
.hud-sight[data-kind="marksman"] .ns-breath.on { display: block; position: absolute; left: 0; top: calc(${R_MARKSMAN} + ${u(14)}); width: ${u(150)}; height: ${u(5)}; transform: translateX(-50%); background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 999px; overflow: hidden; }
.hud-sight .ns-breath i { position: absolute; inset: 0; background: linear-gradient(90deg, #7ab8ff, #cfe6ff); transform-origin: left center; }
.hud-sight .ns-breath.low i { background: linear-gradient(90deg, #ff6a4a, #ffb09a); }
.hud-sight[data-kind="marksman"] .ns-hint:not(:empty) { display: block; position: absolute; left: 0; top: calc(${R_MARKSMAN} + ${u(26)}); transform: translateX(-50%); padding: ${u(2)} ${u(12)}; font-size: ${fs(13, 11)}; white-space: nowrap; color: #f5ead0; background: rgba(0, 0, 0, 0.55); border-radius: 999px; }
.hud-sight .ns-hint.warn { color: #ffb09a; }
.hud-sight .glass { fill: rgba(150, 205, 255, 0.07); }
.hud-sight.tps :is(.glass, .rim) { display: none; }
.hud-sight .rim { fill: none; stroke: rgba(12, 12, 12, 0.72); stroke-width: 4; }
.hud-sight[data-kind="holo"] .rim { stroke-width: 3.2; stroke: rgba(12, 12, 12, 0.6); }
.hud-sight .dotc { fill: #ff3020; filter: drop-shadow(0 0 1.6px #ff2a10) drop-shadow(0 0 3px rgba(255, 40, 20, 0.7)); }
.hud-sight .lit { stroke: #ff3a26; fill: none; filter: drop-shadow(0 0 1.4px rgba(255, 50, 30, 0.9)); }
.hud-sight .lit-g { stroke: #62ff72; fill: none; filter: drop-shadow(0 0 1.4px rgba(60, 255, 90, 0.9)); }
.hud-sight .metal { fill: #17171a; stroke: rgba(255, 255, 255, 0.22); stroke-width: 0.6; opacity: 0.92; }
.hud-sight .tri { fill: #d8ffb0; filter: drop-shadow(0 0 1.2px rgba(170, 255, 120, 0.9)); }
.hud-draw { position: absolute; left: 0; top: 0; width: ${u(64)}; height: ${u(64)}; transform: translate(-50%, -50%); display: none; }
.hud-sight[data-kind="bow"] .hud-draw { display: block; }
/* a scoped bow (烈弓): the draw ring sits in the lens's lower-left quarter, clear of the reticle's lines */
.hud-sight.in-scope .hud-draw { left: calc(${R_SCOPE} * -0.3); top: calc(${R_SCOPE} * 0.3); width: ${u(46)}; height: ${u(46)}; }
/* a phone's lens hint rides higher (above the vitals), so the ring steps further left of it */
.sg-hud.touch .hud-sight.in-scope .hud-draw { left: calc(${R_SCOPE} * -0.58); top: calc(${R_SCOPE} * 0.22); }
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
/* the first-match guide holds the right edge: the card goes top left, under the role chip */
.sg-hud:not(.touch):has(.hud-guide) .hud-wcard { right: auto; bottom: auto; left: ${u(16)}; top: ${u(84)}; border-right: 1px solid var(--hud-line); border-left: ${u(4)} solid var(--rc); }
.hud-lootcmp { left: 50%; top: calc(50% + ${u(116)}); transform: translateX(-50%); border-left: ${u(4)} solid var(--rc); display: none; }
.hud-lootcmp.on { display: block; }
.wst-head { display: flex; align-items: center; gap: ${u(7)}; font-size: ${fs(12.5, 10)}; color: #e0cfa2; }
.wst-icon { width: ${u(46)}; height: ${u(19)}; flex: none; fill: var(--rc); color: var(--rc); filter: drop-shadow(0 1px 0 #000); }
.wst-cls { font-weight: 800; letter-spacing: 0.04em; }
.wst-rar { margin-left: auto; font-weight: 800; color: var(--rc); }
.wst-vs { margin-left: auto; font-size: 0.92em; opacity: 0.85; white-space: nowrap; }
.wst-name { font-family: var(--font-display); font-size: ${fs(19, 13)}; font-weight: 900; margin: ${u(2)} 0 ${u(6)}; color: #fff2d6; }
.wst-card { font-size: 0.68em; color: var(--gold-hi); margin-left: ${u(4)}; }
.wst-row { display: grid; grid-template-columns: max(${u(58)}, 4.3em) 1fr ${u(56)} ${u(12)}; align-items: center; column-gap: ${u(7)}; font-size: ${fs(12.5, 10)}; line-height: 1.55; }
.wst-lbl { color: #d9c9a0; }
.wst-bar { position: relative; height: ${u(7)}; background: rgba(255, 255, 255, 0.1); border-radius: ${u(3)}; overflow: hidden; }
.wst-bar > i, .wst-bar > u { position: absolute; inset: 0; transform-origin: left center; border-radius: inherit; }
.wst-bar > u { background: rgba(255, 255, 255, 0.34); }
.wst-bar > i { background: linear-gradient(90deg, color-mix(in srgb, var(--rc) 65%, #fff 20%), var(--rc)); opacity: 0.95; }
.wst-val { text-align: right; font-variant-numeric: tabular-nums; color: #fff2d6; white-space: nowrap; }
.wst-d { font-size: 0.8em; text-align: center; }
.wst-d.up { color: #7fe09a; }
.wst-d.dn { color: #ff7a6a; }
/* the 5 / 20 / 50 m time-to-kill strip: green where the gun wins, grey where it cannot kill */
.wst-ttk { display: grid; grid-template-columns: max(${u(58)}, 4.3em) repeat(3, 1fr); column-gap: ${u(5)}; align-items: center; margin-top: ${u(4)}; font-size: ${fs(12.5, 10)}; }
.wst-ttk .tt { display: flex; align-items: baseline; justify-content: center; gap: ${u(3)}; padding: ${u(1)} 0; border-radius: ${u(3)}; background: rgba(255, 255, 255, 0.07); font-variant-numeric: tabular-nums; font-weight: 800; white-space: nowrap; }
.wst-ttk .tt i { font-style: normal; font-weight: 600; font-size: 0.8em; opacity: 0.75; }
.wst-ttk .tt.fast { color: #8ff0a4; background: rgba(60, 170, 90, 0.2); }
.wst-ttk .tt.ok { color: #ffe08a; }
.wst-ttk .tt.slow { color: #ffab8a; }
.wst-ttk .tt.none { color: rgba(255, 255, 255, 0.4); }
.wst-ttk .wst-d { margin-left: 1px; }
.wst-aim { margin-top: ${u(6)}; font-size: ${fs(12, 10)}; color: #cfe2ff; opacity: 0.92; }
.wst-aim > span { white-space: nowrap; }
.sg-hud.dead :is(.hud-wcard, .hud-lootcmp, .hud-sight), .sg-hud.downed :is(.hud-wcard, .hud-lootcmp) { display: none; }
/* touch: the weapon panel sits top right with the kill feed under it — the card goes top centre, under the zone timer */
.sg-hud.touch .hud-wcard { bottom: auto; right: auto; left: 50%; top: ${u(78)}; transform: translate(-50%, ${u(-8)}); }
.sg-hud.touch .hud-wcard.on { transform: translate(-50%, 0); }
.sg-hud.touch .hud-lootcmp { display: none; }
@media (max-height: 560px) { .hud-wcard .wst-aim { display: none; } .hud-lootcmp { top: calc(50% + ${u(104)}); } }
/* hero detail / help: how a weapon aims (the in-match stat card's aim line) */
.sg-weapon-card > .wc-aim { grid-column: 1 / -1; margin: 0 0 0.2em; font-size: 0.84em; font-weight: 600; color: #6a4414; }
.sg-weapon-card > .wc-aim > span { white-space: nowrap; }
.sg-table.weapons td.sight { white-space: nowrap; }
.sg-table.weapons.feel td.desc { min-width: 12em; }
/* ── aim marks (ui/hud/aimMarks.ts): holdover ladder, impact diamond, blocked shot, 方天 locks ── */
.hud-aimmarks { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.am-ladder { position: absolute; left: 50%; top: 50%; width: 0; height: 0; display: none; filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000); }
.am-ladder.on { display: block; }
.am-ladder .tk { position: absolute; left: 0; width: 0; height: 0; }
/* short centred ticks; the range on the left (the impact diamond's distance is on the right) — outside a bow's draw ring */
.am-ladder { --lx: ${u(16)}; }
.am-ladder[data-kind="bow"] { --lx: ${u(36)}; }
.am-ladder .tk b { position: absolute; left: calc(${u(-9)} * var(--w, 1)); top: -1px; width: calc(${u(18)} * var(--w, 1)); height: 2px; background: rgba(255, 255, 255, 0.92); }
.am-ladder .tk span { position: absolute; right: var(--lx); top: 0; transform: translateY(-52%); font: 700 ${fs(11.5, 10)} var(--font-body); color: #fff; white-space: nowrap; }
.am-ladder .tk span:empty { display: none; }
.am-ladder[data-kind="bow"] .tk::after { content: ''; position: absolute; right: calc(var(--lx) - ${u(26)}); top: -0.5px; width: ${u(22)}; height: 1px; background: rgba(255, 255, 255, 0.35); }
/* inside 烈弓's lens: dark marks on the bright glass */
.am-ladder.in-scope { filter: none; }
.am-ladder.in-scope .tk b { background: #0a0a0a; }
.am-ladder.in-scope .tk span { color: #0a0a0a; font-weight: 800; text-shadow: 0 0 2px rgba(255, 255, 255, 0.6); }
.am-impact { position: absolute; left: 0; top: 0; width: 0; height: 0; display: none; }
.am-impact.on { display: block; }
.am-impact .dia { position: absolute; left: -7px; top: -7px; width: 14px; height: 14px; border: 2px solid #ffcf6a; transform: rotate(45deg); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7), 0 0 6px rgba(255, 200, 90, 0.7); }
.am-impact .lbl { position: absolute; left: 12px; top: -8px; font: 800 ${fs(12, 10)} var(--font-body); color: #ffe7b0; white-space: nowrap; text-shadow: 0 0 3px #000, 0 1px 0 #000; }
.am-impact.air .dia { border-style: dashed; }
.am-impact.unarmed .dia { border-color: #9a9a9a; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7); }
.am-impact.unarmed .lbl { color: #c4c4c4; }
.am-blocked { position: absolute; left: 0; top: 0; width: 0; height: 0; display: none; }
.am-blocked.on { display: block; }
.am-blocked i { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #ff6a4a; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); background: linear-gradient(45deg, transparent 44%, #ff6a4a 44%, #ff6a4a 56%, transparent 56%); }
.am-lock { position: absolute; left: 0; top: 0; width: 0; height: 0; display: none; }
.am-lock.on { display: block; animation: sg-lock-pulse 0.5s ease-in-out infinite alternate; }
.am-lock i { position: absolute; width: 12px; height: 12px; border: 0 solid #ff3a24; filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 3px rgba(255, 50, 20, 0.9)); }
.am-lock i:nth-child(1) { left: -24px; top: -32px; border-left-width: 3px; border-top-width: 3px; }
.am-lock i:nth-child(2) { left: 12px; top: -32px; border-right-width: 3px; border-top-width: 3px; }
.am-lock i:nth-child(3) { left: -24px; top: 20px; border-left-width: 3px; border-bottom-width: 3px; }
.am-lock i:nth-child(4) { left: 12px; top: 20px; border-right-width: 3px; border-bottom-width: 3px; }
/* 锁 under the bracket: this one is locked */
.am-lock::after { content: '锁'; position: absolute; left: 0; top: 34px; transform: translateX(-50%); font: 900 11px var(--font-display); color: #ffd0c0; background: rgba(150, 20, 10, 0.85); padding: 0 3px; border-radius: 3px; }
:lang(en) .am-lock::after { content: 'LOCK'; font-family: var(--font-body); }
@keyframes sg-lock-pulse { from { opacity: 0.55; } to { opacity: 1; } }
/* locked on by 方天 rockets: red edges, a chevron toward the shooter, a warning line */
.am-lockwarn { position: absolute; inset: 0; display: none; }
.am-lockwarn.on { display: block; }
.am-lockwarn .lw-edge { position: absolute; inset: 0; box-shadow: inset 0 0 ${u(70)} ${u(22)} rgba(235, 20, 10, 0.7); animation: sg-focus-pulse 0.32s ease-in-out infinite alternate; }
.am-lockwarn .lw-arrow { position: absolute; left: 50%; top: 50%; width: 0; height: 0; display: none; }
.am-lockwarn .lw-arrow.on { display: block; }
.am-lockwarn .lw-arrow i { position: absolute; left: ${u(-30)}; top: calc(min(40vh, 40vw) * -1); width: 0; height: 0; border-left: ${u(30)} solid transparent; border-right: ${u(30)} solid transparent; border-bottom: ${u(42)} solid #ff3a24; filter: drop-shadow(0 0 4px rgba(255, 40, 20, 0.95)) drop-shadow(0 0 1px #000); }
.am-lockwarn .lw-line { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); padding: ${u(5)} ${u(16)}; white-space: nowrap; background: rgba(120, 10, 6, 0.86); border: 1px solid #ff5a3a; border-radius: ${u(5)}; font-weight: 800; font-size: ${fs(15, 12)}; color: #ffe6d8; animation: sg-hud-blink 0.32s ease-in-out infinite alternate; }

/* ── damage numbers (ui/hud/damageNumbers.ts): armor-reduced blue with a shield, dodges grey, knocks / kills red ── */
.hud-dmg .n.armor { color: #b8dcff; }
.hud-dmg .n.armor::before { content: '⛨'; font-size: 0.7em; margin-right: 0.12em; color: #8fc3ff; }
.hud-dmg .n.dodge { color: #b9b9b9; font-size: ${fs(18, 12)}; }
.hud-dmg .n.kill { color: #ff4a3a; font-size: ${fs(26, 15)}; }
`;
