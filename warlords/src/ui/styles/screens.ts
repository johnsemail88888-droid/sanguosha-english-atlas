// Menu screens: title, single, online, lobby, roles, hero select, loading,
// game over, gallery, help, settings.
export const SCREENS_CSS = /* css */ `
.sg-screen {
  position: absolute;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 1.2em;
  background-color: #120c08;
  background-image: radial-gradient(ellipse at 50% -15%, rgba(190, 120, 50, 0.28), transparent 60%), radial-gradient(ellipse at 50% 125%, rgba(130, 25, 12, 0.4), transparent 60%), var(--grain), linear-gradient(180deg, #1d140d, #0e0906);
  animation: sg-fade 0.25s ease-out;
}
.sg-center { display: flex; align-items: center; justify-content: center; gap: 0.6em; min-height: 60vh; }
@keyframes sg-pulse { from { transform: scale(1); } to { transform: scale(1.12); } }
@keyframes sg-breathe { 0%, 100% { box-shadow: 0 0 0 rgba(245, 200, 110, 0); } 50% { box-shadow: 0 0 22px rgba(245, 200, 110, 0.45); } }

/* ── title ─────────────────────────────────────────────── */
.sg-title { display: flex; align-items: center; justify-content: center; padding: 0; overflow: hidden; background: #0f0a07; }
.sg-title-bg { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.sg-title-bg .sky { position: absolute; inset: 0; background: linear-gradient(180deg, #100a07 0%, #26160f 30%, #5c2c16 55%, #a9542a 68%, #d98a4a 72%, #5a2a16 80%, #140c08 100%); }
.sg-title-bg .sun { position: absolute; left: 64%; top: 60%; width: 30vmin; height: 30vmin; border-radius: 50%; transform: translate(-50%, -50%); background: radial-gradient(circle, #ffe2b0 0%, #f7a050 32%, rgba(220, 90, 30, 0.55) 52%, rgba(200, 60, 20, 0) 70%); animation: sg-sun 9s ease-in-out infinite alternate; }
@keyframes sg-sun { from { transform: translate(-50%, -50%) scale(1); opacity: 0.92; } to { transform: translate(-50%, -52%) scale(1.06); opacity: 1; } }
.sg-title-bg .cloud { position: absolute; left: -30%; width: 70%; height: 7vmin; border-radius: 50%; background: radial-gradient(ellipse, rgba(255, 220, 180, 0.22), transparent 70%); filter: blur(6px); animation: sg-cloud 70s linear infinite; }
.sg-title-bg .cloud.c1 { top: 30%; }
.sg-title-bg .cloud.c2 { top: 44%; height: 5vmin; animation-duration: 95s; animation-delay: -40s; opacity: 0.7; }
@keyframes sg-cloud { from { transform: translateX(0); } to { transform: translateX(160%); } }
.sg-title-bg .drift { position: absolute; left: 0; width: 200%; animation: sg-drift 200s linear infinite; }
.sg-title-bg .drift svg { display: block; width: 100%; height: 100%; }
.sg-title-bg .drift.far { bottom: 20%; height: 32%; opacity: 0.85; animation-duration: 260s; }
.sg-title-bg .drift.mid { bottom: 5%; height: 34%; animation-duration: 170s; }
.sg-title-bg .drift.near { bottom: -3%; height: 28%; animation-duration: 100s; }
@keyframes sg-drift { to { transform: translateX(-50%); } }
.sg-title-bg .mist { position: absolute; left: 0; right: 0; bottom: 14%; height: 22%; background: linear-gradient(180deg, transparent, rgba(230, 200, 170, 0.14) 45%, transparent); filter: blur(8px); animation: sg-mist 14s ease-in-out infinite alternate; }
@keyframes sg-mist { from { transform: translateX(-3%); opacity: 0.7; } to { transform: translateX(3%); opacity: 1; } }
.sg-title-bg .flags i { position: absolute; bottom: 0; width: 0.5vmin; height: 46vh; background: linear-gradient(#2a1a10, #0c0806); }
.sg-title-bg .flags i::after { content: ''; position: absolute; top: 2vh; left: 0.5vmin; width: 9vmin; height: 20vh; background: linear-gradient(180deg, #7e1a10, #4a0e08); clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 86%, 0 100%); transform-origin: left center; animation: sg-flag 3.2s ease-in-out infinite alternate; }
.sg-title-bg .flags .f1 { left: 6%; }
.sg-title-bg .flags .f2 { right: 8%; height: 40vh; }
.sg-title-bg .flags .f2::after { left: auto; right: 0.5vmin; transform-origin: right center; animation-delay: -1.4s; }
@keyframes sg-flag { from { transform: skewY(-3deg) scaleX(0.94); } to { transform: skewY(3deg) scaleX(1); } }
.sg-title-bg .embers i { position: absolute; bottom: -12px; left: var(--x); width: var(--s); height: var(--s); border-radius: 50%; background: #ffd27a; box-shadow: 0 0 6px 2px rgba(255, 160, 60, 0.7); opacity: 0; animation: sg-ember var(--d) linear var(--delay) infinite; }
@keyframes sg-ember { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 0.95; } 70% { opacity: 0.7; } 100% { transform: translate(var(--drift), -105vh); opacity: 0; } }
.sg-title-bg .vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 45%, transparent 45%, rgba(0, 0, 0, 0.65) 100%); }
.sg-title-top { position: absolute; top: 1em; right: 1em; z-index: 3; }
.sg-title-main { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 1em; padding: 1.5em 1em 3em; width: 100%; max-width: 44em; }
.sg-logo { position: relative; text-align: center; font-family: var(--font-display); line-height: 1; padding: 0 1.2em; }
.sg-logo .l1 {
  font-size: clamp(3.3em, 12vmin, 8.4em);
  font-weight: 900;
  letter-spacing: 0.14em;
  padding-left: 0.14em;
  background: linear-gradient(180deg, #fff6d2 0%, #f3cd6a 42%, #b37b22 68%, #f7dc90 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 3px 0 #3a1a08) drop-shadow(0 0 20px rgba(240, 150, 60, 0.35));
}
.sg-logo .l2 { margin-top: 0.12em; font-size: clamp(1.7em, 5.4vmin, 3.9em); font-weight: 800; color: #f5e4ba; letter-spacing: 0.32em; padding-left: 0.32em; text-shadow: 0 2px 0 #2a1208, 0 0 14px rgba(0, 0, 0, 0.7); }
.sg-logo .dot { color: var(--red-hi); margin-right: 0.05em; }
.sg-logo > .sg-seal { position: absolute; right: -0.2em; top: -0.1em; transform: rotate(10deg); font-size: clamp(0.9em, 2.2vmin, 1.6em); }
.sg-logo .en { font-family: "Palatino Linotype", "Book Antiqua", Georgia, serif; letter-spacing: 0.55em; font-size: clamp(0.7em, 1.6vmin, 1em); color: var(--gold); margin-top: 0.9em; white-space: pre; }
.sg-tagline { font-family: var(--font-display); color: rgba(245, 225, 180, 0.8); letter-spacing: 0.3em; font-size: 1.05em; text-shadow: 0 1px 3px #000; }
.sg-title-menu { display: flex; flex-direction: column; gap: 0.65em; width: min(22em, 92vw); margin-top: 0.4em; }
.sg-title-menu .row { display: flex; gap: 0.65em; }
.sg-title-menu .row > * { flex: 1; min-width: 0; }
.sg-name { display: flex; align-items: center; gap: 0.6em; color: var(--gold-hi); font-family: var(--font-display); font-weight: 700; letter-spacing: 0.08em; white-space: nowrap; }
.sg-name .sg-input { flex: 1; min-width: 0; }
.sg-menu-btn { justify-content: space-between; padding: 0.4em 1.2em; min-height: 2.7em; }
.sg-menu-btn .lbl { font-size: 1.05em; }
.sg-menu-btn .sub { font-family: var(--font-body); font-size: 0.7em; font-weight: 400; letter-spacing: 0.02em; opacity: 0.82; text-shadow: none; }
.sg-menu-btn.primary { font-size: 1.2em; min-height: 2.9em; animation: sg-breathe 3.2s ease-in-out infinite; }
.sg-menu-btn.primary.off { animation: none; }
.sg-webgl-warn { padding: 0.7em 0.95em 0.8em; border: 1px solid rgba(220, 70, 50, 0.9); border-left-width: 4px; border-radius: 4px; background: rgba(38, 10, 7, 0.9); color: #f6e7c8; font-size: 0.88em; line-height: 1.5; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); }
.sg-webgl-warn b { display: block; color: #ff9b7e; font-family: var(--font-display); font-size: 1.12em; letter-spacing: 0.08em; margin-bottom: 0.25em; }
.sg-webgl-warn p { margin: 0 0 0.5em; }
.sg-webgl-warn .why { font: 0.85em/1.4 ui-monospace, Menlo, Consolas, monospace; color: rgba(246, 231, 200, 0.6); }
/* no WebGL: the notice makes the menu taller — let it scroll instead of clipping the logo, compact on short screens */
.sg-title.no-gl { overflow-y: auto; align-items: safe center; }
@media (max-height: 560px) {
  .sg-title.no-gl .sg-tagline, .sg-title.no-gl .sg-logo .en, .sg-title.no-gl .sg-title-foot, .sg-webgl-warn .why { display: none; }
  .sg-title.no-gl .sg-title-main { gap: 0.6em; padding-top: 0.8em; }
  .sg-webgl-warn { font-size: 0.78em; padding: 0.5em 0.8em 0.6em; }
}
/* landscape phones: the whole title (logo → 设置) fits 390 px, the footer never covers a button */
@media (max-height: 520px) {
  .sg-title { overflow-y: auto; align-items: safe center; }
  .sg-title-main { gap: 0.45em; padding: 0.7em 1em 2.2em; }
  .sg-logo .l1 { font-size: clamp(2.4em, 13vh, 3.4em); }
  .sg-logo .l2 { font-size: clamp(1.1em, 6vh, 1.6em); margin-top: 0.05em; }
  .sg-logo .en { margin-top: 0.4em; font-size: 0.62em; }
  .sg-logo > .sg-seal { font-size: 0.8em; }
  .sg-tagline { font-size: 0.85em; }
  .sg-title-menu { gap: 0.4em; margin-top: 0; }
  .sg-menu-btn { min-height: 2.25em; padding-top: 0.2em; padding-bottom: 0.2em; }
  .sg-menu-btn.primary { min-height: 2.4em; font-size: 1.1em; }
  .sg-title-foot { position: static; margin-top: 0.4em; font-size: 0.7em; }
  .sg-title { flex-direction: column; justify-content: safe center; }
}
@media (max-height: 400px) { .sg-tagline { display: none; } }

/* with the painted key art: the compact phone title also drops the tagline, so more of the painting shows */
@media (max-height: 480px) {
  .sg-title.has-art:not(.no-gl) .sg-tagline { display: none; }
}

.sg-view-failed .sg-fail-detail { font: 0.82em/1.4 ui-monospace, Menlo, Consolas, monospace; opacity: 0.7; word-break: break-word; }
.sg-title-foot { position: absolute; left: 0; right: 0; bottom: 0.7em; z-index: 2; display: flex; justify-content: center; gap: 1.2em; flex-wrap: wrap; font-size: 0.78em; color: rgba(240, 220, 180, 0.55); text-shadow: 0 1px 2px #000; padding: 0 1em; text-align: center; }

/* ── generic menu sheet ───────────────────────────────── */
.sg-menu-screen { display: flex; align-items: flex-start; justify-content: center; padding: 3.6em 1em 1.5em; }
.sg-sheet { width: min(46em, 100%); padding: 1.4em 2em 1.7em; margin: auto 0; }
.sg-sheet > h1 { color: var(--red-lo); margin-bottom: 0.5em; }
.sg-sheet-actions { display: flex; justify-content: center; margin-top: 1.3em; }
/* short screens: 出征 stays on screen while the options scroll */
@media (max-height: 560px) {
  .sg-menu-screen { padding-top: 3em; padding-bottom: 0; }
  .sg-sheet { padding-top: 0.9em; padding-bottom: 0; }
  .sg-sheet > h1 { margin-bottom: 0.2em; font-size: 1.5em; }
  .sg-single .sg-field { padding-top: 0.35em; padding-bottom: 0.35em; }
  .sg-single .sg-sheet-actions { position: sticky; bottom: 0; z-index: 2; margin: 0.4em -2em 0; padding: 0.5em 1em 0.7em; background: linear-gradient(180deg, rgba(227, 207, 163, 0), var(--paper-2) 35%); }
  /* the join error + "switch mode and retry" stay inside the panel (MP2-11) */
  .sg-online .sg-sheet { padding-bottom: 1em; }
  .sg-online-status { margin-top: 0.7em; }
}
.sg-sheet .sg-field .sg-hint, .sg-sheet .sg-field > span:not(.sg-label) { font-size: 0.88em; }
/* one row per variant: the seals shrink to fit the column instead of leaving 内 alone on a second line (MP2-11) */
.sg-role-preview { display: flex; flex-direction: column; gap: 0.35em; container-type: inline-size; min-width: 0; }
.sg-role-preview .variant { --n: 5; display: flex; gap: 0.3em; align-items: center; flex-wrap: nowrap; }
.sg-role-preview .vlabel { flex: none; font-weight: 700; color: var(--paper-mute); width: 1.2em; }
.sg-role-preview .cell { display: inline-flex; flex: none; font-size: min(1em, calc((100cqw - 1.6em) / (var(--n) * 2.25))); }
.sg-stars { letter-spacing: 0.05em; }
.sg-stars .on { color: #c0392b; }
.sg-stars .off { color: rgba(140, 106, 38, 0.35); }

/* ── online ────────────────────────────────────────────── */
.sg-online-mode { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6em 1em; padding: 0.4em 0 1em; border-bottom: 1px dashed rgba(140, 106, 38, 0.45); }
.sg-online-mode .sg-label { font-weight: 700; }
.sg-online-mode .desc { flex: 1 1 14em; font-size: 0.9em; }
.sg-online-cols { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 1.2em; margin-top: 1.1em; align-items: start; }
.sg-online-cols .col { display: flex; flex-direction: column; gap: 0.55em; align-items: flex-start; }
.sg-online-cols .col h2 { color: var(--red-lo); }
.sg-online-cols .col p { margin: 0; font-size: 0.92em; }
.sg-online-cols .or { align-self: stretch; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--paper-mute); font-family: var(--font-display); }
.sg-online-cols .or::before, .sg-online-cols .or::after { content: ''; flex: 1; width: 1px; background: linear-gradient(transparent, var(--gold-lo), transparent); }
.sg-online-cols .or span { padding: 0.4em 0; }
.join-row { display: flex; gap: 0.5em; width: 100%; }
.sg-code-input { font-family: "Consolas", "Menlo", monospace; font-size: 1.3em; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; }
.sg-online-status { min-height: 1.6em; margin-top: 1.1em; text-align: center; }
.sg-online-status .err { color: var(--red); font-weight: 600; }
.sg-note { margin-top: 0.8em; padding: 0.45em 0.8em; border: 1px solid rgba(140, 106, 38, 0.5); background: rgba(214, 173, 82, 0.1); border-radius: 4px; font-size: 0.92em; }
.sg-lan { margin-top: 1em; padding-top: 0.6em; border-top: 1px dashed rgba(140, 106, 38, 0.45); }
.sg-lan .sg-h2 { margin: 0 0 0.3em; }
.sg-lan p { margin: 0 0 0.5em; }
.lan-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4em; }
.lan-row { display: flex; align-items: center; gap: 0.6em; flex-wrap: wrap; }
.lan-url { font-family: ui-monospace, Consolas, monospace; font-size: 1.05em; padding: 0.25em 0.6em; background: rgba(30, 20, 12, 0.08); border: 1px solid rgba(140, 106, 38, 0.4); border-radius: 4px; user-select: all; word-break: break-all; }
.sg-warn { margin-top: 0.8em; padding: 0.5em 0.8em; border: 1px solid var(--red); background: rgba(179, 38, 30, 0.08); color: var(--red-lo); border-radius: 4px; }
.sg-invite { margin: 0 0 0.8em; padding: 0.5em 0.8em; border-radius: 4px; background: rgba(214, 173, 82, 0.2); border: 1px solid var(--gold-lo); font-weight: 600; text-align: center; }
.sg-invite.sg-rejoin { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.4em 0.8em; }
.sg-rejoin .rejoin-btn { flex: none; }

/* ── lobby ─────────────────────────────────────────────── */
.sg-lobby { display: flex; flex-direction: column; gap: 0.9em; padding: 1.1em 1.5em; }
.lobby-head { display: flex; align-items: center; gap: 1em; flex-wrap: wrap; }
.lobby-head h1 { color: var(--gold-hi); text-shadow: 0 2px 0 #000; }
.code-box { display: flex; align-items: center; gap: 0.7em; margin-left: auto; flex-wrap: wrap; }
.room-code { display: flex; flex-direction: column; align-items: center; padding: 0.15em 1.1em 0.25em; background: linear-gradient(#2c1f14, #1a120b); border: 1px solid var(--gold); border-radius: 6px; cursor: pointer; color: inherit; box-shadow: inset 0 0 0 3px rgba(214, 173, 82, 0.15); }
.room-code:hover { border-color: var(--gold-hi); }
.room-code .lbl { font-size: 0.7em; color: var(--gold); letter-spacing: 0.2em; }
.room-code .code { font-family: "Consolas", "Menlo", monospace; font-size: 2em; font-weight: 800; letter-spacing: 0.22em; padding-left: 0.22em; color: var(--gold-hi); text-shadow: 0 0 10px rgba(245, 200, 100, 0.35); line-height: 1.1; }
.lobby-grid { flex: 1; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 0.9fr); gap: 1em; min-height: 0; }
.lobby-grid > section { padding: 1em 1.2em; min-height: 0; overflow: auto; }
.box-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6em; margin-bottom: 0.6em; flex-wrap: wrap; }
.sg-panel .box-head h2 { color: var(--red-lo); }
.sg-dark .box-head h2 { color: var(--gold-hi); }
.seat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4em; }
.seat { display: grid; grid-template-columns: 1.4em 2.2em minmax(0, 1fr) auto auto; align-items: center; gap: 0.6em; padding: 0.35em 0.6em; border-radius: 5px; background: rgba(255, 250, 235, 0.5); border: 1px solid rgba(140, 106, 38, 0.35); }
.seat.mine { border-color: var(--red); box-shadow: inset 0 0 0 1px var(--red); }
.seat.empty { background: transparent; border-style: dashed; grid-template-columns: 1.4em 2.2em minmax(0, 1fr); }
.seat .no { font-weight: 700; color: var(--paper-mute); text-align: center; }
.seat .avatar { width: 2.2em; height: 2.2em; border-radius: 50%; display: grid; place-items: center; font-family: var(--font-display); font-weight: 700; background: linear-gradient(#6a4526, #2a1a10); color: var(--gold-hi); border: 1px solid var(--gold-lo); }
.seat.bot .avatar { background: linear-gradient(#5a5a5a, #2a2a2a); color: #e8e8e8; }
.seat.empty .avatar { background: transparent; border-style: dashed; color: var(--paper-mute); }
.seat .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat .you { color: var(--red); font-weight: 400; font-size: 0.85em; }
.seat .acts { display: flex; gap: 0.3em; }
.sg-chip.ready { color: #1f7a3a; }
.sg-chip.wait { color: #9a6a14; }
.sg-chip.host { color: #9a6a14; }
.sg-chip.bot { color: #6a6a6a; margin-left: 0.4em; font-size: 0.75em; }
.sg-chip.lordc { color: #9a6a14; }
.box-head .count { margin-left: auto; }
.seat-tools { display: flex; justify-content: flex-end; }
.box-head .seat-tools { align-self: center; }
.settings-panel .sg-field { grid-template-columns: minmax(6em, 36%) 1fr; }
.settings-panel .ro { font-weight: 700; }
/* a guest only reads the settings: two per row, so 身份分配 fits a short screen (MP2-11) */
.settings-panel .ro-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 1.4em; }
.settings-panel .ro-grid .sg-field { grid-template-columns: minmax(0, 1fr) auto; }
/* 身份分配: the label above, the seals across the whole panel */
.settings-panel .sg-field:has(> .sg-role-preview) { grid-template-columns: minmax(0, 1fr); gap: 0.35em; }
.chat { display: flex; flex-direction: column; }
.chat-log { flex: 1; min-height: 8em; overflow-y: auto; padding: 0.5em; background: rgba(0, 0, 0, 0.3); border-radius: 4px; font-size: 0.92em; display: flex; flex-direction: column; gap: 0.2em; user-select: text; }
.chat-line b { color: var(--gold-hi); font-weight: 600; }
.chat-line.system { opacity: 0.75; font-style: italic; }
.chat-row { display: flex; gap: 0.4em; margin-top: 0.5em; }
.chat-row .sg-input { flex: 1; min-width: 0; }
.lobby-foot { display: flex; align-items: center; justify-content: space-between; gap: 1em; flex-wrap: wrap; padding: 0.2em 0.2em; }
.lobby-foot .status { color: rgba(240, 225, 190, 0.75); }
.lobby-foot .act { display: flex; align-items: center; gap: 1em; margin-left: auto; flex-wrap: wrap; }
.lobby-foot .warn { color: #ffb08a; }
@media (max-width: 1100px) { .lobby-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .lobby-grid .chat { grid-column: 1 / -1; min-height: 14em; } }
/* short but wide (960×540): seats, settings and chat side by side, each full height */
@media (max-height: 620px) and (min-width: 900px) {
  .lobby-grid { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.9fr); }
  .lobby-grid .chat { grid-column: auto; min-height: 0; }
  .sg-lobby { gap: 0.6em; padding: 0.8em 1.2em; }
  .settings-panel .sg-field { grid-template-columns: minmax(0, 1fr); gap: 0.25em; }
  .room-code .code { font-size: 1.6em; }
}
.lobby-tabs { display: none; }
/* phones: one panel at a time (tabs), each with the full height */
@media (max-height: 520px) and (max-width: 899px), (max-width: 720px) {
  .lobby-tabs { display: flex; gap: 0.3em; }
  .lobby-tabs .lt { flex: 1; padding: 0.35em 0.6em; border-radius: 5px 5px 0 0; border: 1px solid rgba(214, 173, 82, 0.45); border-bottom: 0; background: rgba(0, 0, 0, 0.35); color: var(--paper); font-family: var(--font-display); font-weight: 700; cursor: pointer; }
  .lobby-tabs .lt.on { background: linear-gradient(180deg, #8e2616, #5c160c); color: var(--gold-hi); border-color: var(--gold); }
  .lobby-grid { grid-template-columns: minmax(0, 1fr) !important; margin-top: -0.9em; }
  .lobby-grid > section { grid-column: 1 / -1 !important; min-height: 0 !important; }
  .lobby-grid[data-tab="seats"] > :not(.seats-panel),
  .lobby-grid[data-tab="settings"] > :not(.settings-panel),
  .lobby-grid[data-tab="chat"] > :not(.chat) { display: none; }
}
@media (max-height: 520px) and (max-width: 899px) {
  .sg-lobby { gap: 0.5em; padding: 0.5em 0.9em; }
  .lobby-head h1 { font-size: 1.4em; }
  .room-code { padding: 0 0.8em 0.1em; }
  .room-code .code { font-size: 1.35em; }
  .lobby-grid > section { padding: 0.6em 0.9em; }
  .seat { padding: 0.2em 0.5em; }
  .seat .avatar { width: 1.8em; height: 1.8em; }
  .lobby-foot { padding: 0; }
  .lobby-foot .sg-btn.big { padding-top: 0.3em; padding-bottom: 0.3em; min-height: 0; }
}
@media (max-width: 720px) {
  .sg-lobby { padding: 0.8em; }
  .lobby-grid { grid-template-columns: minmax(0, 1fr); flex: none; }
  .lobby-grid > section { overflow: visible; }
  .code-box { margin-left: 0; width: 100%; }
  .seat { grid-template-columns: 1.2em 2em minmax(0, 1fr) auto auto; gap: 0.4em; padding: 0.3em 0.4em; }
  .lobby-foot .act { width: 100%; justify-content: space-between; }
  .lobby-foot { position: sticky; bottom: -0.8em; z-index: 3; margin: 0 -0.8em -0.8em; padding: 0.8em; background: linear-gradient(180deg, rgba(14, 9, 6, 0), #0e0906 40%); }
}

/* ── roles ─────────────────────────────────────────────── */
.sg-roles { display: flex; flex-direction: column; align-items: center; gap: 1.1em; padding: 1.4em 1em 2em; }
.sg-roles > :first-child { margin-top: auto; }
.sg-roles > :last-child { margin-bottom: auto; }
.sg-roles > h1 { color: var(--gold-hi); width: min(40em, 100%); }
.sg-roles .stage { display: flex; gap: 2.4em; align-items: center; justify-content: center; flex-wrap: wrap; }
.sg-roles .card-col { display: flex; flex-direction: column; align-items: center; gap: 0.7em; }
.sg-roles .hint { font-size: 0.85em; }
.flip-card { position: relative; width: clamp(10em, 30vmin, 19em); aspect-ratio: 5 / 7; perspective: 1400px; cursor: pointer; container-type: inline-size; }
.flip-card .face { position: absolute; inset: 0; border-radius: 12px; backface-visibility: hidden; -webkit-backface-visibility: hidden; transition: transform 0.9s cubic-bezier(0.3, 1.3, 0.5, 1); overflow: hidden; }
.flip-card .face .frame { position: absolute; inset: 9px; border-radius: 7px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6em; }
.flip-card .back { background: radial-gradient(circle at 50% 38%, #b23a24, #5a120a 72%); box-shadow: 0 0 0 3px #d6ad52, 0 0 0 5px #3a1a08, 0 16px 34px rgba(0, 0, 0, 0.65); }
.flip-card .back .frame { border: 2px solid #e9c874; background: repeating-linear-gradient(45deg, rgba(255, 210, 120, 0.08) 0 6px, transparent 6px 12px); }
.flip-card .back-logo { font-family: var(--font-display); font-size: 4.6em; font-weight: 900; color: #f5d98a; text-shadow: 0 3px 0 #3a0a04; }
.flip-card .back-sub { color: #f5d98a; letter-spacing: 0.25em; font-size: 0.75em; font-family: var(--font-display); }
.flip-card .front { --rc: #b3261e; transform: rotateY(180deg); background-color: #efe2c4; background-image: var(--grain), linear-gradient(160deg, #f7eed8, #dcc596); box-shadow: 0 0 0 3px var(--rc), 0 0 0 5px #2a1a0c, 0 0 46px color-mix(in srgb, var(--rc) 65%, transparent), 0 16px 34px rgba(0, 0, 0, 0.65); }
.flip-card .front .frame { border: 2px solid var(--gold-lo); }
.flip-card .front .rname { font-family: var(--font-display); font-size: min(2.3em, calc(78cqi / (var(--len, 2) * 1.2))); font-weight: 900; color: var(--paper-ink); letter-spacing: 0.2em; padding-left: 0.2em; white-space: nowrap; }
.flip-card .front .faction { color: var(--paper-mute); letter-spacing: 0.2em; font-size: 0.85em; }
.flip-card.flipped .back { transform: rotateY(-180deg); }
.flip-card.flipped .front { transform: rotateY(0deg); }
.sg-roles .info { width: min(28em, 92vw); padding: 1.2em 1.5em; }
.sg-roles .info .yr { color: var(--paper-mute); letter-spacing: 0.2em; font-size: 0.85em; }
.sg-roles .info .rn { display: flex; align-items: center; gap: 0.6em; font-family: var(--font-display); font-size: 1.8em; font-weight: 900; margin: 0.2em 0 0.5em; color: var(--paper-ink); }
.sg-roles .info h3 { color: var(--red-lo); margin-top: 0.6em; }
.sg-roles .info p { margin: 0.2em 0 0; }
.sg-roles .announce { text-align: center; display: flex; flex-direction: column; gap: 0.3em; align-items: center; }
.sg-roles .lordline { font-family: var(--font-display); font-size: 1.35em; color: var(--gold-hi); text-shadow: 0 2px 0 #000; }
.sg-roles .crown, .sg-select .crown { color: #f2c14e; margin-right: 0.3em; }
.sg-select .crown.decoy { color: #c9d1dc; }
.sg-roles .bounty { display: inline-flex; align-items: center; gap: 0.3em; color: #ffc38a; }
.sg-roles .crown-secret { display: inline-flex; align-items: center; gap: 0.3em; max-width: min(40em, 94vw); text-align: left; padding: 0.2em 0.8em 0.2em 0.3em; border-radius: 1em; background: rgba(0, 0, 0, 0.45); border: 1px dashed #c9d1dc; color: #e6ecf5; }
.sg-roles .crown-secret.trueLord { border-color: #f2c14e; color: var(--gold-hi); }
.seat-strip { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5em; max-width: 60em; }
.seat-chip { display: flex; align-items: center; gap: 0.45em; padding: 0.3em 0.8em 0.3em 0.4em; border-radius: 999px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(214, 173, 82, 0.35); }
.seat-chip.me { border-color: var(--gold-hi); box-shadow: 0 0 10px rgba(245, 220, 152, 0.3); }
.seat-chip.lord { border-color: #f2c14e; }
.seat-chip.decoy { border-color: #c9d1dc; border-style: dashed; }
.seat-chip .unknown { width: 1.8em; height: 1.8em; display: grid; place-items: center; border-radius: 16%; border: 1px dashed rgba(240, 220, 180, 0.5); color: rgba(240, 220, 180, 0.6); font-weight: 700; }
.seat-chip .nm { font-weight: 600; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat-chip .no { font-size: 0.75em; opacity: 0.6; }

/* ── hero select ───────────────────────────────────────── */
.sg-select { display: flex; flex-direction: column; gap: 0.7em; padding: 0.9em 1.4em 1em; overflow: hidden; }
.sel-head { display: flex; align-items: center; justify-content: space-between; gap: 1em; }
.sel-head h1 { color: var(--gold-hi); text-shadow: 0 2px 0 #000; }
.sel-head .stage-text { color: var(--paper); opacity: 0.85; margin-top: 0.15em; }
.sg-ring { position: relative; width: 4.2em; height: 4.2em; flex: none; }
.sg-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.sg-ring circle { fill: none; stroke-width: 5; }
.sg-ring .bg { stroke: rgba(214, 173, 82, 0.2); }
.sg-ring .fg { stroke: var(--gold); stroke-linecap: round; transition: stroke 0.3s; }
.sg-ring .num { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: 1.5em; font-weight: 800; color: var(--gold-hi); }
.sg-ring.urgent .fg { stroke: var(--red-hi); }
.sg-ring.urgent .num { color: #ff8a70; animation: sg-pulse 0.5s ease-in-out infinite alternate; }
.picks-strip { display: flex; gap: 0.5em; overflow-x: auto; padding: 0.2em 0.1em 0.4em; flex: none; }
.pick { flex: none; width: 5.4em; display: flex; flex-direction: column; align-items: center; gap: 0.15em; font-size: 0.85em; opacity: 0.75; }
.pick .thumb { width: 3.4em; aspect-ratio: 5 / 7; border-radius: 6px; background: rgba(0, 0, 0, 0.35); border: 1px dashed rgba(214, 173, 82, 0.4); display: grid; place-items: center; overflow: hidden; }
.pick .thumb .sg-hcard { font-size: 0.42em; box-shadow: none; cursor: default; border-radius: 0; transform: none; }
.pick .q { font-family: var(--font-display); font-size: 1.6em; color: rgba(240, 220, 180, 0.4); }
.pick.done { opacity: 1; }
.pick.done .thumb { border-style: solid; border-color: var(--gold-lo); }
.pick.me .thumb { border-color: var(--gold-hi); border-style: solid; }
.pick .who { display: flex; gap: 0.1em; max-width: 100%; align-items: baseline; }
.pick .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .what { font-size: 0.85em; color: var(--gold); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* crown-pick toast: a flex item of the header row (between the titles and the ring), never over the cards */
.lord-flash { flex: 1 1 0; min-width: 0; display: flex; justify-content: center; align-items: center; pointer-events: none; opacity: 0; transition: opacity 0.4s ease; }
.lord-flash .lf-band { display: flex; align-items: center; min-width: 0; max-width: 100%; padding: 0.4em 2.4em; font-family: var(--font-display); font-size: 1.6em; color: var(--gold-hi); white-space: nowrap; background: linear-gradient(90deg, transparent, rgba(20, 12, 6, 0.9) 20%, rgba(20, 12, 6, 0.9) 80%, transparent); }
.lord-flash .lf-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lord-flash .lf-hero { flex: none; margin-left: 0.3em; }
.lord-flash.show { opacity: 1; }
.lord-flash.show .lf-band { animation: sg-flash-in 0.35s ease-out; }
@keyframes sg-flash-in { from { opacity: 0; transform: scale(1.08); } }
@media (max-height: 480px) { .lord-flash .lf-band { font-size: 1.3em; padding: 0.3em 1.8em; } }
/* no room beside the titles (portrait phones): just under the header, over the picks strip */
@media (max-width: 600px) {
  .sel-head { position: relative; }
  .lord-flash { position: absolute; left: 0; right: 0; top: 100%; z-index: 5; margin-top: 0.3em; }
  .lord-flash .lf-band { font-size: 1.15em; padding: 0.35em 1.8em; }
}
.sel-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(19em, 28em); gap: 1.2em; }
.grid-wrap { min-height: 0; overflow: auto; padding: 0.6em 0.4em; display: flex; flex-direction: column; gap: 0.8em; }
.sg-select .grid { display: grid; gap: 1.2em; justify-content: center; align-content: start; }
.sg-select .grid.n-small { grid-template-columns: repeat(auto-fit, minmax(8em, min(16em, calc((100vh - 17.5em) / 1.4)))); }
.sg-select .grid.n-mid { grid-template-columns: repeat(auto-fill, minmax(8em, 1fr)); gap: 1em; }
.sg-select .grid.n-large { grid-template-columns: repeat(auto-fill, minmax(6.4em, 1fr)); gap: 0.8em; }
.sg-select.waiting .grid { opacity: 0.55; }
.sg-select.no-options .detail { display: none; }
.wait-note { text-align: center; font-family: var(--font-display); font-size: 1.2em; color: var(--gold-hi); }
.wait-note:empty { display: none; }
.sg-select .detail { display: flex; flex-direction: column; min-height: 0; padding: 1em 1.2em; }
.detail-body { flex: 1; overflow: auto; min-height: 0; padding-right: 0.2em; }
.detail-actions { display: flex; justify-content: center; padding-top: 0.8em; margin-top: 0.4em; border-top: 1px dashed rgba(140, 106, 38, 0.45); }
@media (max-width: 860px) {
  .sg-select { overflow-y: auto; }
  .sel-main { display: flex; flex-direction: column; flex: none; }
  .grid-wrap { overflow: visible; }
  .sg-select .grid.n-small { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.6em; }
  .sg-select .grid.n-mid { grid-template-columns: repeat(auto-fill, minmax(6em, 1fr)); gap: 0.6em; }
  .sg-select .detail { overflow: visible; }
  .detail-body { overflow: visible; padding-bottom: 0.5em; }
  /* an opaque bar with an edge: the 专属武器 stats scroll under it instead of showing through a fade (PLATFORM-9) */
  .detail-actions { position: sticky; bottom: -1em; z-index: 2; background: #dcc594; box-shadow: 0 -6px 10px -4px rgba(60, 40, 15, 0.35); margin: 0 -1.2em -1em; padding: 0.6em 1.2em 1em; }
  .sg-select .sg-hcard .vname { font-size: 1.1em; }
}

/* landscape phones (844×390): grid and detail side by side, 选定 always on screen */
@media (max-height: 520px) and (min-aspect-ratio: 4/3) {
  .sg-select { overflow: hidden; gap: 0.3em; padding: 0.45em 0.9em 0.5em; font-size: 13px; }
  .sel-head { gap: 0.6em; }
  .sel-head h1 { font-size: 1.35em; }
  .sel-head .stage-text { font-size: 0.82em; margin-top: 0; }
  .sg-ring { width: 2.9em; height: 2.9em; }
  .sg-ring .num { font-size: 1.1em; }
  .picks-strip { gap: 0.3em; padding: 0 0.1em 0.1em; }
  /* the seats share the row (8 × ~100 px at 844): 「人机3」「AI·孙仲谋」 in full, not 「人…」 (PLATFORM-9) */
  .pick { flex: 1 1 0; width: auto; min-width: 4.2em; max-width: 8.6em; font-size: 0.78em; flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 0 0.2em; }
  .pick .thumb { width: 1.7em; }
  .pick .who { max-width: calc(100% - 2em); }
  .pick .what { width: 100%; text-align: center; }
  .sel-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(15em, 44%); flex: 1; min-height: 0; gap: 0.7em; }
  .grid-wrap { overflow: auto; padding: 0.3em 0.2em; }
  .sg-select .grid.n-small { grid-template-columns: repeat(3, minmax(0, calc((100vh - 8.6em) / 1.4))); gap: 0.6em; }
  .sg-select .detail { overflow: hidden; padding: 0.5em 0.7em 0.55em; }
  .detail-body { overflow: auto; }
  .sg-select .hd-visual { display: none; }
  .sg-select .hd-name { font-size: 1.35em; }
  .sg-select .sg-ability { padding: 0.3em 0.5em; }
  .sg-select .sg-ability .ab-desc { font-size: 0.88em; margin-top: 0.15em; }
  .detail-actions { position: static; margin: 0; padding: 0.4em 0 0; background: none; }
  .detail-actions .sg-btn.big { padding-top: 0.3em; padding-bottom: 0.3em; min-height: 0; }
}
.sel-head .sel-back { position: static; flex: none; align-self: flex-start; }
.sg-roles > .sg-back { position: absolute; }
.roles-tip { width: min(40em, 94vw); margin-top: 0.2em; font-size: 0.9em; }
/* landscape phones (844×390): the card on the left; your role, the lord line, every seat and the tip beside
   it — nothing below the fold (the seat chips were cut, PLATFORM-9) */
@media (max-height: 520px) and (min-aspect-ratio: 4/3) {
  .sg-roles { display: grid; grid-template-columns: auto minmax(0, 36em); align-content: safe center; justify-content: center; column-gap: 1.6em; row-gap: 0.45em; padding: 0.5em 1.2em 0.6em; overflow-y: auto; }
  .sg-roles > h1 { grid-column: 1 / -1; width: auto; font-size: 1.5em; }
  .sg-roles .stage { display: contents; }
  .sg-roles .card-col { grid-column: 1; grid-row: 2 / span 4; align-self: center; gap: 0.35em; }
  .sg-roles .flip-card { width: min(10em, calc((100vh - 6em) * 0.66)); }
  .sg-roles :is(.info, .announce, .seat-strip, .roles-tip) { grid-column: 2; }
  .sg-roles .info { width: auto; padding: 0.55em 1.1em 0.6em; }
  .sg-roles .info .rn { font-size: 1.3em; margin: 0 0 0.15em; }
  .sg-roles .info .rn .sg-seal { --sz: 1.7em !important; }
  .sg-roles .info h3 { margin-top: 0.25em; font-size: 0.95em; }
  .sg-roles .info p { font-size: 0.9em; }
  .sg-roles .announce { align-items: flex-start; text-align: left; }
  .sg-roles .lordline { font-size: 1.05em; }
  .sg-roles .seat-strip { justify-content: flex-start; gap: 0.3em; max-width: none; }
  .sg-roles .seat-chip { font-size: 0.78em; padding: 0.12em 0.6em 0.12em 0.25em; }
  .sg-roles .roles-tip { width: auto; margin-top: 0; font-size: 0.8em; }
}

/* ── hero detail ───────────────────────────────────────── */
.sg-hero-detail { display: flex; flex-direction: column; gap: 0.75em; }
.hd-visual { position: relative; aspect-ratio: 16 / 10; max-height: 36vh; width: 100%; border-radius: 8px; overflow: hidden; background: radial-gradient(ellipse at 50% 35%, color-mix(in srgb, var(--kc) 55%, #fff 20%), color-mix(in srgb, var(--kc) 55%, #000 55%)); box-shadow: 0 0 0 2px var(--gold-lo); flex: none; }
.hd-visual .portrait { position: absolute; inset: 0; }
.hd-visual .portrait .ph { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: 7em; font-weight: 900; color: rgba(255, 245, 220, 0.3); }
.hd-visual .portrait img, .hd-visual canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hd-head { display: flex; align-items: center; gap: 0.8em; }
.hd-names { min-width: 0; }
.hd-name { font-family: var(--font-display); font-size: 1.8em; font-weight: 900; color: var(--paper-ink); line-height: 1.15; }
.hd-title { font-size: 0.5em; margin-left: 0.6em; color: var(--paper-mute); font-weight: 400; letter-spacing: 0.08em; }
.hd-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25em 0.5em; font-size: 0.88em; margin-top: 0.25em; }
.hd-meta .sg-mags { font-size: 1.2em; }
.hd-meta .sep { width: 1px; height: 1em; background: rgba(140, 106, 38, 0.5); }
.hd-abilities { display: flex; flex-direction: column; gap: 0.45em; }
.sg-ability { padding: 0.5em 0.7em; border-radius: 6px; background: rgba(255, 250, 235, 0.5); border: 1px solid rgba(140, 106, 38, 0.35); }
.sg-ability .ab-head { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4em; }
.sg-ability .ab-key { font-size: 0.78em; font-weight: 800; padding: 0.05em 0.5em; border-radius: 3px; color: #fff6e0; background: #6a4a2a; white-space: nowrap; }
.sg-ability .k-passive { background: #56683f; }
.sg-ability .k-q { background: #2e5fa8; }
.sg-ability .k-e { background: #7a3aa0; }
.sg-ability .k-lord { background: linear-gradient(#e0b04a, #9a6a14); color: #2a1a06; }
.sg-ability .ab-name { font-family: var(--font-display); font-weight: 900; font-size: 1.1em; }
.sg-ability .ab-sgs { color: var(--paper-mute); font-size: 0.85em; }
.sg-ability .ab-meta { margin-left: auto; font-size: 0.8em; color: var(--paper-mute); }
.sg-ability .ab-desc { margin: 0.3em 0 0; font-size: 0.92em; }
.sg-ability.dim { opacity: 0.62; }
.sg-ability .ab-note { margin: 0.2em 0 0; font-size: 0.8em; color: var(--red); }
.hd-gear { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.6em; }
.hd-sec h4 { margin: 0 0 0.3em; font-family: var(--font-display); color: var(--red-lo); letter-spacing: 0.1em; font-size: 1em; }
.hd-sec p { margin: 0; }
.hd-troop { padding: 0.35em 0.7em; border-radius: 6px; background: rgba(40, 28, 16, 0.07); border: 1px solid rgba(140, 106, 38, 0.3); }
.sg-weapon-card { padding: 0.5em 0.7em; border-radius: 6px; background: rgba(40, 28, 16, 0.07); border: 1px solid rgba(140, 106, 38, 0.35); }
.wc-head { display: flex; gap: 0.4em; align-items: baseline; flex-wrap: wrap; }
.wc-name { font-weight: 900; font-family: var(--font-display); font-size: 1.1em; }
.wc-card { color: var(--paper-mute); font-size: 0.85em; }
.wc-class { margin-left: auto; font-size: 0.78em; font-weight: 700; padding: 0 0.5em; border-radius: 3px; border: 1px solid currentColor; }
.wc-class.rarity-common { color: #6d6556; }
.wc-class.rarity-rare { color: #2a6fb0; }
.wc-class.rarity-epic { color: #7a3aa0; }
.wc-class.rarity-legendary { color: #b06a10; }
.wc-stats { display: flex; flex-wrap: wrap; gap: 0.2em 1em; margin: 0.3em 0; font-size: 0.85em; }
.wc-stats .st i { font-style: normal; color: var(--paper-mute); margin-right: 0.3em; }
.wc-desc { margin: 0; font-size: 0.88em; }
.hd-quotes { margin: 0; padding-left: 0.2em; list-style: none; font-family: var(--font-display); font-size: 1.05em; }
.hd-quotes li { margin: 0.15em 0; }
.hd-quotes .en { display: block; font-family: var(--font-body); font-size: 0.8em; color: var(--paper-mute); margin-left: 0.6em; }

/* ── loading ───────────────────────────────────────────── */
.sg-loading { display: flex; align-items: center; justify-content: center; }
.load-inner { display: flex; align-items: center; gap: 3em; flex-wrap: wrap; justify-content: center; padding: 2em 1em; max-width: 62em; }
.load-card { width: clamp(9em, 24vmin, 15em); flex: none; }
@media (max-height: 420px) {
  .load-inner { flex-wrap: nowrap; gap: 1.2em; padding: 0.8em 1em; }
  .load-card { width: 7.4em; }
}
.load-card .sg-hcard { cursor: default; }
.load-text { display: flex; flex-direction: column; gap: 1em; flex: 1 1 22em; max-width: 30em; }
.load-text h1 { color: var(--gold-hi); }
.load-hero .nm { font-family: var(--font-display); font-size: 2.4em; font-weight: 900; color: #fff3d6; }
.load-hero .ttl { margin-left: 0.6em; opacity: 0.7; }
.brush-bar { height: 8px; border-radius: 4px; background: rgba(214, 173, 82, 0.15); overflow: hidden; }
.brush-bar i { display: block; height: 100%; width: 40%; background: linear-gradient(90deg, transparent, var(--gold-hi), transparent); animation: sg-load 1.6s ease-in-out infinite; }
@keyframes sg-load { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
.brush-bar.det { height: 10px; position: relative; box-shadow: inset 0 0 0 1px rgba(214, 173, 82, 0.35); }
.brush-bar.det i { width: 0; animation: none; transform: none; transition: width 0.45s ease-out; background: linear-gradient(90deg, #8a5a1c, var(--gold-hi) 85%, #fff3d6); box-shadow: 0 0 12px rgba(255, 210, 120, 0.55); }
.brush-bar.det::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 245, 220, 0.35), transparent); width: 30%; animation: sg-load 1.6s ease-in-out infinite; }
.load-stage { font-size: 0.9em; color: #d9c49a; letter-spacing: 0.04em; margin-top: -0.4em; font-variant-numeric: tabular-nums; }
.tip { padding: 0.8em 1em; }
.tip b { color: var(--gold); margin-right: 0.6em; font-family: var(--font-display); }
.tip .tip-text { display: inline; margin: 0; }

/* ── game over ─────────────────────────────────────────── */
.sg-over { display: flex; align-items: flex-start; justify-content: center; padding: 1.5em 1em; background: rgba(10, 6, 4, 0.72); backdrop-filter: blur(3px); }
.over-sheet { width: min(64em, 100%); padding: 1.3em 1.8em 1.5em; margin: auto 0; }
.over-banner { display: flex; align-items: center; gap: 1.4em; justify-content: center; margin-bottom: 1em; flex-wrap: wrap; text-align: center; }
.over-banner .sg-seal { animation: sg-stamp 0.65s cubic-bezier(0.2, 1.6, 0.4, 1) both; }
@keyframes sg-stamp { from { transform: scale(2.4) rotate(-22deg); opacity: 0; } to { transform: scale(1) rotate(-4deg); opacity: 1; } }
.ob-text { display: flex; flex-direction: column; align-items: flex-start; gap: 0.2em; text-align: left; }
.ob-title { font-family: var(--font-display); font-size: 3em; font-weight: 900; letter-spacing: 0.3em; color: var(--red-lo); line-height: 1.1; }
.sg-over[data-outcome="defeat"] .ob-title { color: #3b3530; }
.sg-over[data-outcome="draw"] .ob-title { color: var(--gold-lo); }
.ob-reason { font-size: 1.05em; font-weight: 600; }
.over-body { display: grid; grid-template-columns: minmax(0, 1fr) 15em; gap: 1.2em; align-items: start; }
.over-table tr.me td { background: rgba(179, 38, 30, 0.09); }
.over-table tr.won td:first-child { box-shadow: inset 3px 0 0 #2e8b57; }
.over-table .you { color: var(--red); font-size: 0.85em; }
.hero-cell { display: inline-flex; align-items: center; gap: 0.45em; white-space: nowrap; }
.role-cell { display: inline-flex; align-items: center; gap: 0.4em; font-weight: 800; white-space: nowrap; }
.res { font-weight: 800; }
.res.w { color: #1f7a3a; }
.res.l { color: #8a3a2a; }
.res.d { color: #6d5639; }
.mvp { margin-left: 0.4em; padding: 0.05em 0.4em; background: linear-gradient(#f6d886, #c89b3c); color: #3a220e; font-weight: 800; border-radius: 3px; font-size: 0.75em; }
.over-side { display: flex; flex-direction: column; gap: 1em; }
.over-mvp { display: flex; gap: 0.8em; align-items: center; }
.over-mvp .lbl { font-family: var(--font-display); color: var(--red-lo); letter-spacing: 0.2em; }
.over-mvp .nm { font-family: var(--font-display); font-size: 1.4em; font-weight: 900; }
.mvp-card { position: relative; width: 4.6em; aspect-ratio: 5 / 7; border-radius: 6px; overflow: hidden; background: radial-gradient(#8a6a3a, #2a1a0c); box-shadow: 0 0 0 2px var(--gold), 0 4px 10px rgba(0, 0, 0, 0.4); flex: none; }
.mvp-card .portrait, .mvp-card .portrait img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.mvp-card .portrait .ph { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: 2.4em; color: rgba(255, 245, 220, 0.6); }
.over-stats h3 { color: var(--red-lo); margin-bottom: 0.4em; }
.stat-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5em; }
.stat-row .stat { background: rgba(255, 250, 235, 0.5); border: 1px solid rgba(140, 106, 38, 0.35); border-radius: 6px; padding: 0.35em 0.6em; display: flex; flex-direction: column; }
.stat-row .stat b { font-size: 1.5em; font-family: var(--font-display); line-height: 1.1; }
.stat-row .stat span { font-size: 0.8em; color: var(--paper-mute); }
.over-actions { display: flex; justify-content: center; gap: 1em; margin-top: 1.3em; flex-wrap: wrap; align-items: center; }
.over-actions .wait { display: inline-flex; align-items: center; gap: 0.4em; }
@media (max-width: 820px) { .over-body { grid-template-columns: minmax(0, 1fr); } .over-sheet { padding: 1em; } .ob-title { font-size: 2.2em; } }
/* short screens: the buttons stay on screen while the table scrolls */
@media (max-height: 560px) {
  .sg-over { padding: 0.5em 0.8em 0; }
  .over-sheet { padding: 0.7em 1.1em 0; }
  .over-banner { margin-bottom: 0.4em; gap: 0.8em; }
  .over-banner .sg-seal { --sz: 3.2em !important; }
  .ob-title { font-size: 1.9em; }
  .over-body { grid-template-columns: minmax(0, 1fr) 13em; }
  .over-table :is(td, th) { padding-top: 0.15em; padding-bottom: 0.15em; }
  .over-actions { position: sticky; bottom: 0; z-index: 2; margin: 0.4em -1.1em 0; padding: 0.5em 1em 0.6em; background: linear-gradient(180deg, rgba(227, 207, 163, 0), var(--paper-2) 35%); }
}
/* 640×360: everything above the button bar — a slimmer banner, your four stats in one row (MP2-11) */
@media (max-height: 420px) {
  .over-banner { margin-bottom: 0.2em; }
  .over-banner .sg-seal { --sz: 2.4em !important; }
  .ob-title { font-size: 1.5em; }
  .ob-reason { font-size: 0.9em; }
  .ob-meta { font-size: 0.8em; }
  .over-table :is(td, th) { padding-top: 0.05em; padding-bottom: 0.05em; }
  .over-side { gap: 0.4em; }
  .mvp-card { width: 3.4em; }
  .over-mvp .nm { font-size: 1.15em; }
  .over-stats h3 { font-size: 1em; margin-bottom: 0.2em; }
  .stat-row { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.25em; }
  .stat-row .stat { padding: 0.15em 0.3em; }
  .stat-row .stat b { font-size: 1.05em; }
  .stat-row .stat span { font-size: 0.7em; white-space: nowrap; }
  .over-actions { padding: 0.3em 1em 0.4em; margin-top: 0.2em; }
  .over-actions .sg-btn { min-height: 2em; padding-top: 0.25em; padding-bottom: 0.25em; }
}

/* ── gallery ───────────────────────────────────────────── */
.sg-gallery { display: flex; flex-direction: column; gap: 0.7em; padding: 0.9em 1.4em 1em; overflow: hidden; }
.gal-head { display: flex; align-items: center; gap: 1em; }
.gal-head h1 { color: var(--gold-hi); text-shadow: 0 2px 0 #000; }
.gal-head .count { margin-left: auto; }
.gal-filter { display: flex; gap: 0.4em; flex-wrap: wrap; }
.kd-filter { display: inline-flex; align-items: center; padding: 0.3em 0.95em; border-radius: 999px; border: 1px solid rgba(214, 173, 82, 0.4); background: rgba(0, 0, 0, 0.3); color: var(--paper); cursor: pointer; font-family: var(--font-display); font-weight: 700; font-size: 1em; letter-spacing: 0.06em; }
.kd-filter.on { background: linear-gradient(#8e2616, #5c160c); border-color: var(--gold); color: var(--gold-hi); }
.kd-filter .dot { display: inline-grid; place-items: center; width: 1.45em; height: 1.45em; border-radius: 50%; font-style: normal; font-size: 0.8em; margin-right: 0.35em; color: #fff; }
.gal-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(22em, 34em); gap: 1.2em; }
.gal-grid-wrap { overflow: auto; min-height: 0; padding: 0.5em 0.4em; }
.gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(7.2em, 1fr)); gap: 1em; }
.gal-detail { overflow: auto; min-height: 0; padding: 1em 1.2em; }
.gal-detail .close-detail { position: sticky; top: 0; float: right; z-index: 2; display: none; color: var(--paper-ink); }
@media (max-width: 760px) {
  .sg-gallery { padding: 0.8em; }
  .gal-main { grid-template-columns: minmax(0, 1fr); }
  .gal-grid { grid-template-columns: repeat(auto-fill, minmax(6em, 1fr)); gap: 0.7em; }
  .gal-detail { display: none; }
  .sg-gallery.has-detail .gal-detail { display: block; position: fixed; inset: 0; z-index: 20; border-radius: 0; }
  .gal-detail .close-detail { display: inline-flex; }
}

/* ── help ──────────────────────────────────────────────── */
.sg-help { display: flex; flex-direction: column; gap: 0.6em; padding: 0.9em 1.4em 1em; overflow: hidden; }
.help-head { display: flex; align-items: center; gap: 1em; }
.help-head h1 { color: var(--gold-hi); text-shadow: 0 2px 0 #000; }
.sg-help > .sg-tabs { margin-bottom: -0.6em; position: relative; z-index: 1; padding-left: 0.4em; }
.help-body { flex: 1; min-height: 0; overflow: auto; padding: 1.2em 1.6em; user-select: text; }
.help-sec { margin-bottom: 1.6em; }
.help-sec h2 { color: var(--red-lo); margin-bottom: 0.5em; border-bottom: 1px solid rgba(140, 106, 38, 0.45); padding-bottom: 0.2em; }
.help-sec p, .help-sec li { max-width: 60em; }
.help-sec ul { padding-left: 1.2em; margin: 0.4em 0; }
.help-sec li { margin: 0.25em 0; }
.role-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(21em, 1fr)); gap: 0.7em; }
.role-row { display: flex; gap: 0.8em; align-items: flex-start; padding: 0.6em 0.7em; border-radius: 6px; background: rgba(255, 250, 235, 0.45); border: 1px solid rgba(140, 106, 38, 0.3); }
.rr-head { display: flex; align-items: center; gap: 0.5em; font-size: 1.1em; font-family: var(--font-display); margin-bottom: 0.2em; flex-wrap: wrap; }
.rr-head .sg-chip { font-family: var(--font-body); font-size: 0.7em; color: var(--paper-mute); }
.seal-row { display: inline-flex; gap: 0.2em; flex-wrap: wrap; }
.variants { display: flex; flex-direction: column; gap: 0.3em; }
.item-glyph { position: relative; display: inline-grid; place-items: center; width: 2em; height: 2.6em; border-radius: 4px; font-family: var(--font-display); font-weight: 900; color: var(--ig, var(--ic)); background: linear-gradient(#fbf3de, #e9d7ae); border: 1px solid color-mix(in srgb, var(--ic) 70%, #000 20%); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6); }
.sg-table.controls .keys { white-space: nowrap; width: 1%; }
.help-sec .sg-table td.num:first-child, .help-sec .sg-table th:first-child { width: 4.5em; text-align: center; }
.keys .sg-key { margin-right: 0.25em; }
.sg-table.weapons td.desc, .sg-table.items td:nth-child(4) { font-size: 0.88em; min-width: 14em; }
/* names never break mid-word: 黄巾力士 / 南蛮勇士, 无双战铳, 「专属」 below the name */
.sg-table.weapons td.wname { width: auto; text-align: left; }
.sg-table.weapons td.wname > b, .sg-table.items td > b { white-space: nowrap; }
.sg-table.weapons td.wname .sg-chip { margin-top: 0.2em; font-size: 0.78em; }
.sg-table.troops { width: auto; min-width: min(100%, 34em); }
.help-sec .sg-table.troops th:first-child { width: auto; text-align: left; }
.sg-table.troops :is(td, th):nth-child(-n + 2) { white-space: nowrap; }
.sg-table.troops td:last-child, .sg-table.troops th:last-child { white-space: nowrap; }
.sg-table.orders { width: auto; }
.sg-table.orders td:nth-child(-n + 2) { white-space: nowrap; width: 1%; }
@media (max-width: 640px) {
  .sg-help { padding: 0.7em; }
  .help-body { padding: 1em; }
  .role-list { grid-template-columns: minmax(0, 1fr); }
  .sg-tab { font-size: 0.9em; padding: 0.3em 0.7em; }
}

/* ── settings ──────────────────────────────────────────── */
.sg-settings { width: min(46em, 100%); min-height: min(36em, calc(100% - 1em)); display: flex; flex-direction: column; max-height: calc(100% - 1em); padding: 1.1em 1.4em 1.2em; overflow: hidden; }
.set-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em; }
.set-head h2 { color: var(--red-lo); }
.sg-settings .sg-tabs { margin-bottom: -1px; }
.set-body { flex: 1; overflow: auto; min-height: 0; padding: 0.5em 0.3em; border-top: 2px solid var(--gold-lo); }
.set-foot { display: flex; justify-content: space-between; gap: 0.6em; padding-top: 0.8em; border-top: 1px dashed rgba(140, 106, 38, 0.45); }
.net-explain { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.8em; margin: 0.4em 0 0.6em; }
.net-explain .opt { padding: 0.6em 0.8em; border-radius: 6px; background: rgba(255, 250, 235, 0.5); border: 1px solid rgba(140, 106, 38, 0.35); font-size: 0.88em; }
.net-explain .opt h3 { color: var(--red-lo); }
.net-explain .opt p { margin: 0.3em 0 0; }
.sg-root code { background: rgba(40, 28, 16, 0.12); padding: 0.05em 0.35em; border-radius: 3px; font-family: "Consolas", "Menlo", monospace; font-size: 0.95em; user-select: all; }
.row-actions { display: flex; justify-content: flex-end; padding-top: 0.6em; }
@media (max-width: 640px) {
  .sg-settings-back { padding: 0; }
  .sg-settings { max-height: 100%; height: 100%; width: 100%; border-radius: 0; padding: 0.9em 1em; }
  .net-explain { grid-template-columns: minmax(0, 1fr); }
  .sg-settings .sg-field { grid-template-columns: minmax(0, 1fr); gap: 0.3em; }
  .sg-field { grid-template-columns: minmax(0, 1fr); gap: 0.35em; }
  .sg-field .sg-hint { grid-column: 1; margin-top: 0; }
  .sg-sheet { padding: 1.1em 1.1em 1.4em; }
  .sg-online-cols { grid-template-columns: minmax(0, 1fr); }
  .sg-online-cols .or { flex-direction: row; }
  .sg-online-cols .or::before, .sg-online-cols .or::after { height: 1px; width: auto; background: linear-gradient(90deg, transparent, var(--gold-lo), transparent); }
  .sg-online-cols .or span { padding: 0 0.6em; }
}
`;
