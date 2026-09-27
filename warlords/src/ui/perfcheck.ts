// Graphics diagnostics for the player: the GPU's display name, and the "your
// browser is not using the graphics card" warning shown on the title screen and
// in the HUD when WebGL runs on a software renderer (hardware acceleration off or
// the GPU blocklisted — every frame is slow however strong the machine is).
import { isSoftwareGpu, type Quality } from '../game/settings';
import type { PerfInfo } from './app';
import { desktopInfo } from './desktop';
import { h } from './dom';
import { hasKey, t, tx } from './i18n';

/** Where the desktop app (Windows / macOS / Linux) is downloaded. */
export const RELEASES_URL = 'https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest';

const SOFTWARE_NAMES: readonly [RegExp, string][] = [
  [/swiftshader/i, 'SwiftShader'],
  [/llvmpipe/i, 'llvmpipe'],
  [/lavapipe/i, 'lavapipe'],
  [/softpipe/i, 'softpipe'],
  [/basic render/i, 'Microsoft Basic Render Driver'],
  [/gdi generic/i, 'GDI Generic'],
];

/** Split on the commas outside parentheses ("A, B (x, y), C" → A | B (x, y) | C). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * The GPU's name from a WebGL renderer string, without ANGLE's wrapping and the
 * driver details: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11
 * vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 5090"; a software renderer by its
 * own name ("SwiftShader"). '' stays ''.
 */
export function gpuShortName(renderer: string): string {
  const raw = renderer.trim();
  if (!raw) return '';
  if (isSoftwareGpu(raw)) for (const [re, name] of SOFTWARE_NAMES) if (re.test(raw)) return name;
  let r = raw;
  const angle = /^ANGLE \((.*)\)$/s.exec(r);
  if (angle) {
    const parts = splitTop(angle[1]);
    r = parts[1] || parts[0] || r;
  }
  r = r
    .replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D\d*|vs_\d_\d|ps_\d_\d|OpenGL|Vulkan)\b.*$/i, '')
    .replace(/\s*\/(PCIe|SSE2).*$/i, '')
    .trim();
  return r || raw;
}

// ── "not using the GPU" warning ──────────────────────────────────────────────

const WARN_OFF_KEY = 'sgwl.gpuWarn.off';
let warnOff: string | null = null;

/** The player closed the warning for this renderer (this tab: it comes back on the next visit, the problem is real). */
export function gpuWarnDismissed(renderer: string): boolean {
  if (warnOff === renderer) return true;
  try {
    return globalThis.sessionStorage?.getItem(WARN_OFF_KEY) === renderer;
  } catch {
    return false;
  }
}

export function dismissGpuWarn(renderer: string): void {
  warnOff = renderer;
  try {
    globalThis.sessionStorage?.setItem(WARN_OFF_KEY, renderer);
  } catch {
    /* storage blocked: this page only */
  }
}

/** The warning's text (the same on the title and in the HUD). */
export function gpuWarnText(renderer: string): { head: string; fix: string } {
  const name = gpuShortName(renderer) || tx('未知', 'unknown');
  return {
    head: tx(`浏览器没有使用显卡（当前：${name}），游戏会非常卡。`, `Your browser is not using the graphics card (now: ${name}), so the game will be very slow.`),
    fix: tx(
      'Chrome/Edge：设置 → 系统 → 打开「使用图形加速功能（硬件加速）」→ 重启浏览器。',
      'Chrome / Edge: Settings → System → turn on “Use graphics acceleration when available” → restart the browser.',
    ),
  };
}

/**
 * The dismissible warning box. `where`: the title screen (a strip over the top) or
 * the HUD (under the role chip). The web version also points at the desktop app,
 * which turns the GPU on by itself.
 */
export function gpuWarning(where: 'title' | 'hud', renderer: string, onClose: () => void): HTMLElement {
  const text = gpuWarnText(renderer);
  const close = h('button', { class: 'x', type: 'button', title: tx('关闭', 'Close'), aria: { label: tx('关闭', 'Close') } }, '✕');
  close.addEventListener('click', (ev) => {
    ev.stopPropagation();
    dismissGpuWarn(renderer);
    onClose();
  });
  return h('div', { class: `sg-gpu-warn ${where}`, role: 'alert', data: { gpu: renderer } },
    close,
    h('b', null, '⚠ ', text.head),
    h('p', null, text.fix),
    desktopInfo() ? null : externalLink(RELEASES_URL, tx('或下载桌面版（自动启用显卡）', 'Or get the desktop app (turns the GPU on by itself)'), 'dl'),
  );
}

/** A link that opens in a new tab / the system browser (desktop app). */
export function externalLink(href: string, label: string, cls = ''): HTMLAnchorElement {
  const a = h('a', { class: cls, href }, label);
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

// ── F3 performance panel ─────────────────────────────────────────────────────

/** The tier's name as the settings show it (流畅 / 均衡 / 精美…). */
export function qualityName(q: Quality): string {
  const key = `settings.quality.${q}`;
  return hasKey(key) ? t(key) : q;
}

function triangles(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * The F3 panel's lines — made to be screenshotted and sent to us: frame rate and
 * time, main-thread (JS) time, draw calls, triangles, render scale, tier, GPU.
 * Without the 3D view's numbers (harness / not built yet): the HUD's own frame rate.
 */
export function perfLines(p: PerfInfo | null, hud: { fps: number; ms: number }, gpu: string): string[] {
  const out: string[] = [];
  if (p) {
    out.push(`${Math.round(p.fps)} FPS · ${p.frameMs.toFixed(1)} ms · JS ${p.jsMs.toFixed(1)} ms`);
    const range = p.pixelRatioMax - p.pixelRatioMin > 0.01 ? ` (${p.pixelRatioMin.toFixed(2)}–${p.pixelRatioMax.toFixed(2)})` : '';
    out.push(`${p.drawCalls} DC · ${triangles(p.triangles)} △ · ${tx('渲染', 'scale')} ${p.pixelRatio.toFixed(2)}×${range} · ${qualityName(p.quality)}${p.applying ? '…' : ''}`);
  } else {
    out.push(`${Math.round(hud.fps)} FPS · ${hud.ms.toFixed(1)} ms`);
  }
  out.push(`GPU ${gpu || tx('未知', 'unknown')}`);
  return out;
}
