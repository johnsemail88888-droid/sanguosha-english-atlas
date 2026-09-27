// Graphics diagnostics: the "browser is not using the graphics card" warning
// (title strip / HUD box), the HUD's top-left diagnostics column and the F3
// performance panel. HUD sizes use the --u unit like styles/hud.ts.
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

/* ── HUD: top-left column under the role chip ──────────── */
.hud-diag { position: absolute; left: ${u(16)}; top: calc(${u(16)} + ${u(96)}); display: flex; flex-direction: column; align-items: flex-start; gap: ${u(8)}; max-width: min(${u(460)}, 40vw); z-index: 9; pointer-events: none; }
.hud-diag .sg-gpu-warn { font-size: max(11px, calc(var(--u) * 13)); }
.sg-hud.touch .hud-diag { top: 2px; left: 2px; max-width: 46vw; z-index: 30; }
/* phones never render in software; the title screen still says it */
.sg-hud.touch .hud-diag .sg-gpu-warn { display: none; }
.sg-hud:is([data-overlay="pause"], [data-overlay="controls"]) .hud-diag { z-index: 30; }
.hud-perf { padding: 3px 7px 4px; border-radius: 3px; background: rgba(0, 0, 0, 0.62); color: #c4f2bd; font: 11px/1.4 ui-monospace, Menlo, Consolas, "Courier New", monospace; font-variant-numeric: tabular-nums; text-shadow: none; white-space: nowrap; pointer-events: none; }
.hud-perf .gpu { white-space: normal; overflow-wrap: anywhere; color: #9fd0f0; max-width: 34em; }
`;
