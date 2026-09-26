// In-match HUD + touch overlay styles. Sizes use the --u unit (1px at 1080p,
// 0.8px at 720p, floor 0.55px on phones) so the HUD scales with the viewport.
const u = (n: number): string => `calc(var(--u) * ${n})`;
/** text size that never drops below `min` px */
const fs = (n: number, min = 11): string => `max(${min}px, calc(var(--u) * ${n}))`;

export const HUD_CSS = /* css */ `
.sg-game { position: absolute; inset: 0; background: #0c0806; }
.sg-hud {
  --hud-bg: rgba(18, 12, 7, 0.7);
  --hud-line: rgba(214, 173, 82, 0.5);
  position: absolute;
  inset: 0;
  isolation: isolate;
  pointer-events: none;
  color: #f5ead0;
  font-size: ${fs(14)};
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
}
.sg-hud.inactive { visibility: hidden; }
/* .sg-layer.pass > * would make the whole HUD a click target: only its interactive parts are */
.sg-layer.pass > .sg-hud { pointer-events: none; }
.sg-hud .sg-key { text-shadow: none; }

/* ── top bar ───────────────────────────────────────────── */
.hud-top { position: absolute; top: ${u(16)}; left: ${u(16)}; right: ${u(16)}; height: 0; }
.role-chip { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: ${u(10)}; max-width: ${u(380)}; padding: ${u(6)} ${u(14)} ${u(6)} ${u(8)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-left: ${u(4)} solid var(--rc, #d6ad52); border-radius: ${u(6)}; pointer-events: auto; }
.role-chip:empty { display: none; }
.role-chip .sg-seal { font-size: ${fs(14)}; }
.role-chip .rc-text { display: flex; flex-direction: column; min-width: 0; }
.role-chip .rc-text b { font-family: var(--font-display); font-size: ${fs(18, 12)}; color: var(--rc); letter-spacing: 0.1em; line-height: 1.2; }
.role-chip .goal { font-size: ${fs(12, 10)}; opacity: 0.85; line-height: 1.3; white-space: normal; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.role-chip .bounty { font-size: ${fs(12, 10)}; color: #ffc38a; }
.hud-topcenter { position: absolute; left: 50%; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(4)}; }
.hud-zone { display: inline-flex; align-items: center; gap: ${u(8)}; padding: ${u(4)} ${u(16)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: 999px; font-size: ${fs(15, 11)}; white-space: nowrap; }
/* a guest's link to the host (connstatus.ts), in place of the clock row */
.link-chip { padding: ${u(2)} ${u(12)}; border-radius: 999px; font-size: ${fs(13, 10)}; font-weight: 700; white-space: nowrap; background: rgba(120, 80, 10, 0.82); border: 1px solid #f2c14e; color: #ffe6a8; }
.link-chip[data-tone="bad"] { background: rgba(130, 30, 20, 0.85); border-color: #ff8a6a; color: #ffd9cc; animation: sg-hud-blink 1s ease-in-out infinite alternate; }
.link-chip[data-tone="ok"] { background: rgba(30, 90, 50, 0.82); border-color: #7fe09a; color: #d8ffe2; }
.hud-zone .zphase { font-family: var(--font-display); color: var(--gold-hi); font-weight: 800; }
.hud-zone.shrinking { border-color: #ff7840; }
.hud-zone.shrinking .ztext { color: #ffb08a; }
.hud-zone.soon { animation: sg-hud-blink 0.8s ease-in-out infinite alternate; }
.match-info { font-size: ${fs(13, 10)}; display: flex; gap: ${u(6)}; padding: ${u(1)} ${u(12)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: 999px; color: rgba(248, 236, 210, 0.95); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9); }
.match-info .clock { font-variant-numeric: tabular-nums; font-weight: 700; }
@keyframes sg-hud-blink { from { box-shadow: 0 0 0 rgba(255, 120, 60, 0); } to { box-shadow: 0 0 ${u(14)} rgba(255, 120, 60, 0.7); } }

/* ── minimap ───────────────────────────────────────────── */
.hud-minimap { position: absolute; top: ${u(16)}; right: ${u(16)}; width: ${u(210)}; pointer-events: auto; cursor: pointer; z-index: 8; }
.mm-ring { position: relative; width: ${u(210)}; height: ${u(210)}; border-radius: 50%; overflow: hidden; background: #2a2016; box-shadow: 0 0 0 ${u(3)} #d6ad52, 0 0 0 ${u(5)} #3a2410, 0 ${u(6)} ${u(16)} rgba(0, 0, 0, 0.6); }
.mm-canvas { display: block; width: 100%; height: 100%; }
.mm-n { position: absolute; top: ${u(3)}; left: 50%; transform: translateX(-50%); font-family: var(--font-display); font-size: ${fs(13, 9)}; font-weight: 800; color: #f5dc98; }
.mm-region { width: fit-content; max-width: 100%; margin: ${u(9)} auto 0; padding: ${u(1)} ${u(10)}; text-align: center; font-family: var(--font-display); font-size: ${fs(14, 10)}; color: var(--gold-hi); letter-spacing: 0.1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: rgba(18, 12, 7, 0.72); border: 1px solid var(--hud-line); border-radius: 999px; text-shadow: 0 1px 2px #000, 0 0 3px #000; }
.hud-fps { position: absolute; top: ${u(2)}; right: ${u(4)}; font-size: 11px; font-variant-numeric: tabular-nums; color: #9fe0a0; z-index: 9; }

/* ── kill feed ─────────────────────────────────────────── */
.hud-feed { position: absolute; top: ${u(16)}; right: ${u(250)}; display: flex; flex-direction: column; align-items: flex-end; gap: ${u(4)}; max-width: min(${u(560)}, 44vw); font-size: ${fs(14, 10)}; }
.kf { display: flex; align-items: center; gap: ${u(6)}; padding: ${u(3)} ${u(10)}; background: var(--hud-bg); border-radius: ${u(3)}; border-left: ${u(3)} solid transparent; white-space: nowrap; animation: sg-kf-in 0.25s ease-out; transition: opacity 0.4s; max-width: 100%; overflow: hidden; }
.kf.out { opacity: 0; }
.kf.mine { border-left-color: var(--gold); background: rgba(92, 22, 12, 0.78); }
.kf.me { border-left-color: #ff5a4a; }
.kf.downed { opacity: 0.85; }
.kf.claim { background: rgba(18, 12, 7, 0.55); }
@keyframes sg-kf-in { from { opacity: 0; transform: translateX(${u(20)}); } }
.kf .who { color: color-mix(in srgb, var(--kc, #ccc) 50%, #fff 50%); font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
.kf .who small { font-weight: 400; opacity: 0.75; margin-left: ${u(4)}; font-size: 0.85em; }
/* a row that does not fit drops the player names (killer's first): hero names + the victim's role stay (feed.ts fitFeedRow) */
.kf.tight-k .who.k small, .kf.tight .who small { display: none; }
.kf .who.zone { color: #ff9a6a; }
.kf .verb { display: inline-grid; place-items: center; min-width: ${u(20)}; height: ${u(20)}; padding: 0 ${u(3)}; border-radius: ${u(3)}; background: var(--red); color: #fbeedd; font-family: var(--font-display); font-size: ${fs(13, 10)}; font-weight: 800; text-shadow: none; flex: none; }
.kf .verb.small { background: transparent; color: #e8d8b0; font-family: var(--font-body); font-weight: 400; }
.kf .verb.word { font-family: var(--font-body); font-weight: 700; font-size: ${fs(11, 9)}; letter-spacing: 0.02em; padding: 0 ${u(5)}; }
.kf.downed .verb { background: #7a5a2a; }
.kf .rseal { display: inline-flex; align-items: center; gap: ${u(3)}; background: var(--seal); color: #fff; padding: 0 ${u(6)}; border-radius: ${u(3)}; font-family: var(--font-display); font-weight: 900; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5); flex: none; }
.kf .rseal small { font-family: var(--font-body); font-weight: 400; font-size: 0.85em; }
.kf .rseal.claim { background: rgba(0, 0, 0, 0.3); border: 1px dashed var(--seal); color: var(--seal); }

/* ── announcements ─────────────────────────────────────── */
.hud-announce { position: absolute; top: 20%; left: 50%; transform: translateX(-50%); width: min(92vw, ${u(900)}); text-align: center; }
.ann-big { opacity: 0; transition: opacity 0.35s ease; }
.ann-big.show { opacity: 1; }
.ann-big .msg { display: inline-flex; flex-direction: column; align-items: center; gap: ${u(2)}; padding: ${u(10)} ${u(60)}; background: linear-gradient(90deg, transparent, rgba(20, 12, 6, 0.82) 18%, rgba(20, 12, 6, 0.82) 82%, transparent); }
.ann-big .msg .t { font-family: var(--font-display); font-size: ${fs(34, 18)}; font-weight: 900; letter-spacing: 0.12em; color: var(--gold-hi); text-shadow: 0 2px 0 #000, 0 0 16px rgba(240, 160, 60, 0.4); }
.ann-big .msg.warn .t { color: #ff8a6a; }
.ann-big .msg .s { font-size: ${fs(15, 11)}; opacity: 0.88; }
.ann-info .line { display: inline-block; margin-top: ${u(6)}; padding: ${u(3)} ${u(14)}; background: rgba(18, 12, 7, 0.55); border-radius: ${u(3)}; font-size: ${fs(15, 11)}; animation: sg-fade 0.2s ease-out; }
.ann-info .line.has-sub { display: inline-flex; flex-direction: column; align-items: center; max-width: min(92vw, ${u(640)}); background: rgba(18, 12, 7, 0.72); border: 1px solid var(--hud-line); }
.ann-info .line .sub { font-size: ${fs(12.5, 10)}; color: #f0dcae; opacity: 0.92; line-height: 1.35; }
.ann-info { display: flex; flex-direction: column; align-items: center; }
.hud-zonewarn { position: absolute; top: ${u(84)}; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: ${u(12)}; padding: ${u(6)} ${u(18)}; background: rgba(120, 20, 10, 0.78); border: 1px solid #ff6a4a; border-radius: ${u(5)}; font-weight: 700; animation: sg-hud-blink 0.7s ease-in-out infinite alternate; }
.hud-zonewarn.on { display: flex; }
.hud-zonewarn .arrow { display: inline-block; font-style: normal; color: #ffd0a0; font-size: ${fs(20, 14)}; transition: transform 0.15s linear; }
.hud-zonewarn .dist { display: block; font-size: ${fs(12, 10)}; font-weight: 400; opacity: 0.9; }

/* ── duel ─────────────────────────────────────────────── */
.hud-duel { position: absolute; top: ${u(118)}; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: ${u(8)}; padding: ${u(4)} ${u(14)} ${u(4)} ${u(6)}; background: rgba(90, 16, 10, 0.78); border: 1px solid #ff8a6a; border-radius: 999px; font-family: var(--font-display); font-size: ${fs(15, 11)}; white-space: nowrap; }
.hud-duel.off { display: none; }
.hud-duel .sg-seal { font-size: ${fs(12, 9)}; }
.hud-duel .dl-secs { font-family: var(--font-body); font-variant-numeric: tabular-nums; color: #ffd0a0; }
.hud-duel.ending { animation: sg-hud-blink 0.5s ease-in-out infinite alternate; }

/* ── crosshair ─────────────────────────────────────────── */
.hud-xhair { --gap: 8px; --len: ${u(10)}; --th: 2px; position: absolute; left: 50%; top: 50%; width: 0; height: 0; color: rgba(255, 255, 255, 0.95); filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000); }
.hud-xhair.off { display: none; }
.hud-xhair > i { position: absolute; display: none; }
.hud-xhair .l { background: currentColor; }
.hud-xhair .l.t, .hud-xhair .l.b { width: var(--th); height: var(--len); left: calc(var(--th) / -2); }
.hud-xhair .l.le, .hud-xhair .l.r { height: var(--th); width: var(--len); top: calc(var(--th) / -2); }
.hud-xhair .l.t { top: calc(var(--len) * -1); transform: translateY(calc(var(--gap) * -1)); }
.hud-xhair .l.b { top: 0; transform: translateY(var(--gap)); }
.hud-xhair .l.le { left: calc(var(--len) * -1); transform: translateX(calc(var(--gap) * -1)); }
.hud-xhair .l.r { left: 0; transform: translateX(var(--gap)); }
.hud-xhair .dot { width: 4px; height: 4px; left: -2px; top: -2px; border-radius: 50%; background: currentColor; }
.hud-xhair .ring { width: calc(var(--gap) * 2); height: calc(var(--gap) * 2); left: calc(var(--gap) * -1); top: calc(var(--gap) * -1); border: 1.5px solid currentColor; border-radius: 50%; }
.hud-xhair .chev { width: ${u(18)}; height: ${u(18)}; left: ${u(-9)}; top: ${u(4)}; border-left: 2px solid currentColor; border-top: 2px solid currentColor; transform: translateY(calc(var(--gap) * 0.4)) rotate(45deg); }
.hud-xhair .drop { width: ${u(22)}; height: ${u(34)}; left: ${u(-11)}; top: ${u(8)}; background: linear-gradient(currentColor, currentColor) center top / 2px 100% no-repeat, linear-gradient(currentColor, currentColor) center 33% / 60% 2px no-repeat, linear-gradient(currentColor, currentColor) center 66% / 45% 2px no-repeat, linear-gradient(currentColor, currentColor) center 100% / 30% 2px no-repeat; opacity: 0.85; }
.hud-xhair[data-style="cross"] .l, .hud-xhair[data-style="cross"] .dot { display: block; }
.hud-xhair[data-style="circle"] .ring, .hud-xhair[data-style="circle"] .dot { display: block; }
.hud-xhair[data-style="dot"] .dot { display: block; width: 5px; height: 5px; left: -2.5px; top: -2.5px; }
.hud-xhair[data-style="dot"] .ring { display: block; opacity: 0.35; }
.hud-xhair[data-style="launcher"] .dot, .hud-xhair[data-style="launcher"] .drop, .hud-xhair[data-style="launcher"] .l.le, .hud-xhair[data-style="launcher"] .l.r { display: block; }
.hud-xhair[data-style="bow"] .chev, .hud-xhair[data-style="bow"] .dot { display: block; }
.hud-xhair[data-style="flame"] .ring { display: block; border-style: dashed; border-width: 2px; }
.hud-xhair[data-style="melee"] .chev { display: block; top: ${u(-9)}; transform: rotate(45deg); border-radius: ${u(4)} 0 0 0; }
.hud-xhair[data-style="melee"] .dot { display: block; }
.hud-xhair.ads { --len: ${u(7)}; }
.hud-xhair.reloading { opacity: 0.45; }
.hitmarker { position: absolute; left: 0; top: 0; width: ${u(26)}; height: ${u(26)}; transform: translate(-50%, -50%) rotate(45deg); opacity: 0; }
.hitmarker i { position: absolute; background: #fff; box-shadow: 0 0 2px #000; }
.hitmarker i:nth-child(1) { left: calc(50% - 1px); top: 0; width: 2px; height: 32%; }
.hitmarker i:nth-child(2) { left: calc(50% - 1px); bottom: 0; width: 2px; height: 32%; }
.hitmarker i:nth-child(3) { top: calc(50% - 1px); left: 0; height: 2px; width: 32%; }
.hitmarker i:nth-child(4) { top: calc(50% - 1px); right: 0; height: 2px; width: 32%; }
.hitmarker[data-kind="head"] { width: ${u(34)}; height: ${u(34)}; }
.hitmarker[data-kind="head"] i { background: #ffd24a; width: 3px; }
.hitmarker[data-kind="head"] i:nth-child(3), .hitmarker[data-kind="head"] i:nth-child(4) { height: 3px; width: 32%; }
.hitmarker[data-kind="kill"] { width: ${u(40)}; height: ${u(40)}; }
.hitmarker[data-kind="kill"] i { background: #ff4a3a; }
.hud-killstamp { position: absolute; left: 50%; top: 36%; display: flex; flex-direction: column; align-items: center; gap: ${u(6)}; opacity: 0; transform: translate(-50%, -50%); }
.hud-killstamp .sg-seal { font-size: ${fs(18, 12)}; }
.hud-killstamp .lbl { font-family: var(--font-display); font-size: ${fs(17, 12)}; color: #ffdcb0; }

/* ── damage numbers / direction ────────────────────────── */
.hud-dmg { position: absolute; inset: 0; overflow: hidden; }
.hud-dmg .f { position: absolute; left: 0; top: 0; visibility: hidden; will-change: transform; }
.hud-dmg .n { display: block; font-family: var(--font-display); font-weight: 900; font-size: ${fs(21, 13)}; color: #fff; text-shadow: 0 0 3px #000, 0 2px 0 #000; white-space: nowrap; opacity: 0; }
.hud-dmg .n.head { color: #ffd24a; font-size: ${fs(28, 16)}; }
.hud-dmg .n.squad { color: #cfe8c8; font-size: ${fs(15, 11)}; }
.hud-dmg .n.blocked { color: #9ad0ff; font-size: ${fs(16, 11)}; }
.hud-dmg .n.heal { color: #7fe09a; }
.hud-dmgdir { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.hud-dmgdir i { position: absolute; left: 0; top: 0; width: ${u(260)}; height: ${u(260)}; border-radius: 50%; border: ${u(7)} solid transparent; border-top-color: rgba(255, 40, 20, 0.9); opacity: 0; transform: translate(-50%, -50%); filter: blur(0.6px); }

/* ── scope ─────────────────────────────────────────────── */
.hud-scope { position: absolute; inset: 0; display: none; background: radial-gradient(circle at 50% 50%, transparent 0 min(38vw, 42vh), rgba(0, 0, 0, 0.92) calc(min(38vw, 42vh) + 3px)); }
.hud-scope.on { display: block; }
/* looking through a scope: no F prompt inside the lens under the reticle (COMBAT-11) */
.hud-scope.on ~ .hud-interact { visibility: hidden; }
.hud-scope .lens { position: absolute; left: 50%; top: 50%; width: calc(min(38vw, 42vh) * 2); height: calc(min(38vw, 42vh) * 2); transform: translate(-50%, -50%); border-radius: 50%; box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.6), 0 0 0 3px #111; }
.hud-scope .h { position: absolute; left: 0; right: 0; top: 50%; height: 1.5px; background: rgba(0, 0, 0, 0.9); }
.hud-scope .v { position: absolute; top: 0; bottom: 0; left: 50%; width: 1.5px; background: rgba(0, 0, 0, 0.9); }
.hud-scope .ticks { position: absolute; left: 50%; top: 50%; width: 40%; height: 8px; transform: translate(-50%, -50%); background: repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.9) 0 2px, transparent 2px 10%); }

/* ── interact / channel ────────────────────────────────── */
.hud-interact { position: absolute; left: 50%; top: calc(50% + ${u(74)}); transform: translateX(-50%); display: flex; align-items: center; gap: ${u(8)}; padding: ${u(6)} ${u(14)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: ${u(5)}; font-size: ${fs(15, 11)}; white-space: nowrap; pointer-events: auto; transition: opacity 0.15s; }
.hud-interact.off { opacity: 0; visibility: hidden; }
.hud-interact .sub { font-size: ${fs(12, 10)}; color: #ffc9a8; }
.hud-interact.warn { border-color: #d98a5a; }
/* full item bar: "F take 桃, drop slot 7's 无懈可击" over the discard hint */
.hud-interact.swapcard { display: grid; grid-template-columns: auto auto auto; column-gap: ${u(8)}; row-gap: ${u(1)}; border-color: #d9a85a; }
.hud-interact.swapcard > .sg-key { grid-column: 1; grid-row: 1 / span 2; align-self: center; justify-self: start; }
.hud-interact.swapcard > .ip-art { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
.hud-interact.swapcard > .txt { grid-column: 3; grid-row: 1; }
.hud-interact.swapcard > .sub { grid-column: 3; grid-row: 2; line-height: 1.2; }
.hud-channel { position: absolute; left: 50%; top: calc(50% + ${u(40)}); transform: translateX(-50%); width: ${u(240)}; text-align: center; font-size: ${fs(13, 10)}; }
.hud-channel.off { display: none; }
.hud-channel .track { height: ${u(6)}; margin-top: ${u(3)}; background: rgba(0, 0, 0, 0.55); border: 1px solid var(--hud-line); border-radius: ${u(3)}; overflow: hidden; }
.hud-channel .track i { display: block; height: 100%; background: linear-gradient(90deg, #d6ad52, #f5dc98); transform-origin: left center; transform: scaleX(0); }

/* ── downed / spectate ─────────────────────────────────── */
.hud-downed { position: absolute; inset: 0; display: none; }
.hud-downed.on { display: block; }
.hud-downed .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, transparent 30%, rgba(120, 0, 0, 0.5) 72%, rgba(50, 0, 0, 0.88)); animation: sg-heart 1.1s ease-in-out infinite; }
@keyframes sg-heart { 0%, 100% { opacity: 0.75; } 15% { opacity: 1; } 30% { opacity: 0.8; } 45% { opacity: 1; } }
.hud-downed .box { position: absolute; left: 50%; top: 60%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(6)}; }
.hud-downed .ttl { font-family: var(--font-display); font-size: ${fs(36, 20)}; font-weight: 900; color: #ff6a5a; letter-spacing: 0.3em; padding-left: 0.3em; }
.hud-downed .ringwrap { position: relative; width: ${u(76)}; height: ${u(76)}; }
.hud-downed svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.hud-downed circle { fill: none; stroke-width: 5; }
.hud-downed circle.bg { stroke: rgba(255, 255, 255, 0.2); }
.hud-downed circle.fg { stroke: #ff5a4a; stroke-linecap: round; }
.hud-downed .secs { position: absolute; inset: 0; display: grid; place-items: center; font-size: ${fs(26, 16)}; font-weight: 900; }
.hud-downed .hint { font-size: ${fs(15, 11)}; background: var(--hud-bg); padding: ${u(4)} ${u(14)}; border-radius: ${u(4)}; }
.hud-spectate { position: absolute; left: 50%; bottom: ${u(30)}; transform: translateX(-50%); display: none; flex-direction: column; align-items: center; gap: ${u(6)}; padding: ${u(10)} ${u(24)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: ${u(6)}; pointer-events: auto; z-index: 8; }
.hud-spectate.on { display: flex; }
.hud-spectate .dead-title { font-family: var(--font-display); font-size: ${fs(26, 16)}; font-weight: 900; color: #ff8a6a; letter-spacing: 0.2em; }
.hud-spectate .killer { font-size: ${fs(14, 11)}; opacity: 0.9; }
.hud-spectate .killer:empty { display: none; }
.hud-spectate .spec { display: flex; align-items: center; gap: ${u(12)}; }
.hud-spectate .target { min-width: ${u(220)}; text-align: center; font-size: ${fs(15, 11)}; }
.sg-hud.dead .hud-left, .sg-hud.dead .hud-abilities, .sg-hud.dead .hud-weapon, .sg-hud.dead .hud-interact, .sg-hud.dead .hud-channel { display: none; }
.sg-hud.downed .hud-abilities { opacity: 0.4; }
.sg-hud.no-hero :is(.hud-left, .hud-abilities, .hud-weapon, .role-chip, .hud-interact, .hud-channel) { display: none; }

/* ── left: squad + vitals ──────────────────────────────── */
.hud-left { position: absolute; left: ${u(16)}; bottom: ${u(16)}; display: flex; flex-direction: column; gap: ${u(10)}; align-items: flex-start; }
.hud-vitals { width: ${u(420)}; }
.v-status { display: flex; gap: ${u(5)}; flex-wrap: wrap; margin-bottom: ${u(6)}; min-height: ${u(30)}; }
.v-status .st { position: relative; width: ${u(30)}; height: ${u(30)}; border-radius: ${u(4)}; display: grid; place-items: center; background: rgba(0, 0, 0, 0.6); border: 1.5px solid #d6ad52; font-family: var(--font-display); font-size: ${fs(15, 10)}; font-weight: 800; color: var(--sc); pointer-events: auto; }
.v-status .st.debuff { border-color: #e04a3a; }
.v-status .st b { position: absolute; right: ${u(-4)}; bottom: ${u(-5)}; font-size: ${fs(11, 9)}; color: #fff; background: rgba(0, 0, 0, 0.85); border-radius: ${u(3)}; padding: 0 ${u(3)}; font-family: var(--font-body); line-height: 1.3; }
.v-status .st b:empty { display: none; }
.v-status .st.expiring { animation: sg-hud-blink 0.4s ease-in-out infinite alternate; }
.v-main { display: flex; align-items: center; gap: ${u(12)}; padding: ${u(10)} ${u(14)} ${u(10)} ${u(10)}; background: linear-gradient(90deg, rgba(18, 12, 7, 0.85), rgba(18, 12, 7, 0.55)); border: 1px solid var(--hud-line); border-radius: ${u(6)}; }
.v-portrait { --kc: #8a8a8a; position: relative; width: ${u(78)}; height: ${u(78)}; flex: none; border-radius: 50%; overflow: hidden; box-shadow: 0 0 0 ${u(3)} var(--kc), 0 0 0 ${u(5)} #d6ad52; background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--kc) 55%, #fff 25%), color-mix(in srgb, var(--kc) 60%, #000 40%)); }
.v-portrait .portrait { position: absolute; inset: 0; }
.v-portrait .ph { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: ${fs(36, 18)}; font-weight: 900; color: rgba(255, 245, 220, 0.85); }
.v-portrait img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.v-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: ${u(4)}; }
.v-name { display: flex; align-items: baseline; gap: ${u(8)}; min-width: 0; }
.v-name .hero { font-family: var(--font-display); font-size: ${fs(21, 13)}; font-weight: 900; color: #fff3d6; white-space: nowrap; }
.v-name .player { font-size: ${fs(13, 10)}; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-shield { height: ${u(5)}; border-radius: ${u(3)}; overflow: hidden; opacity: 0; position: relative; }
.v-shield.on { opacity: 1; background: rgba(0, 0, 0, 0.45); }
.v-shield .fill.shield { position: absolute; inset: 0; background: linear-gradient(90deg, #6ab8f0, #d0ecff); transform-origin: left center; }
.v-hpbar { --seg: 25%; position: relative; height: ${u(22)}; background: rgba(0, 0, 0, 0.6); border: 1px solid rgba(214, 173, 82, 0.65); border-radius: ${u(3)}; overflow: hidden; }
.v-hpbar .fill { position: absolute; inset: 0; transform-origin: left center; }
.v-hpbar .fill.lag { background: rgba(255, 236, 190, 0.8); }
.v-hpbar .fill.hp { background: linear-gradient(180deg, #8ff0a8, #33a856 55%, #1f7038); }
.v-hpbar.mid .fill.hp { background: linear-gradient(180deg, #ffe08a, #d89a2a 55%, #9a6410); }
.v-hpbar.low .fill.hp { background: linear-gradient(180deg, #ff9a7a, #d23a26 55%, #8a1a10); }
.v-hpbar.low { animation: sg-low 0.7s ease-in-out infinite alternate; }
@keyframes sg-low { from { box-shadow: 0 0 0 rgba(255, 40, 20, 0); } to { box-shadow: 0 0 ${u(12)} rgba(255, 40, 20, 0.8); } }
.v-hpbar .segs { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 calc(var(--seg) - 2px), rgba(0, 0, 0, 0.6) calc(var(--seg) - 2px) var(--seg)); }
.v-hpbar .num { position: absolute; inset: 0; display: grid; place-items: center; font-size: ${fs(13, 10)}; font-weight: 800; letter-spacing: 0.05em; font-variant-numeric: tabular-nums; }
.v-sub { display: flex; align-items: center; gap: ${u(10)}; flex-wrap: wrap; min-height: ${u(24)}; }
.v-mags { display: flex; gap: ${u(1)}; font-size: ${fs(18, 12)}; }
.v-dodge { display: flex; gap: ${u(3)}; }
.v-dodge .pip { width: ${u(18)}; height: ${u(24)}; display: grid; place-items: center; font-size: ${fs(12, 9)}; font-family: var(--font-display); font-weight: 900; border-radius: ${u(2)}; background: rgba(0, 0, 0, 0.5); color: rgba(255, 255, 255, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); text-shadow: none; }
.v-dodge .pip.on { background: linear-gradient(#fbf3de, #e0cc9c); color: #1f5a9a; border-color: #d6ad52; }
.v-gear { display: flex; gap: ${u(5)}; flex-wrap: wrap; }
.v-gear .gchip { font-size: ${fs(12, 9)}; padding: ${u(1)} ${u(6)}; border-radius: ${u(3)}; border: 1px solid var(--gc); color: color-mix(in srgb, var(--gc) 60%, #fff 40%); background: rgba(0, 0, 0, 0.5); white-space: nowrap; }

.hud-squad { min-width: ${u(230)}; padding: ${u(6)} ${u(10)}; background: var(--hud-bg); border: 1px solid var(--hud-line); border-radius: ${u(6)}; font-size: ${fs(13, 10)}; }
.sq-head { display: flex; justify-content: space-between; align-items: baseline; gap: ${u(10)}; }
.sq-title { font-family: var(--font-display); color: var(--gold-hi); font-size: ${fs(15, 11)}; font-weight: 800; }
.sq-order { color: #7fe09a; font-weight: 700; }
.sq-pips { display: flex; gap: ${u(4)}; margin: ${u(6)} 0; align-items: flex-end; min-height: ${u(22)}; flex-wrap: wrap; }
.sq-pips .pip { position: relative; width: ${u(12)}; height: ${u(22)}; background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(127, 224, 154, 0.6); border-radius: ${u(2)}; overflow: hidden; }
.sq-pips .pip i { position: absolute; inset: 0; background: linear-gradient(#9ff0b4, #2f9a4e); transform-origin: center bottom; }
.sq-pips .pip.hurt i { background: linear-gradient(#ffd27a, #c07a14); }
.sq-pips .pip.dead { opacity: 0.35; }
.sq-pips .none { opacity: 0.7; font-size: ${fs(12, 10)}; }
.sq-orders { display: flex; gap: ${u(4)}; }
.sq-orders .o { display: flex; align-items: center; gap: ${u(3)}; padding: ${u(1)} ${u(6)}; border-radius: ${u(3)}; border: 1px solid rgba(214, 173, 82, 0.3); font-family: var(--font-display); font-weight: 800; pointer-events: auto; cursor: pointer; }
.sq-orders .o .k { font-family: var(--font-body); font-size: ${fs(10, 9)}; opacity: 0.7; font-weight: 700; }
.sq-orders .o.on { background: rgba(46, 139, 87, 0.6); border-color: #7fe09a; color: #fff; }
.hud-squad.en .sq-orders .o { font-family: var(--font-body); font-size: ${fs(11, 9)}; font-weight: 700; }

/* ── abilities + items ─────────────────────────────────── */
.hud-abilities { position: absolute; bottom: ${u(18)}; left: 50%; transform: translateX(-50%); display: flex; align-items: flex-end; gap: ${u(14)}; }
.hud-abilities .abilities { display: flex; gap: ${u(12)}; align-items: flex-end; }
.hud-abilities .ab { position: relative; display: flex; flex-direction: column; align-items: center; gap: ${u(4)}; pointer-events: auto; }
.hud-abilities .ico { position: relative; width: ${u(60)}; height: ${u(60)}; border-radius: 50%; display: grid; place-items: center; overflow: hidden; background: radial-gradient(circle at 35% 30%, #6a4428, #1e140c); box-shadow: 0 0 0 ${u(2)} #d6ad52, 0 0 0 ${u(4)} rgba(0, 0, 0, 0.6), 0 ${u(4)} ${u(10)} rgba(0, 0, 0, 0.5); }
.hud-abilities .ico .g { font-family: var(--font-display); font-size: ${fs(19, 12)}; font-weight: 900; color: #f5dc98; letter-spacing: -0.02em; white-space: nowrap; }
.hud-abilities .ico .g.en { font-family: var(--font-body); font-size: ${fs(11.5, 9)}; font-weight: 800; letter-spacing: 0; max-width: 92%; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.hud-abilities .slot-passive .ico { width: ${u(46)}; height: ${u(46)}; background: radial-gradient(circle at 35% 30%, #4a5a34, #141a0c); }
.hud-abilities .slot-passive .ico .g { font-size: ${fs(14, 10)}; color: #d8e8b0; }
.hud-abilities .slot-passive .ico .g.en { font-size: ${fs(9.5, 8)}; }
.hud-abilities .slot-lord .ico { background: radial-gradient(circle at 35% 30%, #8a5a18, #2a1606); box-shadow: 0 0 0 ${u(2)} #f2c14e, 0 0 0 ${u(4)} rgba(0, 0, 0, 0.6), 0 0 ${u(12)} rgba(242, 193, 78, 0.55); }
.hud-abilities .cd { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(rgba(0, 0, 0, 0.74) calc(var(--p, 0) * 1turn), transparent 0); }
.hud-abilities .cdnum { position: absolute; inset: 0; display: grid; place-items: center; font-size: ${fs(21, 13)}; font-weight: 900; color: #fff; }
.hud-abilities .cooling .g { opacity: 0.4; }
.hud-abilities .recharging .cd, .sg-touch .tbtn.recharging .cd { background: conic-gradient(rgba(150, 205, 255, 0.95) calc(var(--p, 0) * 1turn), transparent 0); -webkit-mask: radial-gradient(closest-side, transparent 80%, #000 83%); mask: radial-gradient(closest-side, transparent 80%, #000 83%); }
.hud-abilities .recharging .cdnum { display: none; }
.hud-abilities .ab.inert { cursor: default; }
.hud-abilities .key { font-size: ${fs(12, 9)}; font-weight: 900; padding: 0 ${u(7)}; border-radius: ${u(3)}; background: rgba(0, 0, 0, 0.72); border: 1px solid #d6ad52; color: #f5dc98; text-shadow: none; line-height: 1.5; }
.hud-abilities .key.passive { font-weight: 400; border-color: transparent; background: transparent; color: #cfd8b0; text-shadow: 0 1px 2px #000; }
.hud-abilities .charges { position: absolute; top: ${u(-4)}; right: ${u(-6)}; min-width: ${u(18)}; height: ${u(18)}; border-radius: ${u(9)}; display: grid; place-items: center; background: #2e5fa8; font-size: ${fs(11, 9)}; font-weight: 900; }
.hud-abilities .charges:empty { display: none; }
.hud-abilities.silenced .ab:not(.slot-passive) .ico::after { content: '默'; position: absolute; inset: 0; display: grid; place-items: center; background: rgba(60, 20, 80, 0.62); font-family: var(--font-display); font-size: ${fs(20, 12)}; color: #e8c8ff; }
.hud-abilities .ab-sep { width: 1px; height: ${u(54)}; background: linear-gradient(transparent, rgba(214, 173, 82, 0.6), transparent); }
.hud-abilities .items { display: flex; gap: ${u(8)}; }
.hud-abilities .item { display: flex; flex-direction: column; align-items: center; gap: ${u(4)}; pointer-events: auto; }
.hud-abilities .item .key { order: 2; }
.hud-abilities .item .card { position: relative; width: ${u(44)}; height: ${u(58)}; border-radius: ${u(4)}; display: grid; place-items: center; background-color: #f3e7c8; background-image: var(--grain), linear-gradient(#fbf3de, #e2cf9f); border: 1.5px solid color-mix(in srgb, var(--ic, #999) 70%, #000 20%); box-shadow: 0 ${u(3)} ${u(8)} rgba(0, 0, 0, 0.5), inset 0 0 0 ${u(2)} rgba(255, 255, 255, 0.4); }
.hud-abilities .item .card { grid-template-rows: 1fr auto; padding-bottom: ${u(3)}; }
.hud-abilities .item .g { font-family: var(--font-display); font-size: ${fs(25, 14)}; font-weight: 900; color: var(--ic); text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6); line-height: 1; align-self: end; }
.hud-abilities .item .nm { max-width: 100%; padding: 0 ${u(2)}; font-size: ${fs(9.5, 8)}; font-weight: 700; line-height: 1.15; color: var(--in, #2b1d12); text-shadow: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud-abilities .item .card:not(.art-on) .nm.dup { display: none; }
.hud-abilities .item .cnt { position: absolute; right: ${u(-6)}; bottom: ${u(-6)}; min-width: ${u(18)}; height: ${u(18)}; padding: 0 ${u(4)}; border-radius: ${u(9)}; display: grid; place-items: center; background: #b3261e; color: #fff; font-size: ${fs(11, 9)}; font-weight: 900; text-shadow: none; }
.hud-abilities .item .cnt:empty { display: none; }
/* what you just got: compact lines right above the item bar, newest at the bottom (feed.ts PickupStrip) */
.hud-pickups { position: absolute; left: 50%; bottom: ${u(108)}; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: ${u(4)}; pointer-events: none; }
.pk-row { display: inline-flex; align-items: center; gap: ${u(7)}; padding: ${u(2)} ${u(12)} ${u(2)} ${u(3)}; border-radius: 999px; background: rgba(18, 12, 7, 0.72); border: 1px solid var(--hud-line); font-size: ${fs(13, 11)}; white-space: nowrap; animation: sg-pk-in 0.2s ease-out; transition: opacity 0.3s; }
.pk-row.out { opacity: 0; }
.pk-row .pk-t { font-weight: 700; color: #f5ead0; }
.pk-row .pk-n { color: var(--gold-hi); font-size: 0.9em; }
.pk-row .pk-n:empty { display: none; }
.pk-ico { position: relative; flex: none; display: inline-grid; place-items: center; width: ${u(24)}; height: ${u(24)}; border-radius: 50%; font-family: var(--font-display); font-size: ${fs(13, 10)}; font-weight: 900; color: var(--ic); background: linear-gradient(#fbf3de, #e2cf9f); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ic) 65%, #000 25%); text-shadow: none; overflow: hidden; }
.pk-ico > .sg-art { position: absolute; inset: 0; width: 100%; height: 100%; }
.pk-ico.art-on { color: transparent; background: #140d08; }
.pk-row .pk-w { width: ${u(46)}; margin: ${u(-4)} 0; }
.pk-row:not(:has(> .pk-ico, > .pk-w)) { padding-left: ${u(12)}; }
@keyframes sg-pk-in { from { opacity: 0; transform: translateY(${u(8)}); } }
.sg-hud.dead .hud-pickups { display: none; }
.sg-hud.touch .hud-pickups { bottom: calc(clamp(44px, 12vmin, 62px) * 0.95 + 16px); }
.hud-abilities .item.empty .card { background: rgba(0, 0, 0, 0.35); border: 1.5px dashed rgba(214, 173, 82, 0.4); box-shadow: none; }

/* ── weapon ────────────────────────────────────────────── */
.hud-weapon { --rc: #b9b2a2; position: absolute; right: ${u(16)}; bottom: ${u(16)}; display: flex; flex-direction: column; align-items: flex-end; gap: ${u(6)}; }
.w-slots { display: flex; gap: ${u(6)}; }
.wslot { display: flex; align-items: center; gap: ${u(5)}; padding: ${u(2)} ${u(8)}; font-size: ${fs(12, 9)}; background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(214, 173, 82, 0.25); border-bottom: 2px solid var(--rc, #888); border-radius: ${u(3)}; opacity: 0.65; white-space: nowrap; }
.wslot.active { opacity: 1; background: rgba(40, 26, 14, 0.8); }
.wslot .k { font-weight: 900; color: var(--gold); }
.w-main { min-width: ${u(290)}; padding: ${u(8)} ${u(16)}; text-align: right; background: linear-gradient(270deg, rgba(18, 12, 7, 0.88), rgba(18, 12, 7, 0.5)); border: 1px solid var(--hud-line); border-right: ${u(4)} solid var(--rc); border-radius: ${u(6)}; }
.w-title { display: flex; justify-content: flex-end; align-items: baseline; gap: ${u(6)}; }
.w-name { font-family: var(--font-display); font-size: ${fs(22, 13)}; font-weight: 900; color: #fff3d6; white-space: nowrap; }
.w-card { font-size: ${fs(12, 9)}; opacity: 0.72; white-space: nowrap; }
.w-ammo { line-height: 1; font-variant-numeric: tabular-nums; margin-top: ${u(2)}; }
.w-ammo .mag { font-size: ${fs(48, 24)}; font-weight: 900; }
.w-ammo .mag.low { color: #ffb070; }
.w-ammo .mag.empty { color: #ff5a4a; }
.w-ammo .sep { font-size: ${fs(22, 13)}; opacity: 0.5; margin: 0 ${u(4)}; }
.w-ammo .res { font-size: ${fs(22, 13)}; opacity: 0.8; }
.w-reload { display: none; align-items: center; gap: ${u(8)}; justify-content: flex-end; font-size: ${fs(12, 10)}; margin-top: ${u(4)}; color: #f5dc98; }
.w-reload.on { display: flex; }
.w-reload .track { width: ${u(150)}; height: ${u(5)}; background: rgba(0, 0, 0, 0.6); border-radius: ${u(3)}; overflow: hidden; }
.w-reload .track i { display: block; height: 100%; background: linear-gradient(90deg, #d6ad52, #f5dc98); transform-origin: left center; transform: scaleX(0); }

/* ── chat ──────────────────────────────────────────────── */
.hud-chat { position: absolute; left: ${u(16)}; bottom: ${u(300)}; width: ${u(440)}; max-width: 44vw; font-size: ${fs(14, 11)}; }
.hud-chat .log { max-height: ${u(200)}; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: ${u(2)}; }
.hud-chat .line { padding: ${u(2)} ${u(8)}; background: rgba(0, 0, 0, 0.45); border-radius: ${u(3)}; transition: opacity 0.6s; overflow-wrap: anywhere; }
.hud-chat .line.old { opacity: 0; }
.hud-chat .line b { font-weight: 700; color: var(--gold-hi); }
.hud-chat .line.k-quick span { color: #ffe0a0; }
.hud-chat .line.k-claim { border-left: ${u(3)} solid currentColor; }
.hud-chat .line.k-system { font-style: italic; opacity: 0.85; }
.hud-chat .input-row { display: none; margin-top: ${u(6)}; gap: 6px; align-items: center; }
.hud-chat .input-row .sg-input { flex: 1; min-width: 0; }
.hud-chat .chat-send, .hud-chat .chat-close { display: none; flex: none; height: 34px; min-width: 34px; padding: 0 10px; border-radius: 6px; border: 1px solid rgba(245, 220, 152, 0.6); background: rgba(20, 12, 6, 0.85); color: #f5dc98; font-weight: 700; }
.hud-chat .chat-send { background: rgba(140, 30, 18, 0.85); }
.sg-hud.touch .hud-chat .chat-send, .sg-hud.touch .hud-chat .chat-close { display: inline-grid; place-items: center; }
.hud-chat.open { pointer-events: auto; z-index: 21; }
.hud-chat.open .input-row { display: flex; }
.hud-chat.open .log { overflow-y: auto; max-height: ${u(280)}; background: rgba(0, 0, 0, 0.35); padding: ${u(4)}; border-radius: ${u(4)}; }
.hud-chat.open .line.old { opacity: 1; }

/* ── overlays ──────────────────────────────────────────── */
.hud-overlay-slot { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; padding: 1em; z-index: 20; font-size: clamp(13px, calc(0.45vw + 0.45vh + 5px), 17px); text-shadow: none; pointer-events: none; }
/* the slot itself lets touches through (map, scoreboard: the stick and fire stay usable
   around the panel); only the panel takes them — modal slots (wheel, pause, controls,
   chat backdrop) catch every tap on their backdrop */
.hud-overlay-slot > * { pointer-events: auto; }
.hud-overlay-slot.modal { pointer-events: auto; }
.sg-hud[data-overlay="map"] .hud-overlay-slot.map,
.sg-hud[data-overlay="wheel"] .hud-overlay-slot.wheel,
.sg-hud[data-overlay="pause"] .hud-overlay-slot.pause,
.sg-hud[data-overlay="controls"] .hud-overlay-slot.controls,
.sg-hud[data-overlay="chat"] .hud-overlay-slot.chatback,
.sg-hud.show-score .hud-overlay-slot.score { display: flex; }
/* close buttons: the toggle key on desktop, a big ✕ on touch */
.hud-close { flex: none; display: inline-grid; place-items: center; min-width: 2em; height: 2em; padding: 0 0.3em; border: 0; background: transparent; cursor: pointer; }
.hud-close .x { display: none; }
.sg-hud.touch .hud-close { min-width: 40px; height: 40px; border-radius: 50%; background: rgba(20, 12, 6, 0.8); border: 1.5px solid rgba(245, 220, 152, 0.7); }
.sg-hud.touch .hud-close .k { display: none; }
.sg-hud.touch .hud-close .x { display: inline; font-size: 20px; line-height: 1; color: #f5dc98; }
.hud-scoreboard .sb-head .hud-close { margin-left: auto; }
.sg-hud.show-score .hud-overlay-slot.score { z-index: 19; }
.hud-overlay-slot.pause { padding: 0; }
.hud-overlay-slot.controls { background: rgba(8, 5, 3, 0.58); }
.sg-hud:is([data-overlay="wheel"], [data-overlay="pause"], [data-overlay="controls"], [data-overlay="map"], .show-score) :is(.hud-announce, .hud-interact, .hud-xhair, .hud-channel, .hud-zonewarn, .hud-killstamp, .hud-dmg) { visibility: hidden; }
.hud-scoreboard { width: min(64em, 96vw); max-height: 88vh; overflow: auto; padding: 1em 1.4em 1.2em; animation: sg-pop 0.15s ease-out; }
.hud-scoreboard .sb-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6em 1em; flex-wrap: wrap; margin-bottom: 0.5em; }
.hud-scoreboard .sb-head h2 { color: var(--red-lo); }
/* 延迟 column only with remote players (overlays.ts hasRemotePlayers) */
.hud-scoreboard .no-ping :is(th, td):nth-child(8) { display: none; }
.hud-scoreboard .sb-stats { display: flex; gap: 1em; flex-wrap: wrap; font-size: 0.9em; color: var(--paper-mute); }
.hud-scoreboard .sb-stats b { color: var(--paper-ink); margin-right: 0.25em; font-size: 1.15em; }
.hud-scoreboard tr.me td { background: rgba(179, 38, 30, 0.08); }
.hud-scoreboard tr.dead td { opacity: 0.55; }
.hud-scoreboard .st.dead { color: #8a3a2a; font-weight: 700; }
.hud-scoreboard .st.downed { color: #b06a10; font-weight: 700; }
.hud-scoreboard .st.alive { color: #1f7a3a; font-weight: 700; }
.hud-scoreboard .sg-chip.ally { color: #5a6a86; margin-left: 0.4em; font-size: 0.75em; }
.hud-scoreboard .role-cell.claim { font-weight: 600; opacity: 0.9; }
.hud-bigmap { display: flex; flex-direction: column; gap: 0.5em; padding: 0.8em 1em 0.9em; width: min(94vw, calc(100vh - 7em)); animation: sg-pop 0.15s ease-out; }
.bm-head { display: flex; align-items: center; justify-content: space-between; gap: 1em; }
.bm-head h2 { color: var(--gold-hi); font-size: 1.25em; }
.bm-frame { width: 100%; aspect-ratio: 1; border: 2px solid var(--gold-lo); border-radius: 4px; overflow: hidden; background: #2a2016; }
.bm-canvas { display: block; width: 100%; height: 100%; }
.bm-legend { display: flex; flex-wrap: wrap; gap: 0.3em 1.1em; font-size: 0.85em; }
.bm-legend .lg { display: inline-flex; align-items: center; gap: 0.35em; }
.bm-legend i { display: inline-block; width: 0.9em; height: 0.9em; }
.bm-legend .you { background: #fff4c8; clip-path: polygon(50% 0, 100% 100%, 50% 72%, 0 100%); }
.bm-legend .squad { background: #7fe09a; border-radius: 50%; }
.bm-legend .lord { background: #f2c14e; clip-path: polygon(0 100%, 0 25%, 25% 60%, 50% 10%, 75% 60%, 100% 25%, 100% 100%); }
.bm-legend .known { background: #d94a3a; border-radius: 50%; }
.bm-legend .drop { background: #f2c14e; border: 1px solid #5a3a08; }
.bm-legend .zone { border: 2px solid #ff7840; border-radius: 50%; }
.bm-legend .next { border: 2px dashed #fff; border-radius: 50%; }
.hud-wheel { position: relative; width: min(74vmin, 34em); aspect-ratio: 1; animation: sg-pop 0.15s ease-out; }
.wh-ring { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle, rgba(20, 12, 6, 0.9) 0 27%, rgba(20, 12, 6, 0.62) 28% 69%, transparent 70%); border: 2px solid rgba(214, 173, 82, 0.5); }
.wh-item { position: absolute; left: calc(50% + var(--x) * 0.74); top: calc(50% + var(--y) * 0.74); transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 0.15em; min-width: 7.2em; padding: 0.4em 0.7em; background: rgba(34, 22, 12, 0.94); border: 1px solid var(--gold-lo); border-radius: 6px; color: var(--paper); cursor: pointer; font-size: 0.95em; line-height: 1.25; }
.wh-item:hover, .wh-item:focus-visible { border-color: var(--gold-hi); background: #6a1e12; }
.wh-item .num { font-size: 0.7em; opacity: 0.6; }
.wh-item .glyph { display: inline-grid; place-items: center; width: 1.7em; height: 1.7em; border-radius: 16%; background: var(--seal); color: #fff; font-family: var(--font-display); font-weight: 900; }
.wh-item .lbl { font-family: var(--font-display); font-weight: 700; white-space: nowrap; }
.wh-item.claim .lbl { color: #ffe2b0; }
.wh-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 30%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 40% 35%, #7a2616, #2a0c06); border: 2px solid var(--gold); color: var(--gold-hi); font-family: var(--font-display); font-size: 0.85em; font-weight: 700; padding: 0.6em; cursor: pointer; line-height: 1.3; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.2em; }
.wh-center .x { display: none; font-size: 1.8em; line-height: 1; font-family: var(--font-body); }
.sg-hud.touch .wh-center .x { display: block; }
.wh-hint { position: absolute; bottom: -2.2em; left: 0; right: 0; text-align: center; font-size: 0.8em; opacity: 0.8; }
.hud-pause { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(8, 5, 3, 0.58); backdrop-filter: blur(2px); }
.hud-pause[data-mode="click"] { background: rgba(8, 5, 3, 0.32); backdrop-filter: none; cursor: pointer; }
.pm-wrap { display: flex; align-items: stretch; justify-content: center; gap: 1em; max-width: 96vw; max-height: calc(100% - 1em); }
.pm-box { width: min(22em, 90vw); flex: none; display: flex; flex-direction: column; gap: 0.7em; padding: 1.3em 1.6em 1.5em; animation: sg-pop 0.15s ease-out; overflow: auto; }
.pm-box h2 { color: var(--red-lo); margin-bottom: 0.3em; }
.pm-note { margin: -0.4em 0 0.2em; display: flex; align-items: center; gap: 0.45em; font-size: 0.9em; color: var(--paper-mute); }
.pm-note .live { width: 0.6em; height: 0.6em; border-radius: 50%; background: #2e8b57; box-shadow: 0 0 0 3px rgba(46, 139, 87, 0.25); animation: sg-hud-blink 1s ease-in-out infinite alternate; }
.pm-cards { width: min(26em, 44vw); display: flex; flex-direction: column; min-height: 0; padding: 1em 1.1em; animation: sg-pop 0.15s ease-out; }
.pm-cards.static { animation: none; }
.pm-cards h3 { color: var(--red-lo); margin: 0 0 0.3em; }
.pc-scroll { flex: 1; min-height: 0; overflow: auto; padding-right: 0.2em; }
.pc-sub { font-size: 0.82em; color: var(--paper-mute); letter-spacing: 0.1em; margin: 0.2em 0; }
.pc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35em; }
.pc-card { display: flex; gap: 0.6em; align-items: flex-start; padding: 0.3em 0.45em; border-radius: 5px; background: rgba(255, 250, 235, 0.5); border: 1px solid rgba(140, 106, 38, 0.3); color: var(--paper-ink); }
.pc-card .item-glyph { flex: none; width: 1.8em; height: 2.35em; font-size: 0.95em; }
.pc-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.pc-text b { font-family: var(--font-display); font-size: 1em; }
.pc-text .cnt { font-family: var(--font-body); font-weight: 400; color: var(--paper-mute); }
.pc-text .desc { font-size: 0.82em; }
.pc-none { margin: 0.2em 0 0.4em; font-size: 0.88em; }
.pc-all-toggle { margin: 0.6em 0 0.4em; width: 100%; padding: 0.3em 0.6em; border-radius: 4px; border: 1px dashed var(--gold-lo); background: rgba(140, 106, 38, 0.1); color: var(--paper-ink); cursor: pointer; font-weight: 600; text-align: left; }
@media (max-width: 700px) { .pm-wrap { flex-direction: column; align-items: center; overflow: auto; } .pm-cards { width: min(22em, 90vw); max-height: 40vh; flex: none; } }
@media (max-height: 500px) {
  .pm-box { gap: 0.4em; padding: 0.8em 1.1em 0.9em; }
  .pm-box .sg-btn { padding-top: 0.25em; padding-bottom: 0.25em; min-height: 0; }
  .pm-box h2 { margin-bottom: 0; }
  .pm-cards { padding: 0.7em 0.9em; }
}
.click-prompt { display: flex; align-items: center; gap: 0.8em; padding: 0.7em 1.6em; font-family: var(--font-display); font-size: 1.35em; font-weight: 800; letter-spacing: 0.1em; color: var(--gold-hi); background: rgba(20, 12, 6, 0.82); border: 1px solid var(--gold); border-radius: 8px; cursor: pointer; animation: sg-breathe 2s ease-in-out infinite; }
.hud-controls { width: min(56em, 96vw); max-height: 90vh; overflow: auto; padding: 1.1em 1.4em; }
.ctl-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6em; }
.ctl-head h2 { color: var(--red-lo); }
.ctl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(19em, 1fr)); gap: 0.35em 1.2em; }
.ctl { display: flex; gap: 0.6em; align-items: center; font-size: 0.92em; }
.ctl .keys { min-width: 8.5em; display: flex; gap: 0.2em; flex-wrap: wrap; }

/* ── touch bar / rotate hint ───────────────────────────── */
.hud-touchbar { position: absolute; top: ${u(16)}; left: 50%; transform: translateX(-50%); margin-top: ${u(64)}; display: flex; gap: 8px; z-index: 12; pointer-events: auto; }
.hud-touchbar .tb { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; padding: 0; font-family: var(--font-display); font-size: 17px; font-weight: 800; color: #f5dc98; background: rgba(20, 12, 6, 0.7); border: 1.5px solid rgba(245, 220, 152, 0.6); touch-action: manipulation; }
.hud-touchbar .tb.word { font-family: var(--font-body); font-size: 10.5px; letter-spacing: -0.01em; }
.hud-touchbar .tb:active { background: rgba(179, 38, 30, 0.75); }
/* the bar stays on top of the map / scoreboard / wheel / chat so a second tap closes them */
.sg-hud.touch:not([data-overlay="pause"]):not([data-overlay="controls"]) .hud-touchbar { z-index: 23; }
.sg-hud[data-overlay="wheel"] .hud-touchbar .tb[data-key="wheel"],
.sg-hud[data-overlay="chat"] .hud-touchbar .tb[data-key="chat"],
.sg-hud[data-overlay="map"] .hud-touchbar .tb[data-key="map"],
.sg-hud.show-score .hud-touchbar .tb[data-key="score"] { background: rgba(179, 38, 30, 0.85); border-color: #ffd9a0; }
/* scoreboard on touch: below the touch bar, never over its 战 button */
.sg-hud.touch .hud-overlay-slot.score { align-items: flex-start; justify-content: flex-start; padding: calc(${u(16)} + 96px) calc(var(--tb) * 3.3) 6px 8px; }
.sg-hud.touch .hud-scoreboard { max-height: 100%; width: 100%; padding: 0.5em 0.8em 0.6em; }
.sg-hud.touch .hud-scoreboard :is(th, td):last-child { display: none; }
.sg-hud.touch .hud-scoreboard .sg-table :is(th, td) { padding-top: 0.2em; padding-bottom: 0.2em; }

/* ── card info (touch long-press) / first-match guide ──── */
.hud-cardinfo { position: absolute; left: 50%; bottom: calc(clamp(44px, 12vmin, 62px) * 1.15 + 16px); transform: translateX(-50%); width: min(24em, 80vw); z-index: 24; pointer-events: auto; font-size: ${fs(14, 12)}; text-shadow: none; animation: sg-fade 0.15s ease-out; }
.hud-cardinfo.off { display: none; }
.hud-cardinfo .pc-card { background: rgba(250, 242, 222, 0.96); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55); }
.hud-cardinfo .pc-discard { display: flex; margin: 0.4em auto 0; min-height: 2.2em; font-size: 0.95em; }
.sg-hud { --guide-w: min(clamp(250px, 26vw, 330px), 42vw); }
.hud-guide { position: absolute; right: ${u(16)}; top: 50%; transform: translateY(-50%); width: var(--guide-w); max-height: calc(100% - 2em); overflow: auto; z-index: 22; pointer-events: none; padding: 0.9em 1.1em 0.8em; font-size: clamp(12px, calc(0.4vw + 0.4vh + 5px), 15px); text-shadow: none; color: var(--paper-ink); animation: sg-pop 0.2s ease-out; }
/* the card itself lets touches through to the stick / look zone: only its buttons are targets */
.hud-guide button { pointer-events: auto; }
/* menus and panels cover it; the "click to play" prompt moves left of it instead of under it */
.sg-hud:not(.touch):has(.hud-guide) .hud-pause[data-mode="click"] { padding-right: calc(var(--guide-w) + ${u(16)} + 0.5em); }
.sg-hud:not(.touch):has(.hud-guide) .hud-pause[data-mode="click"] .click-prompt { max-width: calc(100% - 1em); flex-wrap: wrap; justify-content: center; }
.sg-hud:is([data-overlay="map"], [data-overlay="wheel"], [data-overlay="chat"], [data-overlay="controls"], .show-score, .dead) .hud-guide,
.sg-hud[data-overlay="pause"][data-pause-mode="menu"] .hud-guide { display: none; }
.hud-guide h3 { color: var(--red-lo); margin: 0 0 0.4em; }
.hud-guide .gd-x { position: absolute; top: 0.3em; right: 0.3em; width: 2em; height: 2em; border-radius: 50%; border: 0; background: rgba(140, 106, 38, 0.18); color: var(--paper-ink); cursor: pointer; }
.hud-guide .gd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3em; }
.hud-guide .gd-list li { display: flex; align-items: center; gap: 0.5em; font-size: 0.92em; line-height: 1.3; }
.hud-guide .keys { flex: none; min-width: 3.6em; display: inline-flex; gap: 0.2em; }
.hud-guide .tb-cap { display: inline-grid; place-items: center; min-width: 1.9em; height: 1.9em; padding: 0 0.3em; border-radius: 1em; background: #2a1a10; color: #f5dc98; font-weight: 800; font-size: 0.85em; }
.hud-guide .gd-claim { margin: 0.6em 0 0.3em; font-size: 0.86em; line-height: 1.4; }
.hud-guide .gd-actions { display: flex; justify-content: flex-end; gap: 0.5em; }
.sg-hud.touch .hud-guide { top: calc(${u(16)} + 96px); transform: none; max-height: calc(100% - ${u(16)} - 104px); right: auto; left: ${u(16)}; width: min(19em, 36vw); padding: 0.55em 0.8em 0.5em; font-size: 11px; opacity: 0.94; }
.sg-hud.touch .hud-guide .gd-list { gap: 0.1em; }
.sg-hud.touch .hud-guide .gd-list li { font-size: 1em; }
.sg-hud.touch .hud-guide .keys { min-width: 2.4em; }
.sg-hud.touch .hud-guide .gd-claim { margin: 0.35em 0 0.25em; font-size: 0.95em; line-height: 1.3; }
.sg-hud.touch .hud-guide .sg-btn { font-size: 11px; padding: 0.2em 0.7em; min-height: 0; }
/* touch: the card cannot be scrolled (touches pass through it) — its buttons come first */
/* low specificity on purpose: the "covered by a menu / panel" rules above still hide it */
:where(.sg-hud.touch) .hud-guide { display: flex; flex-direction: column; }
.sg-hud.touch .hud-guide h3 { order: -2; }
.sg-hud.touch .hud-guide .gd-actions { order: -1; justify-content: flex-start; margin: 0 0 0.35em; }
.sg-rotate { position: absolute; inset: 0; z-index: 60; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 1.2em; padding: 2em; text-align: center; background: #0e0906; color: var(--gold-hi); font-family: var(--font-display); font-size: 1.2em; pointer-events: auto; }
.sg-rotate .phone { width: 56px; height: 96px; border: 3px solid var(--gold); border-radius: 10px; position: relative; animation: sg-rot 2.4s ease-in-out infinite; }
.sg-rotate .phone::after { content: ''; position: absolute; left: 50%; bottom: 6px; width: 10px; height: 10px; border-radius: 50%; transform: translateX(-50%); border: 2px solid var(--gold); }
@keyframes sg-rot { 0%, 20% { transform: rotate(0deg); } 50%, 80% { transform: rotate(-90deg); } 100% { transform: rotate(0deg); } }
@media (orientation: portrait) and (max-width: 820px) { .sg-rotate { display: flex; } }

/* ── narrow / short screens (640×360) ──────────────────── */
/* the kill feed moves below the zone banner instead of running into it */
@media (max-width: 900px) {
  .hud-feed { top: calc(${u(16)} + 50px); max-width: min(${u(560)}, 40vw); }
}
/* the claim wheel keeps clear of the zone banner and clock */
@media (max-height: 520px) {
  .hud-overlay-slot.wheel { padding-top: 58px; padding-bottom: 26px; }
  .hud-wheel { width: min(calc(100vh - 96px), 30em); }
  .wh-item { min-width: 6em; padding: 0.25em 0.5em; font-size: 0.85em; }
  .wh-hint { bottom: -1.9em; }
  .sg-hud[data-overlay="wheel"] .hud-feed { visibility: hidden; }
}

/* ── touch mode layout tweaks ──────────────────────────── */
.sg-hud.touch .hud-abilities, .sg-hud.touch .hud-squad, .sg-hud.touch .w-slots, .sg-hud.touch .v-name, .sg-hud.touch .v-portrait { display: none; }
.sg-hud.touch { --tb: clamp(44px, 12vmin, 62px); }
.sg-hud.touch .hud-left { left: 50%; transform: translateX(-50%); bottom: calc(var(--tb) * 0.95 + 16px); }
.sg-hud.touch .hud-vitals { width: min(${u(420)}, 38vw); }
.sg-hud.touch .v-main { padding: ${u(6)} ${u(10)}; }
.sg-hud.touch .v-status { justify-content: center; min-height: 0; margin-bottom: ${u(4)}; }
.sg-hud.touch .hud-weapon { bottom: auto; top: ${u(16)}; right: ${u(250)}; }
.sg-hud.touch .w-main { min-width: 0; padding: ${u(4)} ${u(12)}; }
/* long (English) weapon names never push the panel into the zone banner */
.sg-hud.touch .w-name { display: inline-block; max-width: 22vw; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.sg-hud.touch .w-card { display: none; }
.sg-hud.touch .w-ammo .mag { font-size: ${fs(30, 20)}; }
.sg-hud.touch .hud-feed { top: calc(${u(16)} + 58px); right: ${u(250)}; max-width: 34vw; }
.sg-hud.touch .hud-feed .kf:nth-last-child(n + 4) { display: none; }
.sg-hud.touch .hud-touchbar { left: ${u(16)}; top: calc(${u(16)} + 40px); transform: none; margin-top: 0; }
.sg-hud.touch .hud-chat { bottom: auto; top: calc(${u(16)} + 92px); width: 30vw; }
.sg-hud.touch .hud-chat .log { max-height: 72px; }
.sg-hud.touch .hud-announce { top: 33%; }
.sg-hud.touch .role-chip .goal { display: none; }
.sg-hud.touch .hud-interact { top: calc(50% + ${u(56)}); }
.sg-hud.touch .hud-zonewarn { top: 26%; }

/* ── touch overlay ─────────────────────────────────────── */
.sg-touch { --b: clamp(44px, 12vmin, 62px); position: absolute; inset: 0; z-index: 5; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.sg-touch .zone { position: absolute; top: 0; bottom: 0; }
.sg-touch .zone.move { left: 0; width: 42%; }
.sg-touch .zone.look { right: 0; width: 58%; }
.sg-touch .stick-base { position: absolute; left: clamp(70px, 16vmin, 110px); top: calc(100% - clamp(80px, 22vmin, 130px)); width: 120px; height: 120px; border-radius: 50%; transform: translate(-50%, -50%); border: 2px solid rgba(245, 220, 152, 0.35); background: rgba(0, 0, 0, 0.18); opacity: 0.55; pointer-events: none; }
.sg-touch .stick-base.active { opacity: 1; }
.sg-touch .stick-base.sprint { border-color: #ff9a6a; }
.sg-touch .stick-knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; border-radius: 50%; transform: translate(-50%, -50%); background: radial-gradient(circle at 35% 30%, #f5dc98, #8c6a26); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5); }
.sg-touch .stick-base.sprint .stick-knob { background: radial-gradient(circle at 35% 30%, #ffc8a0, #b3261e); }
.sg-touch .cluster { position: absolute; bottom: 0; width: 0; height: 0; }
.sg-touch .cluster.right { right: 0; }
.sg-touch .cluster.left { left: 0; }
.sg-touch .tbtn { position: absolute; width: var(--b); height: var(--b); border-radius: 50%; display: grid; place-items: center; overflow: hidden; background: rgba(20, 12, 6, 0.55); border: 2px solid rgba(245, 220, 152, 0.55); color: #f5dc98; font-family: var(--font-display); font-weight: 900; font-size: calc(var(--b) * 0.38); text-shadow: 0 1px 2px #000; touch-action: none; }
.sg-touch .tbtn .l { position: relative; z-index: 1; }
.sg-touch .tbtn.word .l { font-family: var(--font-body); font-size: calc(var(--b) * 0.2); font-weight: 800; letter-spacing: -0.01em; text-align: center; line-height: 1.05; max-width: 94%; overflow: hidden; }
.sg-touch .fire.word .l { font-size: calc(var(--b) * 0.3); }
.sg-touch .tbtn.ab .l { font-size: calc(var(--b) * 0.27); letter-spacing: -0.04em; white-space: nowrap; }
.sg-touch .tbtn.ab.word .l { font-size: calc(var(--b) * 0.18); }
.sg-touch .tbtn .k { position: absolute; top: 5%; left: 50%; transform: translateX(-50%); z-index: 1; font-family: var(--font-body); font-size: calc(var(--b) * 0.16); font-weight: 800; opacity: 0.8; line-height: 1; }
.sg-touch .tbtn .cs { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; font-family: var(--font-body); font-size: calc(var(--b) * 0.34); font-weight: 900; color: #fff; text-shadow: 0 1px 3px #000; }
.sg-touch .tbtn .cs:empty { display: none; }
.sg-touch .tbtn.cooling .l { opacity: 0.35; }
.sg-touch .tbtn.down { background: rgba(179, 38, 30, 0.72); }
.sg-touch .tbtn.on { background: rgba(46, 139, 87, 0.72); }
.sg-touch .tbtn .cd { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(rgba(0, 0, 0, 0.72) calc(var(--p, 0) * 1turn), transparent 0); }
.sg-touch .tbtn.cooling { color: rgba(245, 220, 152, 0.5); }
.sg-touch .fire { width: calc(var(--b) * 1.55); height: calc(var(--b) * 1.55); right: calc(var(--b) * 0.5); bottom: calc(var(--b) * 0.55); background: rgba(150, 30, 20, 0.6); border-color: #ffb08a; font-size: calc(var(--b) * 0.55); }
.sg-touch .jump { right: calc(var(--b) * 0.3); bottom: calc(var(--b) * 2.35); }
.sg-touch .ads { right: calc(var(--b) * 1.5); bottom: calc(var(--b) * 2.25); }
.sg-touch .dodge { right: calc(var(--b) * 2.35); bottom: calc(var(--b) * 0.3); }
.sg-touch .reload { right: calc(var(--b) * 2.45); bottom: calc(var(--b) * 1.4); width: calc(var(--b) * 0.85); height: calc(var(--b) * 0.85); }
.sg-touch .ab-q { right: calc(var(--b) * 3.55); bottom: calc(var(--b) * 0.45); }
.sg-touch .ab-e { right: calc(var(--b) * 3.5); bottom: calc(var(--b) * 1.6); }
.sg-touch .ab-lord { right: calc(var(--b) * 2.7); bottom: calc(var(--b) * 2.55); border-color: #f2c14e; }
.sg-touch .interact { right: calc(var(--b) * 4.7); bottom: calc(var(--b) * 1.0); background: rgba(46, 90, 60, 0.6); }
.sg-touch .swap { right: calc(var(--b) * 0.45); bottom: calc(var(--b) * 3.45); width: calc(var(--b) * 0.8); height: calc(var(--b) * 0.8); }
.sg-touch .order { left: calc(var(--b) * 0.35); bottom: calc(var(--b) * 3.6); width: calc(var(--b) * 0.85); height: calc(var(--b) * 0.85); background: rgba(46, 139, 87, 0.45); }
.sg-touch .mark { left: calc(var(--b) * 1.4); bottom: calc(var(--b) * 3.6); width: calc(var(--b) * 0.85); height: calc(var(--b) * 0.85); }
.sg-touch .item-bar { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); display: flex; gap: 8px; }
.sg-touch .item { position: relative; width: calc(var(--b) * 0.75); height: calc(var(--b) * 0.95); border-radius: 5px; background: linear-gradient(#fbf3de, #e2cf9f); border: 1.5px solid color-mix(in srgb, var(--ic, #999) 70%, #000 20%); color: var(--ic); font-size: calc(var(--b) * 0.4); text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6); }
.sg-touch .item { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 0 1px; }
.sg-touch .item .g { font-family: var(--font-display); font-weight: 900; line-height: 1; }
.sg-touch .item .n { max-width: 100%; font-size: 8px; letter-spacing: -0.03em; font-weight: 700; line-height: 1.1; color: var(--in, #2b1d12); text-shadow: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-touch .item:not(.art-on) .n.dup { display: none; }
.sg-touch .item .c { position: absolute; right: 1px; bottom: 0; font-size: 11px; color: #b3261e; font-family: var(--font-body); }
.sg-touch .item .k { position: absolute; left: 2px; top: 0; transform: none; font-size: 9px; color: #6d5639; font-family: var(--font-body); text-shadow: none; opacity: 1; }
.sg-touch .item.empty { background: rgba(0, 0, 0, 0.35); border: 1.5px dashed rgba(214, 173, 82, 0.4); }
.sg-touch.dead .cluster, .sg-touch.dead .item-bar, .sg-touch.dead .stick-base { display: none; }
.sg-touch.downed .fire, .sg-touch.downed .ads, .sg-touch.downed .ab { opacity: 0.35; }
`;
