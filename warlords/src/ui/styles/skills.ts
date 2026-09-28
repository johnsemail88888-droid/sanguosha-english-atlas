// Skill clarity: the aim tag, the one-line summary and the key-number chips (hero
// detail, 玩法说明 → 武将技能) and the in-match skill UI (HUD tooltip, the held-skill
// hint under the crosshair, first-ready tips, cast results).
const u = (n: number): string => `calc(var(--u) * ${n})`;
const fs = (n: number, min = 11): string => `max(${min}px, calc(var(--u) * ${n}))`;

export const SKILLS_CSS = /* css */ `
/* ── paper (hero detail, help) ─────────────────────────── */
.sk-aim { font-size: 0.74em; font-weight: 700; padding: 0.02em 0.5em; border-radius: 999px; white-space: nowrap; color: #5a4020; background: rgba(214, 173, 82, 0.22); border: 1px solid rgba(140, 106, 38, 0.4); }
.sk-aim.a-enemy, .sk-aim.a-forward, .sk-aim.a-point { color: #8a2418; background: rgba(179, 38, 30, 0.1); border-color: rgba(179, 38, 30, 0.35); }
.sk-aim.a-ally { color: #2d6a2a; background: rgba(60, 150, 70, 0.12); border-color: rgba(60, 150, 70, 0.4); }
.sg-ability .ab-head .sk-aim { margin-left: auto; }
.sk-line { margin: 0.28em 0 0; font-weight: 700; color: var(--paper-ink); line-height: 1.4; }
.sk-chips { display: flex; flex-wrap: wrap; gap: 0.28em; margin-top: 0.3em; }
.sk-chip { display: inline-flex; align-items: baseline; gap: 0.25em; padding: 0.04em 0.45em; border-radius: 4px; font-size: 0.8em; line-height: 1.45; white-space: nowrap; background: rgba(106, 74, 42, 0.09); border: 1px solid rgba(140, 106, 38, 0.28); }
.sk-chip i { font-style: normal; color: var(--paper-mute); }
.sk-chip b { font-weight: 800; color: var(--paper-ink); font-variant-numeric: tabular-nums; }
.sk-chip.k-damage b, .sk-chip.k-dot b { color: #a4241a; }
.sk-chip.k-heal b, .sk-chip.k-shield b { color: #2d7a34; }
.sk-chip.k-stun b, .sk-chip.k-silence b, .sk-chip.k-disarm b, .sk-chip.k-slow b { color: #6a3aa0; }
.sk-chip.k-fireRate b, .sk-chip.k-pierce b { color: #8a5a10; }
.sk-chip.k-cooldown { background: rgba(46, 95, 168, 0.08); border-color: rgba(46, 95, 168, 0.25); }
.sg-ability .ab-desc { font-size: 0.84em; color: var(--paper-mute); margin-top: 0.3em; line-height: 1.45; }
.sg-select .sg-ability .ab-desc { font-size: 0.8em; }

/* 玩法说明 → 武将技能 */
.sg-help .sk-hero { margin: 0 0 0.9em; }
.sg-help .sk-hero > h4 { display: flex; align-items: baseline; gap: 0.5em; margin: 0 0 0.35em; font-family: var(--font-display); font-size: 1.15em; }
.sg-help .sk-hero > h4 small { font-family: var(--font-body); font-size: 0.72em; font-weight: 400; color: var(--paper-mute); }
.sg-help .sk-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(20em, 1fr)); gap: 0.45em; }
.sg-help .sk-filter { display: flex; flex-wrap: wrap; gap: 0.35em; margin: 0 0 0.8em; }
.sg-help .sk-howto { margin: 0 0 0.8em; padding: 0.5em 0.8em; border-radius: 6px; background: rgba(214, 173, 82, 0.16); border: 1px solid rgba(140, 106, 38, 0.35); line-height: 1.55; }

/* ── HUD: tooltip over the ability bar ─────────────────── */
.hud-sktip { position: absolute; left: 50%; bottom: ${u(112)}; width: ${u(380)}; max-width: 92vw; transform: translateX(-50%); padding: ${u(9)} ${u(12)} ${u(10)}; border-radius: ${u(7)}; background: rgba(16, 11, 6, 0.9); border: 1px solid rgba(214, 173, 82, 0.6); box-shadow: 0 ${u(6)} ${u(18)} rgba(0, 0, 0, 0.55); color: #f5ead0; font-size: ${fs(13)}; line-height: 1.45; text-shadow: none; pointer-events: none; opacity: 0; transition: opacity 0.12s ease-out; }
.hud-sktip.on { opacity: 1; }
/* key held: see-through (the preview on the ground near you shows through it) */
.hud-sktip.held { background: rgba(16, 11, 6, 0.6); box-shadow: none; }
.hud-sktip .tt-head { display: flex; align-items: center; gap: ${u(7)}; }
.hud-sktip .tt-key { min-width: 1.6em; padding: 0 0.4em; border-radius: ${u(3)}; text-align: center; font-weight: 900; font-size: ${fs(12, 10)}; background: #2e5fa8; color: #fff; }
.hud-sktip .tt-key.k-e { background: #7a3aa0; }
.hud-sktip .tt-key.k-lord { background: linear-gradient(#e0b04a, #9a6a14); color: #2a1a06; }
.hud-sktip .tt-key.k-passive { background: #56683f; }
.hud-sktip .tt-name { font-family: var(--font-display); font-size: ${fs(18, 13)}; font-weight: 900; color: #f5dc98; }
.hud-sktip .sk-aim { margin-left: auto; color: #f5dc98; background: rgba(214, 173, 82, 0.16); border-color: rgba(214, 173, 82, 0.45); }
.hud-sktip .sk-aim.a-enemy, .hud-sktip .sk-aim.a-forward, .hud-sktip .sk-aim.a-point { color: #ffb4a0; background: rgba(255, 90, 60, 0.14); border-color: rgba(255, 110, 80, 0.45); }
.hud-sktip .sk-aim.a-ally { color: #b4f0b0; background: rgba(90, 200, 100, 0.14); border-color: rgba(120, 220, 120, 0.45); }
.hud-sktip .sk-line { color: #fff4dc; margin-top: ${u(5)}; }
.hud-sktip .sk-chip { font-size: ${fs(12, 10)}; background: rgba(255, 240, 210, 0.08); border-color: rgba(214, 173, 82, 0.3); }
.hud-sktip .sk-aim { font-size: ${fs(11.5, 10)}; }
.hud-sktip .sk-chip i { color: #cdb993; }
.hud-sktip .sk-chip b { color: #fff; }
.hud-sktip .sk-chip.k-damage b, .hud-sktip .sk-chip.k-dot b { color: #ff9a7a; }
.hud-sktip .sk-chip.k-heal b, .hud-sktip .sk-chip.k-shield b { color: #9ae89a; }
.hud-sktip .sk-chip.k-stun b, .hud-sktip .sk-chip.k-silence b, .hud-sktip .sk-chip.k-disarm b, .hud-sktip .sk-chip.k-slow b { color: #d4b4ff; }
.hud-sktip .sk-chip.k-fireRate b, .hud-sktip .sk-chip.k-pierce b { color: #ffd27a; }
.hud-sktip .tt-hint { margin-top: ${u(6)}; font-size: ${fs(11.5, 10)}; color: #cdb993; }
.hud-sktip .tt-desc { margin-top: ${u(5)}; font-size: ${fs(11.5, 10)}; color: #b8a888; }

/* the skill under the held key glows; its name under the icon */
.hud-abilities .ab .ab-nm { max-width: ${u(84)}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: ${fs(11, 9)}; font-weight: 700; color: #f0e2bc; text-shadow: 0 1px 2px #000, 0 0 4px rgba(0, 0, 0, 0.8); line-height: 1.1; }
.hud-abilities .ab.held .ico { box-shadow: 0 0 0 ${u(3)} #fff0b8, 0 0 ${u(16)} rgba(255, 220, 120, 0.9); }
.hud-abilities .ab.cooling .ab-nm { opacity: 0.6; }
/* cooldown ring: the part of the circle already recharged glows gold around the dark sweep */
.hud-abilities .ab.cooling:not(.recharging) .cd::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(transparent calc(var(--p, 0) * 1turn), #f5dc98 0); -webkit-mask: radial-gradient(closest-side, transparent 83%, #000 87%); mask: radial-gradient(closest-side, transparent 83%, #000 87%); opacity: 0.9; }
@media (max-height: 520px) {
  .hud-abilities .ab .ab-nm { display: none; }
  .hud-sktips .tip { max-width: 44vw; }
  .hud-sktips .tip .how { display: none; }
  .hud-sktips .tip:nth-child(n + 3) { display: none; }
}
/* a phone-sized landscape screen has no room over the bar: the tooltip (hover) stays, the tips go */
@media (max-height: 400px) { .hud-sktips { display: none; } }

/* ── HUD: held-skill hint over the crosshair ──────────── */
/* (above it: in first person the ground a point skill lands on is right under the crosshair) */
.hud-skaim { position: absolute; left: 50%; top: calc(50% - ${u(88)}); transform: translateX(-50%); display: none; align-items: center; gap: ${u(8)}; padding: ${u(4)} ${u(12)}; border-radius: 999px; background: rgba(16, 11, 6, 0.78); border: 1px solid rgba(214, 173, 82, 0.55); white-space: nowrap; font-size: ${fs(13)}; }
.hud-skaim.on { display: flex; }
.hud-skaim b { font-family: var(--font-display); color: #f5dc98; font-size: ${fs(15, 12)}; }
.hud-skaim .how { color: #e8dcc0; }
.hud-skaim.bad { border-color: #ff6a4a; background: rgba(90, 16, 10, 0.82); }
.hud-skaim.bad .how { color: #ffc8b8; }
.hud-skaim.warn { border-color: #f0a030; background: rgba(70, 42, 6, 0.84); }
.hud-skaim.warn .how { color: #ffe0a8; }

/* ── HUD: cast results under the crosshair ────────────── */
.hud-skfeed { position: absolute; left: 50%; top: calc(50% + ${u(78)}); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(4)}; pointer-events: none; }
.hud-skfeed .sf { display: flex; align-items: baseline; gap: ${u(6)}; padding: ${u(2)} ${u(12)}; border-radius: ${u(4)}; background: linear-gradient(90deg, transparent, rgba(16, 11, 6, 0.75) 18%, rgba(16, 11, 6, 0.75) 82%, transparent); white-space: nowrap; font-weight: 700; }
.hud-skfeed .sf .nm { font-family: var(--font-display); color: #f5dc98; font-size: ${fs(16, 12)}; }
.hud-skfeed .sf .res { color: #fff; }
.hud-skfeed .sf .res em { font-style: normal; color: #ffcf6a; font-size: 1.15em; }
.hud-skfeed .sf.miss .res { color: #b8a888; }
.hud-skfeed .sf .st { display: inline-flex; align-items: center; gap: ${u(3)}; color: #e8d0ff; }
.hud-skfeed .sf .st i { display: inline-grid; place-items: center; width: 1.35em; height: 1.35em; border-radius: ${u(3)}; font-style: normal; font-family: var(--font-display); font-size: 0.85em; background: var(--sc, #9a7ad0); color: #140c06; }

/* ── HUD: first-ready tips above the ability bar ──────── */
.hud-sktips { position: absolute; left: 50%; bottom: ${u(112)}; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(5)}; pointer-events: none; }
.hud-sktips .tip { display: flex; align-items: center; gap: ${u(8)}; max-width: min(62vw, ${u(640)}); padding: ${u(5)} ${u(12)} ${u(5)} ${u(6)}; border-radius: ${u(6)}; background: rgba(16, 11, 6, 0.84); border: 1px solid rgba(214, 173, 82, 0.5); font-size: ${fs(13)}; animation: sg-sktip-in 0.35s ease-out; }
.hud-sktips .tip.out { opacity: 0; transition: opacity 0.6s ease-in; }
.hud-sktips .tip .k { flex: none; min-width: 1.7em; padding: 0 0.4em; border-radius: ${u(3)}; text-align: center; font-weight: 900; background: #2e5fa8; color: #fff; }
.hud-sktips .tip .k.k-e { background: #7a3aa0; }
.hud-sktips .tip .k.k-lord { background: linear-gradient(#e0b04a, #9a6a14); color: #2a1a06; }
.hud-sktips .tip b { font-family: var(--font-display); color: #f5dc98; font-size: ${fs(15, 12)}; white-space: nowrap; }
.hud-sktips .tip .ln { color: #f5ead0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-sktips .tip .how { flex: none; color: #cdb993; font-size: ${fs(11.5, 10)}; }
.sg-hud.sktip-open .hud-sktips { visibility: hidden; }
/* the pickup lines share the spot over the bar: hidden under the tooltip, above the tips */
.sg-hud.sktip-open .hud-pickups { visibility: hidden; }
.sg-hud.sktips-on:not(.touch) .hud-pickups { bottom: calc(${u(112)} + var(--sktips-h, 0px) + ${u(12)}); }
@keyframes sg-sktip-in { from { opacity: 0; transform: translateY(${u(8)}); } to { opacity: 1; transform: none; } }
/* ── HUD: what an enemy skill does to you ─────────────── */
.hud-selfcc { position: absolute; left: 50%; top: calc(50% + ${u(40)}); transform: translateX(-50%); display: none; grid-template-columns: auto auto; align-items: center; column-gap: ${u(8)}; row-gap: ${u(3)}; padding: ${u(4)} ${u(14)} ${u(4)} ${u(5)}; border-radius: ${u(8)}; background: rgba(30, 8, 20, 0.84); border: 1px solid var(--sc, #9a7ad0); box-shadow: 0 0 ${u(12)} color-mix(in srgb, var(--sc, #9a7ad0) 45%, transparent); white-space: nowrap; font-size: ${fs(14)}; font-weight: 700; color: #fff0f4; pointer-events: none; }
.hud-selfcc.on { display: grid; }
.hud-selfcc i { grid-row: span 2; display: grid; place-items: center; width: ${u(28)}; height: ${u(28)}; border-radius: ${u(5)}; font-style: normal; font-family: var(--font-display); font-size: ${fs(18, 13)}; background: var(--sc, #9a7ad0); color: #140c06; }
.hud-selfcc .track { height: ${u(4)}; border-radius: 2px; background: rgba(255, 255, 255, 0.14); overflow: hidden; }
.hud-selfcc .bar { display: block; height: 100%; background: var(--sc, #9a7ad0); transform-origin: left center; }
.hud-selfcc:not(.cc) .track { display: none; }
.hud-selfcc:not(.cc) i { grid-row: auto; }
.hud-selfcc.soft, .hud-selfcc.hit { background: rgba(24, 10, 8, 0.72); font-weight: 600; }
.hud-selfcc.hit { border-color: #ff6a4a; box-shadow: none; }
.sg-hud.dead :is(.hud-sktip, .hud-skaim, .hud-sktips, .hud-skfeed, .hud-selfcc) { display: none; }
.sg-hud.touch .hud-sktips .tip .how { display: none; }
`;
