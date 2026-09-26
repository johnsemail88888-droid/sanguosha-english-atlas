// Design tokens + shared components (panels, buttons, seals, magatama, cards,
// form controls). 三国杀 look: parchment, ink, gold frames, red seals.
export const BASE_CSS = /* css */ `
.sg-root {
  --ink: #15100b;
  --ink-2: #211810;
  --ink-3: #33251a;
  --ink-line: rgba(214, 173, 82, 0.35);
  --paper: #efe2c4;
  --paper-2: #e3cfa3;
  --paper-3: #cdb582;
  --paper-ink: #2b1d12;
  --paper-mute: #6d5639;
  --gold: #d6ad52;
  --gold-hi: #f5dc98;
  --gold-lo: #8c6a26;
  --red: #b3261e;
  --red-hi: #d8432f;
  --red-lo: #6e140f;
  --jade: #3fae6a;
  --jade-hi: #7fe09a;
  --blue: #5aa0e0;
  --wei: #2e5fa8;
  --shu: #c0392b;
  --wu: #2e8b57;
  --qun: #8a8a8a;
  --god: #c9a227;
  --font-display: "STKaiti", "KaiTi", "Kaiti SC", "楷体", "BiauKai", "DFKai-SB", "AR PL UKai CN", "Noto Serif CJK SC", "Songti SC", "SimSun", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --font-body: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei", system-ui, -apple-system, "Segoe UI", sans-serif;
  --u: clamp(0.55px, calc(0.4px + min(0.03125vw, 0.0556vh)), 1.3px);
  --grain: none;
  position: fixed;
  inset: 0;
  overflow: hidden;
  font-family: var(--font-body);
  font-size: clamp(14px, calc(0.5vw + 0.5vh + 5px), 18px);
  line-height: 1.45;
  color: var(--paper);
  background: var(--ink);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
}
.sg-root *, .sg-root *::before, .sg-root *::after { box-sizing: border-box; }
.sg-root input, .sg-root textarea { user-select: text; -webkit-user-select: text; }
:where(.sg-root) button { font: inherit; color: inherit; }
.sg-root :focus-visible { outline: 2px solid var(--gold-hi); outline-offset: 2px; }
.sg-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.sg-root ::-webkit-scrollbar-thumb { background: rgba(140, 106, 38, 0.6); border-radius: 4px; }
.sg-root ::-webkit-scrollbar-track { background: transparent; }
.sg-display { font-family: var(--font-display); }
.sg-layer { position: absolute; inset: 0; }
.sg-layer.pass { pointer-events: none; }
.sg-layer.pass > * { pointer-events: auto; }
.sg-hidden { display: none !important; }

/* ── panels ─────────────────────────────────────────────── */
.sg-panel {
  position: relative;
  color: var(--paper-ink);
  background-color: #e8d7ae;
  background-image: var(--grain), radial-gradient(ellipse at 50% 0%, rgba(255, 250, 230, 0.55), transparent 65%), linear-gradient(165deg, #f3e7cb 0%, #e6d3a8 55%, #d6bd8a 100%);
  border: 2px solid var(--gold-lo);
  border-radius: 6px;
  box-shadow: inset 0 0 0 3px #f6ecd2, inset 0 0 0 4px rgba(140, 106, 38, 0.55), inset 0 0 50px rgba(120, 80, 30, 0.28), 0 12px 34px rgba(0, 0, 0, 0.55);
}
.sg-dark {
  position: relative;
  color: var(--paper);
  background-color: #1d140d;
  background-image: var(--grain), linear-gradient(180deg, rgba(58, 40, 24, 0.95), rgba(24, 16, 10, 0.97));
  border: 1px solid var(--gold-lo);
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6), inset 0 0 0 3px rgba(214, 173, 82, 0.18), 0 10px 30px rgba(0, 0, 0, 0.5);
}
.sg-corners::before {
  --c: var(--gold);
  content: '';
  position: absolute;
  inset: 5px;
  pointer-events: none;
  background:
    linear-gradient(var(--c), var(--c)) top left / 16px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) top left / 2px 16px no-repeat,
    linear-gradient(var(--c), var(--c)) top right / 16px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) top right / 2px 16px no-repeat,
    linear-gradient(var(--c), var(--c)) bottom left / 16px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) bottom left / 2px 16px no-repeat,
    linear-gradient(var(--c), var(--c)) bottom right / 16px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) bottom right / 2px 16px no-repeat;
}
.sg-panel.sg-corners::before { --c: var(--gold-lo); }
.sg-h1, .sg-h2, .sg-h3 { font-family: var(--font-display); font-weight: 700; margin: 0; letter-spacing: 0.08em; line-height: 1.2; }
.sg-h1 { font-size: 2.2em; }
.sg-h2 { font-size: 1.5em; }
.sg-h3 { font-size: 1.15em; }
.sg-mute { opacity: 0.72; }
.sg-panel .sg-mute { color: var(--paper-mute); opacity: 1; }
.sg-divider { height: 1px; border: 0; margin: 0.8em 0; background: linear-gradient(90deg, transparent, var(--gold-lo), transparent); }
.sg-title-bar { display: flex; align-items: center; gap: 0.6em; }
.sg-title-bar::before, .sg-title-bar::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--gold), transparent); }

/* ── buttons ───────────────────────────────────────────── */
.sg-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4em;
  min-height: 2.4em;
  padding: 0.45em 1.4em;
  font-family: var(--font-display);
  font-size: 1.1em;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--gold-hi);
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
  background: linear-gradient(180deg, #b23a25 0%, #82200f 55%, #5e150b 100%);
  border: 1px solid #e3b75a;
  border-radius: 4px;
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.3), inset 0 2px 0 1px rgba(255, 220, 150, 0.22), 0 3px 8px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  transition: transform 0.12s ease, filter 0.12s ease, box-shadow 0.12s ease;
  white-space: nowrap;
}
.sg-btn:hover { filter: brightness(1.16); box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.3), inset 0 2px 0 1px rgba(255, 220, 150, 0.3), 0 0 14px rgba(245, 200, 110, 0.35), 0 3px 8px rgba(0, 0, 0, 0.45); }
.sg-btn:active { transform: translateY(1px) scale(0.99); }
.sg-btn:disabled { filter: grayscale(0.85) brightness(0.65); cursor: not-allowed; transform: none; }
.sg-btn.dark { background: linear-gradient(180deg, #4d3723 0%, #2e2014 60%, #22170e 100%); }
.sg-btn.gold { color: #3a220e; text-shadow: 0 1px 0 rgba(255, 244, 210, 0.7); background: linear-gradient(180deg, #f6d886 0%, #d3a646 55%, #a07a2a 100%); border-color: #fff0c0; }
.sg-btn.ghost { background: rgba(20, 14, 8, 0.35); border-color: rgba(214, 173, 82, 0.55); box-shadow: none; }
.sg-panel .sg-btn.ghost { color: var(--paper-ink); text-shadow: none; background: rgba(140, 106, 38, 0.1); border-color: var(--gold-lo); }
.sg-btn.small { font-size: 0.9em; min-height: 2em; padding: 0.25em 0.8em; letter-spacing: 0.06em; }
.sg-btn.big { font-size: 1.4em; padding: 0.45em 2em; }
.sg-btn.icon { padding: 0; width: 2.4em; min-width: 2.4em; letter-spacing: 0; }
.sg-btn.wide { width: 100%; }
.sg-link { background: none; border: 0; padding: 0; color: var(--gold-hi); text-decoration: underline dotted; cursor: pointer; font: inherit; }
.sg-panel .sg-link { color: var(--red); }
.sg-back {
  position: absolute; top: 0.9em; left: 0.9em; z-index: 5;
}

/* ── seals (印章) ──────────────────────────────────────── */
.sg-seal {
  --sz: 2.6em;
  --seal: var(--red);
  flex: none;
  display: inline-grid;
  place-items: center;
  width: var(--sz);
  height: var(--sz);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1em;
  line-height: 1;
  color: #fbeedd;
  background: radial-gradient(circle at 32% 28%, color-mix(in srgb, var(--seal) 88%, #fff 12%), color-mix(in srgb, var(--seal) 74%, #000 26%) 58%, color-mix(in srgb, var(--seal) 55%, #000 45%));
  border-radius: 16%;
  box-shadow: inset 0 0 0 calc(var(--sz) * 0.05) var(--seal), inset 0 0 0 calc(var(--sz) * 0.085) rgba(251, 238, 221, 0.85), 0 2px 6px rgba(0, 0, 0, 0.35);
  transform: rotate(-4deg);
}
.sg-seal > span { font-size: calc(var(--sz) * 0.6); text-shadow: 0 0 1px rgba(0, 0, 0, 0.3); }
.sg-seal.round { border-radius: 50%; }
.sg-seal.claim { background: rgba(255, 250, 235, 0.35); color: var(--seal); box-shadow: none; border: 1.5px dashed var(--seal); }
.sg-seal.claim > span { text-shadow: none; }

/* ── kingdom badge ─────────────────────────────────────── */
.sg-kd {
  --kc: var(--qun);
  --sz: 1.8em;
  flex: none;
  display: inline-grid;
  place-items: center;
  width: var(--sz);
  height: var(--sz);
  border-radius: 50%;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1em;
  color: #fff8e6;
  background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--kc) 65%, #fff 35%), var(--kc) 60%, color-mix(in srgb, var(--kc) 60%, #000 40%));
  box-shadow: 0 0 0 2px #e9c874, 0 0 0 3px rgba(0, 0, 0, 0.5), 0 2px 5px rgba(0, 0, 0, 0.5);
}
.sg-kd > span { font-size: calc(var(--sz) * 0.58); line-height: 1; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6); }

/* ── magatama (勾玉) ───────────────────────────────────── */
.sg-mags { display: inline-flex; gap: 0.08em; align-items: center; }
.sg-mag { width: 1em; height: 1em; flex: none; }
.sg-mag .body { fill: #3fbf5a; stroke: #0f3a18; stroke-width: 1.2; }
.sg-mag .hole { fill: #0f3a18; }
.sg-mag.lord .body { fill: #f0c14a; stroke: #5a3a08; }
.sg-mag.lord .hole { fill: #5a3a08; }
.sg-mag.empty .body { fill: #4a4038; stroke: #1a1510; }

/* ── form controls ─────────────────────────────────────── */
.sg-field { display: grid; grid-template-columns: minmax(8em, 34%) 1fr; align-items: center; gap: 0.5em 1em; padding: 0.55em 0; border-bottom: 1px dashed rgba(140, 106, 38, 0.35); }
.sg-field:last-child { border-bottom: 0; }
.sg-field > label, .sg-field > .sg-label { font-weight: 600; }
.sg-field .sg-hint { grid-column: 2; font-size: 0.85em; color: var(--paper-mute); margin-top: -0.2em; }
.sg-field > .sg-seg, .sg-field > .sg-switch { justify-self: start; max-width: 100%; }
.sg-input {
  width: 100%;
  min-height: 2.3em;
  padding: 0.35em 0.7em;
  font: inherit;
  color: var(--paper-ink);
  background: rgba(255, 250, 235, 0.75);
  border: 1px solid var(--gold-lo);
  border-radius: 4px;
  box-shadow: inset 0 1px 3px rgba(80, 50, 20, 0.25);
  outline: none;
}
.sg-input:focus { border-color: var(--red); box-shadow: inset 0 1px 3px rgba(80, 50, 20, 0.25), 0 0 0 2px rgba(179, 38, 30, 0.25); }
.sg-dark .sg-input, .sg-input.dark { color: var(--paper); background: rgba(0, 0, 0, 0.4); border-color: rgba(214, 173, 82, 0.55); }
.sg-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--gold-lo); border-radius: 4px; overflow: hidden; }
.sg-seg > button {
  min-height: 2.2em;
  padding: 0.3em 0.9em;
  border: 0;
  border-right: 1px solid rgba(140, 106, 38, 0.5);
  background: rgba(255, 250, 235, 0.35);
  color: var(--paper-ink);
  cursor: pointer;
  font-weight: 600;
}
.sg-seg > button:last-child { border-right: 0; }
.sg-seg > button[aria-pressed="true"] { background: linear-gradient(180deg, #b23a25, #7c1d10); color: var(--gold-hi); text-shadow: 0 1px 0 #000; }
.sg-dark .sg-seg > button { background: rgba(0, 0, 0, 0.3); color: var(--paper); }
.sg-dark .sg-seg > button[aria-pressed="true"] { background: linear-gradient(180deg, #b23a25, #7c1d10); color: var(--gold-hi); }
.sg-range { display: flex; align-items: center; gap: 0.8em; }
.sg-range output { min-width: 3.4em; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.sg-range input[type="range"] { flex: 1; appearance: none; -webkit-appearance: none; height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--red) 0 var(--p, 50%), rgba(90, 60, 30, 0.35) var(--p, 50%) 100%); outline: none; }
.sg-range input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff0c0, #d6ad52 60%, #8c6a26); border: 1px solid #5a3a10; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
.sg-range input[type="range"]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #d6ad52; border: 1px solid #5a3a10; cursor: pointer; }
.sg-switch { position: relative; width: 3.2em; height: 1.7em; flex: none; border-radius: 1em; border: 1px solid var(--gold-lo); background: rgba(90, 60, 30, 0.35); cursor: pointer; transition: background 0.15s; }
.sg-switch::after { content: ''; position: absolute; top: 0.15em; left: 0.15em; width: 1.3em; height: 1.3em; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff5dc, #d8c49a); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); transition: transform 0.15s; }
.sg-switch[aria-checked="true"] { background: linear-gradient(180deg, #b23a25, #7c1d10); }
.sg-switch[aria-checked="true"]::after { transform: translateX(1.5em); }

/* ── tabs ──────────────────────────────────────────────── */
.sg-tabs { display: flex; gap: 0.3em; flex-wrap: wrap; }
.sg-tab {
  padding: 0.35em 1em;
  font-family: var(--font-display);
  font-size: 1.05em;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--paper);
  background: rgba(20, 14, 8, 0.45);
  border: 1px solid rgba(214, 173, 82, 0.4);
  border-radius: 4px 4px 0 0;
  cursor: pointer;
}
.sg-tab[aria-selected="true"] { color: var(--gold-hi); background: linear-gradient(180deg, #8e2616, #5c160c); border-color: var(--gold); }
.sg-panel .sg-tab { color: var(--paper-ink); background: rgba(140, 106, 38, 0.12); border-color: rgba(140, 106, 38, 0.5); }
.sg-panel .sg-tab[aria-selected="true"] { color: var(--gold-hi); background: linear-gradient(180deg, #a52d1b, #6e1a0e); }

/* ── hero card ─────────────────────────────────────────── */
.sg-hcard {
  --kc: var(--qun);
  position: relative;
  aspect-ratio: 5 / 7;
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: linear-gradient(160deg, color-mix(in srgb, var(--kc) 55%, #fff 10%), color-mix(in srgb, var(--kc) 70%, #000 30%));
  box-shadow: 0 0 0 2px #e6c26e, 0 0 0 4px color-mix(in srgb, var(--kc) 75%, #000 25%), 0 8px 18px rgba(0, 0, 0, 0.55);
  color: #fff8e6;
  isolation: isolate;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s;
  /* the name below scales to the card width (Huang Yueying / Sun Shangxiang on compact cards) */
  container-type: inline-size;
}
.sg-hcard:hover { transform: translateY(-3px); }
.sg-hcard.selected { box-shadow: 0 0 0 2px #fff4c8, 0 0 0 5px var(--gold), 0 0 26px rgba(245, 210, 120, 0.75), 0 10px 22px rgba(0, 0, 0, 0.6); transform: translateY(-4px); }
.sg-hcard.disabled { filter: grayscale(0.95) brightness(0.55); cursor: not-allowed; transform: none; }
.sg-hcard .portrait { position: absolute; inset: 0; z-index: 0; }
.sg-hcard .portrait .ph {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  font-family: var(--font-display);
  font-size: 4.2em;
  font-weight: 700;
  color: rgba(255, 245, 220, 0.2);
  background: radial-gradient(ellipse at 50% 35%, rgba(255, 240, 200, 0.35), transparent 60%), radial-gradient(ellipse at 50% 110%, rgba(0, 0, 0, 0.55), transparent 60%);
}
.sg-hcard .portrait img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sg-hcard .shade { position: absolute; inset: 0; z-index: 1; background: linear-gradient(180deg, rgba(0, 0, 0, 0.35) 0%, transparent 22%, transparent 55%, rgba(0, 0, 0, 0.82) 100%); pointer-events: none; }
.sg-hcard .top { position: absolute; z-index: 2; top: 0.35em; left: 0.35em; right: 0.35em; display: flex; align-items: center; gap: 0.3em; }
.sg-hcard .top .sg-kd { --sz: 1.7em; }
.sg-hcard .top .sg-mags { font-size: 0.95em; }
.sg-hcard .crown { position: absolute; z-index: 2; top: 2.05em; right: 0.45em; font-size: 1.05em; color: #f2c14e; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0, 0, 0, 0.6); }
.sg-hcard .vname {
  position: absolute; z-index: 2; left: 0.3em; top: 1.75em;
  display: flex;
  flex-direction: column;
  align-items: center;
  font-family: var(--font-display);
  font-size: 1.55em;
  font-weight: 700;
  line-height: 1.08;
  color: #fff6dc;
  text-shadow: 0 0 3px #000, 0 0 6px #000, 1px 1px 0 color-mix(in srgb, var(--kc) 70%, #000 30%);
}
.sg-hcard .bottom { position: absolute; z-index: 2; left: 0; right: 0; bottom: 0; padding: 0.4em 0.5em 0.45em; text-align: center; }
.sg-hcard .bottom .nm { font-family: var(--font-display); font-size: min(1.1em, calc(88cqi / var(--nl, 3) / 1.1)); font-weight: 700; letter-spacing: 0.06em; text-shadow: 0 1px 2px #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-root[data-lang="en"] .sg-hcard .bottom .nm { letter-spacing: 0.01em; }
.sg-hcard .bottom .ttl { font-size: 0.72em; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-hcard .tag { position: absolute; z-index: 3; left: 50%; top: 45%; transform: translate(-50%, -50%) rotate(-10deg); }
.sg-hcard .vname i { font-style: normal; display: block; }
.sg-hcard.compact .vname { font-size: 1.2em; top: 1.9em; }
.sg-hcard.compact .bottom .ttl { display: none; }

/* ── toasts / modal ────────────────────────────────────── */
.sg-toasts { position: absolute; top: 1em; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 0.5em; z-index: 60; pointer-events: none; width: min(92vw, 34em); }
.sg-toast { pointer-events: auto; padding: 0.6em 1.2em; max-width: 100%; text-align: center; animation: sg-toast-in 0.25s ease-out; }
.sg-toast.error { border-color: var(--red-hi); }
.sg-toast.out { animation: sg-toast-out 0.3s ease-in forwards; }
@keyframes sg-toast-in { from { opacity: 0; transform: translateY(-10px); } }
@keyframes sg-toast-out { to { opacity: 0; transform: translateY(-10px); } }
.sg-modal-back { position: absolute; inset: 0; z-index: 50; display: grid; place-items: center; padding: 1em; background: rgba(8, 5, 3, 0.62); backdrop-filter: blur(2px); animation: sg-fade 0.18s ease-out; }
.sg-modal { width: min(30em, 100%); max-height: calc(100% - 1em); overflow: auto; padding: 1.4em 1.6em; animation: sg-pop 0.2s ease-out; }
.sg-modal .actions { display: flex; justify-content: flex-end; gap: 0.6em; margin-top: 1.2em; flex-wrap: wrap; }
@keyframes sg-fade { from { opacity: 0; } }
@keyframes sg-pop { from { opacity: 0; transform: scale(0.96); } }
.sg-spinner { width: 1.2em; height: 1.2em; border-radius: 50%; border: 2px solid rgba(214, 173, 82, 0.3); border-top-color: var(--gold-hi); animation: sg-spin 0.9s linear infinite; display: inline-block; vertical-align: middle; }
@keyframes sg-spin { to { transform: rotate(360deg); } }

.sg-table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
.sg-table th, .sg-table td { padding: 0.45em 0.6em; text-align: left; vertical-align: middle; border-bottom: 1px solid rgba(140, 106, 38, 0.3); }
.sg-table th { font-family: var(--font-display); font-weight: 700; letter-spacing: 0.06em; color: var(--red-lo); border-bottom: 2px solid var(--gold-lo); white-space: nowrap; }
.sg-dark .sg-table th { color: var(--gold-hi); }
.sg-table td.num, .sg-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sg-table-wrap { overflow-x: auto; max-width: 100%; }
.sg-chip { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.05em 0.55em; border-radius: 999px; font-size: 0.85em; font-weight: 600; border: 1px solid currentColor; white-space: nowrap; }
.sg-key { display: inline-grid; place-items: center; min-width: 1.6em; height: 1.6em; padding: 0 0.35em; border-radius: 3px; font-family: var(--font-body); font-size: 0.8em; font-weight: 700; color: var(--paper-ink); background: linear-gradient(#fff6e0, #d9c79d); border: 1px solid #7a5a22; box-shadow: 0 2px 0 #7a5a22; white-space: nowrap; }

/* Latin text needs far less tracking than CJK */
.sg-root[data-lang="en"] .sg-btn { letter-spacing: 0.04em; }
.sg-root[data-lang="en"] :is(.sg-h1, .sg-h2, .sg-h3, .sg-tab) { letter-spacing: 0.02em; }
.sg-root[data-lang="en"] :is(.ob-title, .sg-tagline, .rname) { letter-spacing: 0.08em; }

@media (prefers-reduced-motion: reduce) {
  .sg-root *, .sg-root *::before, .sg-root *::after { animation-duration: 0.001s !important; animation-iteration-count: 1 !important; transition-duration: 0.001s !important; }
}
`;
