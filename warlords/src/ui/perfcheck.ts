// Graphics diagnostics for the player: the GPU's display name, the "your browser
// is not using the graphics card" warning shown on the title screen and in the
// HUD when WebGL runs on a software renderer (hardware acceleration off or the GPU
// blocklisted — every frame is slow however strong the machine is), the F3 panel's
// lines, and the logic behind 性能体检 (screens/perfCheck.ts): which browser / OS
// this is, how to turn its GPU on, which desktop build to download, the verdict.
import { classifyGpu, isSoftwareGpu, type GpuClass, type Quality } from '../game/settings';
import type { AutoTunePick } from '../render/adaptiveRes';
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

/** The warning's text (the same on the title and in the HUD; the desktop app: its own fix). */
export function gpuWarnText(renderer: string): { head: string; fix: string } {
  const name = gpuShortName(renderer) || tx('未知', 'unknown');
  return {
    head: tx(`浏览器没有使用显卡（当前：${name}），游戏会非常卡。`, `Your browser is not using the graphics card (now: ${name}), so the game will be very slow.`),
    fix: desktopInfo()
      ? tx('桌面版：从显卡官网（NVIDIA / AMD / Intel）更新显卡驱动，重启电脑后再打开游戏。', 'Desktop app: update the graphics driver (NVIDIA / AMD / Intel), restart the computer and open the game again.')
      : tx(
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

/** The tier's name as the settings show it (极速 / 流畅 / 均衡 / 高清 / 极致). */
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

// ── 性能体检: browser / OS, fixes, download, verdict ──────────────────────────

export type BrowserId = 'chrome' | 'edge' | 'opera' | 'firefox' | 'safari' | 'desktop' | 'other';
export type OsId = 'windows' | 'mac' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other';

/** Which browser a user agent is ('desktop': our Electron app). */
export function detectBrowser(ua: string): BrowserId {
  if (/\bElectron\//i.test(ua)) return 'desktop';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'opera';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'firefox';
  if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)) return 'chrome';
  if (/\bSafari\//.test(ua)) return 'safari';
  return 'other';
}

/** Which OS a user agent is (`touchPoints` > 1 on a "Mac": an iPad asking for the desktop site). */
export function detectOs(ua: string, touchPoints = 0): OsId {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/\bCrOS\b/.test(ua)) return 'chromeos';
  if (/Macintosh|Mac OS X/i.test(ua)) return touchPoints > 1 ? 'ios' : 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

/** The desktop app exists for this OS. */
export function isDesktopOs(os: OsId): boolean {
  return os === 'windows' || os === 'mac' || os === 'linux';
}

/** This page's browser / OS / whether it runs inside our desktop app. */
export function platformInfo(nav: { userAgent?: string; maxTouchPoints?: number } | undefined = globalThis.navigator): { browser: BrowserId; os: OsId; desktopApp: boolean } {
  const ua = nav?.userAgent ?? '';
  const browser = detectBrowser(ua);
  return { browser, os: detectOs(ua, nav?.maxTouchPoints ?? 0), desktopApp: browser === 'desktop' || !!desktopInfo() };
}

/** How to turn the GPU on: a settings address to copy (web pages cannot open chrome:// links) and the steps. */
export interface GpuFix {
  /** the browser's name as the guide says it */
  name: string;
  /** settings page to paste into the address bar (null: none) */
  url: string | null;
  steps: string[];
}

export function softwareFix(b: BrowserId): GpuFix {
  switch (b) {
    case 'chrome':
    case 'edge':
    case 'opera': {
      const name = b === 'edge' ? 'Edge' : b === 'opera' ? 'Opera' : 'Chrome';
      const url = `${b}://settings/system`;
      const toggle = b === 'edge' ? tx('在可用时使用图形加速', 'Use graphics acceleration when available') : b === 'opera' ? tx('可用时使用硬件加速', 'Use hardware acceleration when available') : tx('使用图形加速功能（如果可用）', 'Use graphics acceleration when available');
      return {
        name,
        url,
        steps: [
          tx('点「复制设置地址」，粘贴到浏览器地址栏后回车', 'Click “Copy settings address”, paste it into the address bar and press Enter'),
          tx(`打开「${toggle}」`, `Turn on “${toggle}”`),
          tx('点旁边出现的「重新启动」', 'Click the “Relaunch” button that appears'),
        ],
      };
    }
    case 'firefox':
      return {
        name: 'Firefox',
        url: 'about:preferences#general',
        steps: [
          tx('点「复制设置地址」，粘贴到地址栏后回车，找到「性能」', 'Click “Copy settings address”, paste it into the address bar, press Enter and find “Performance”'),
          tx('取消「使用推荐的性能设置」，勾选「自动启用硬件加速」', 'Untick “Use recommended performance settings”, tick “Use hardware acceleration when available”'),
          tx('重启 Firefox', 'Restart Firefox'),
        ],
      };
    case 'desktop':
      return {
        name: tx('桌面版', 'desktop app'),
        url: null,
        steps: [
          tx('从显卡官网（NVIDIA / AMD / Intel）更新显卡驱动', 'Update the graphics driver from NVIDIA / AMD / Intel'),
          tx('重启电脑', 'Restart the computer'),
          tx('重新打开游戏', 'Open the game again'),
        ],
      };
    default:
      return {
        name: b === 'safari' ? 'Safari' : tx('浏览器', 'browser'),
        url: null,
        steps: [
          tx('在浏览器设置里开启「硬件加速」', 'Turn on “hardware acceleration” in the browser settings'),
          tx('重启浏览器', 'Restart the browser'),
          tx('仍不行：改用最新版 Chrome / Edge，或下载桌面版', 'Still slow: use the latest Chrome / Edge, or the desktop app'),
        ],
      };
  }
}

/** Windows: where a laptop's app is moved to its discrete GPU (Win+R → paste → Enter). */
export const WINDOWS_GRAPHICS_URL = 'ms-settings:display-advancedgraphics';

/**
 * A Windows machine on an integrated GPU (Intel UHD / Iris, a Radeon APU): if the
 * laptop also has a card, Windows can run the browser (or the desktop app) on it.
 */
export function integratedTip(os: OsId, gpu: string, desktopApp: boolean): string[] | null {
  if (os !== 'windows' || classifyGpu(gpu) !== 'integrated') return null;
  const app = desktopApp ? 'SanguoWarlords' : tx('你的浏览器', 'your browser');
  return [
    tx('Windows 设置 → 系统 → 屏幕 → 显示卡（图形）', 'Windows Settings → System → Display → Graphics'),
    tx(`选中${app}（找不到就点「浏览」添加），点「选项」`, `Pick ${app} (or add it with “Browse”) and click “Options”`),
    tx('选「高性能」并保存，然后重启它', 'Choose “High performance”, save, then restart it'),
  ];
}

/** The desktop build for this OS (null: no desktop app for it). Windows: the portable one (no install). */
export function desktopDownload(os: OsId, gpuClass: GpuClass): { os: string; file: string } | null {
  if (os === 'windows') return { os: 'Windows', file: 'SanguoWarlords-…-Windows-portable.exe' };
  // Apple silicon reports an "Apple M…" / "Apple GPU" renderer; Intel Macs an Intel / AMD one
  if (os === 'mac') return { os: 'macOS', file: `SanguoWarlords-…-macOS-${gpuClass === 'apple' ? 'arm64' : 'x64'}.dmg` };
  if (os === 'linux') return { os: 'Linux', file: 'SanguoWarlords-…-Linux.AppImage' };
  return null;
}

/** Below this estimated frame rate the machine is flagged 帧率偏低. */
export const SLOW_FPS = 40;

export type VerdictKind = 'ok' | 'software' | 'slow' | 'nowebgl';

export interface Verdict {
  kind: VerdictKind;
  /** the GPU's display name ('' unknown) */
  gpu: string;
  /** estimated frame rate of the best fit (null: not benchmarked) */
  fps: number | null;
  /** the best fit's tier (null: not benchmarked) */
  tier: Quality | null;
  /** 帧率偏低: the estimated frame rate on 流畅 (null otherwise) */
  lowFps: number | null;
}

/**
 * 性能体检's verdict: no WebGL 2 / not using the GPU / slow (the benchmark says even
 * 流畅 is too heavy — the best fit is 极速 — or the frame rate stays low) / fine.
 */
export function perfVerdict(i: { webgl2: boolean; renderer: string; pick: AutoTunePick | null; lowFps?: number | null }): Verdict {
  const gpu = gpuShortName(i.renderer);
  const fps = i.pick?.fps ?? null;
  const tier = i.pick?.quality ?? null;
  if (!i.webgl2) return { kind: 'nowebgl', gpu, fps: null, tier: null, lowFps: null };
  if (isSoftwareGpu(i.renderer)) return { kind: 'software', gpu, fps, tier, lowFps: null };
  if (fps !== null && (tier === 'potato' || fps < SLOW_FPS)) return { kind: 'slow', gpu, fps, tier, lowFps: i.lowFps ?? null };
  return { kind: 'ok', gpu, fps, tier, lowFps: null };
}

const fpsText = (n: number): string => (n > 240 ? '240+' : String(n));

/** The verdict line: ✅ 显卡已启用：X，预计帧率 N / ⚠ 浏览器没用上显卡 / ⚠ 帧率偏低. */
export function verdictText(v: Verdict): string {
  const gpu = v.gpu || tx('未知显卡', 'unknown GPU');
  switch (v.kind) {
    case 'nowebgl':
      return tx('⚠ 浏览器不支持 WebGL 2，无法显示 3D 画面', '⚠ This browser has no WebGL 2: the 3D view cannot run');
    case 'software':
      return tx(`⚠ 浏览器没用上显卡（当前：${gpu}），游戏会非常卡`, `⚠ The browser is not using the graphics card (now: ${gpu}): the game will be very slow`);
    case 'slow': {
      const tier = v.tier ? qualityName(v.tier) : '';
      const low = v.lowFps !== null ? tx(`「${qualityName('low')}」约 ${fpsText(v.lowFps)} 帧，`, `“${qualityName('low')}” about ${fpsText(v.lowFps)} fps, `) : '';
      return tx(`⚠ 帧率偏低：${gpu}（${low}建议「${tier}」，约 ${fpsText(v.fps ?? 0)} 帧）`, `⚠ Low frame rate: ${gpu} (${low}“${tier}” recommended, about ${fpsText(v.fps ?? 0)} fps)`);
    }
    default:
      return v.fps !== null
        ? tx(`✅ 显卡已启用：${gpu}，预计帧率 ${fpsText(v.fps)}`, `✅ Graphics card in use: ${gpu}, about ${fpsText(v.fps)} fps expected`)
        : tx(`✅ 显卡已启用：${gpu}`, `✅ Graphics card in use: ${gpu}`);
  }
}
