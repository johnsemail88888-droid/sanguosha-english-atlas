// Graphics diagnostics: the "browser is not using the graphics card" warning
// (title strip / HUD box), the HUD's top-left diagnostics column, the F3
// performance panel and 性能体检. HUD sizes use the --u unit like styles/hud.ts.
const u = (n: number): string => `calc(var(--u) * ${n})`;

export const PERF_CSS = /* css */ `
/* ── software-renderer warning ─────────────────────────── */
.sg-gpu-warn { position: relative; box-sizing: border-box; padding: 0.55em 2.3em 0.65em 0.95em; border: 1px solid rgba(240, 150, 60, 0.9); border-left-width: 4px; border-radius: 4px; background: rgba(40, 18, 6, 0.94); color: #f6e7c8; font-size: 0.86em; line-height: 1.45; text-align: left; text-shadow: none; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); pointer-events: auto; }
.sg-gpu-warn b { display: block; color: #ffb27e; font-weight: 800; }
.sg-gpu-warn p { margin: 0.2em 0 0; }
.sg-gpu-warn .dl { display: inline-block; margin-top: 0.3em; color: var(--gold-hi, #f5dc98); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
.sg-gpu-warn .x { position: absolute; top: 0.25em; right: 0.3em; width: 1.8em; height: 1.8em; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: #f6e7c8; font: inherit; font-size: 0.95em; cursor: pointer; }
.sg-gpu-warn .x:hover { background: rgba(255, 255, 255, 0.12); }
/* title: a strip over the top, clear of the language button */
.sg-gpu-warn.title { position: absolute; z-index: 4; top: 0.8em; left: 50%; transform: translateX(-50%); width: min(40em, calc(100% - 11em)); }
/* landscape phones: a narrow box in the top-left corner (the menu stays clear) */
@media (max-height: 520px) {
  .sg-gpu-warn.title { top: 0.4em; left: 0.5em; transform: none; width: min(24em, 36vw); font-size: 0.68em; }
}

/* ── settings → 画面: 显卡 line ───────────────────────────── */
.set-gpu { margin: 0.6em 0 0.2em; padding: 0.5em 0.7em; border-radius: 4px; background: rgba(140, 106, 38, 0.1); border: 1px solid rgba(140, 106, 38, 0.35); font-size: 0.9em; line-height: 1.45; }
.set-gpu .lbl { opacity: 0.8; }
.set-gpu.soft { border-color: rgba(200, 70, 40, 0.8); background: rgba(200, 70, 40, 0.1); }
.set-gpu .warn { color: #b8321e; font-weight: 700; }
.set-gpu code { display: block; margin-top: 0.2em; font: 0.8em/1.35 ui-monospace, Menlo, Consolas, monospace; opacity: 0.7; overflow-wrap: anywhere; }
.set-gpu .pc-open { float: right; margin: -0.1em 0 0.3em 0.6em; }

/* ── 设置 → 画质: 自动（当前：…）over the five tiers ─────────── */
.set-quality { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35em; min-width: 0; }
.set-quality .q-auto { min-height: 2.2em; padding: 0.3em 0.9em; border: 1px solid var(--gold-lo); border-radius: 4px; background: rgba(255, 250, 235, 0.35); color: var(--paper-ink); font: inherit; font-weight: 700; cursor: pointer; }
.set-quality .q-auto[aria-pressed="true"] { background: linear-gradient(180deg, #b23a25, #7c1d10); color: var(--gold-hi); text-shadow: 0 1px 0 #000; cursor: default; }
/* on 自动 the tier in use is marked, not chosen */
.set-quality .sg-seg.auto > button[aria-pressed="true"] { background: rgba(178, 58, 37, 0.16); color: #7c1d10; text-shadow: none; box-shadow: inset 0 -3px 0 #b23a25; }

/* ── title: 下载桌面版 (web, computers) ─────────────────── */
.sg-dl-link { color: var(--gold-hi, #f5dc98); text-decoration: underline; text-underline-offset: 2px; opacity: 0.9; }
.sg-dl-link:hover { opacity: 1; }
@media (pointer: coarse) { .sg-dl-link { display: none; } }

/* ── 性能体检 ────────────────────────────────────────────── */
.sg-perfcheck { width: min(46em, 100%); display: flex; flex-direction: column; gap: 0.5em; padding: 0.9em 1.3em 1em; font-size: 0.95em; }
.sg-perfcheck .set-head { margin-bottom: 0; }
.sg-perfcheck .set-head { display: flex; align-items: center; justify-content: space-between; }
.pc-verdict { display: flex; align-items: center; gap: 0.5em; padding: 0.5em 0.85em; border-radius: 5px; font-size: 1.05em; font-weight: 800; line-height: 1.4; border: 1px solid; }
.pc-verdict.ok { background: rgba(46, 125, 72, 0.14); border-color: rgba(46, 125, 72, 0.6); color: #1f5a33; }
.pc-verdict:is(.software, .slow, .nowebgl) { background: rgba(200, 70, 40, 0.12); border-color: rgba(200, 70, 40, 0.7); color: #9a2a16; }
.pc-facts { display: grid; gap: 0.1em; font-size: 0.88em; }
.pc-facts .k { display: inline-block; min-width: 4.2em; margin-right: 0.5em; opacity: 0.7; }
.pc-facts .raw { font: 0.8em/1.35 ui-monospace, Menlo, Consolas, monospace; opacity: 0.65; overflow-wrap: anywhere; }
.pc-sec { padding: 0.45em 0.8em 0.55em; border-radius: 5px; background: rgba(140, 106, 38, 0.08); border: 1px solid rgba(140, 106, 38, 0.3); }
.pc-sec .sg-h3 { margin: 0 0 0.25em; font-size: 1.02em; }
.pc-steps { margin: 0; padding-left: 1.5em; display: grid; gap: 0.2em; line-height: 1.4; }
.pc-steps li::marker { font-weight: 800; color: var(--red, #b3261e); }
.pc-url { display: flex; flex-wrap: wrap; align-items: center; gap: 0.2em 0.6em; margin-top: 0.2em; }
.pc-url code { font: 0.85em ui-monospace, Menlo, Consolas, monospace; padding: 0.1em 0.4em; border-radius: 3px; background: rgba(0, 0, 0, 0.06); }
.pc-url small { opacity: 0.75; }
.pc-note { margin: 0.35em 0 0; font-size: 0.88em; opacity: 0.85; }
.pc-sec.dl { display: flex; flex-direction: column; align-items: stretch; gap: 0.35em; background: none; border: 0; padding: 0; }
.pc-dl { justify-content: center; text-align: center; text-decoration: none; min-height: 2.5em; font-size: 1.05em; }
.pc-file { font-size: 0.82em; text-align: center; opacity: 0.8; }
.pc-file code { font: 0.95em ui-monospace, Menlo, Consolas, monospace; }
.sg-perfcheck .set-foot { display: flex; justify-content: space-between; gap: 0.6em; margin-top: 0.1em; padding-top: 0.6em; }

/* ── HUD: top-left column under the role chip ──────────── */
.hud-diag { position: absolute; left: ${u(16)}; top: calc(${u(16)} + ${u(96)}); display: flex; flex-direction: column; align-items: flex-start; gap: ${u(8)}; max-width: min(${u(460)}, 40vw); z-index: 9; pointer-events: none; }
.hud-diag .sg-gpu-warn { font-size: max(11px, calc(var(--u) * 13)); }
/* phones: a small frame-rate counter under the clock (the corners hold the touch buttons, the role chip and the minimap) */
.sg-hud.touch .hud-diag { top: calc(${u(16)} + 50px); left: 50%; transform: translateX(-50%); align-items: center; max-width: 60vw; }
.sg-hud.touch .hud-perf .rows > :not(:first-child), .sg-hud.touch .hud-perf .pc-open { display: none; }
.sg-hud.touch .hud-perf { background: rgba(0, 0, 0, 0.45); padding: 1px 6px; }
/* phones never render in software; the title screen still says it */
.sg-hud.touch .hud-diag .sg-gpu-warn { display: none; }
.sg-hud:is([data-overlay="pause"], [data-overlay="controls"]) .hud-diag { z-index: 30; }
.hud-perf { padding: 3px 7px 4px; border-radius: 3px; background: rgba(0, 0, 0, 0.62); color: #c4f2bd; font: 11px/1.4 ui-monospace, Menlo, Consolas, "Courier New", monospace; font-variant-numeric: tabular-nums; text-shadow: none; white-space: nowrap; pointer-events: none; }
.hud-perf .gpu { white-space: normal; overflow-wrap: anywhere; color: #9fd0f0; max-width: 34em; }
.hud-perf .pc-open { margin-top: 3px; pointer-events: auto; font-size: 11px; min-height: 0; padding: 2px 8px; }
`;
