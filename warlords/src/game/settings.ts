// User preferences store (contract). Persisted to localStorage when available.
// Read by render (fov/quality), input (sensitivity), audio (volumes), net (server), UI (everything).

export type Lang = 'zh' | 'en';
/** Graphics tiers, cheapest first: 极速 / 流畅 / 均衡 / 高清 / 极致 (render/quality.ts). */
export type Quality = 'potato' | 'low' | 'medium' | 'high' | 'ultra';
export const QUALITIES: readonly Quality[] = ['potato', 'low', 'medium', 'high', 'ultra'];

/**
 * A stored quality value → a tier: the five ids (any case / padding; the
 * three older ones keep their meaning), null for anything else (the first-run
 * default then applies).
 */
export function migrateQuality(v: unknown): Quality | null {
  if (typeof v !== 'string') return null;
  const q = v.trim().toLowerCase();
  return (QUALITIES as readonly string[]).includes(q) ? (q as Quality) : null;
}

export interface NetServerConfig {
  /** 'peer' = PeerJS WebRTC (default public cloud or custom), 'ws' = WebSocket relay server */
  mode: 'peer' | 'ws';
  /** custom PeerJS server; empty = public cloud 0.peerjs.com */
  peerHost: string;
  peerPort: number;
  peerPath: string;
  peerSecure: boolean;
  /** ws relay url, e.g. ws://192.168.1.5:8787/ws */
  wsUrl: string;
  /** optional TURN server for strict NATs */
  turnUrl: string;
  turnUser: string;
  turnPass: string;
}

export interface UserSettings {
  playerName: string;
  lang: Lang;
  mouseSensitivity: number; // 0.2 .. 3
  adsSensitivity: number; // multiplier while aiming
  invertY: boolean;
  fov: number; // 60 .. 100
  quality: Quality;
  /**
   * 自动 (default): the tier follows this machine — the GPU benchmark picks it
   * (render/bench.ts; again whenever the GPU changes) and 自动调节画质 may step it
   * down and back up in a match. false: the player picked `quality` themselves.
   */
  qualityAuto: boolean;
  /** 自动调节画质: a match that stays slow steps the tier down (and, on 自动, a fast one back up) */
  autoAdjust: boolean;
  /** 自动: highest render scale (canvas px per CSS px) the benchmark allows on this screen; 0 = the tier's own cap */
  autoRenderScale: number;
  showFps: boolean;
  /** the last GPU benchmark (null: never ran) */
  gpuBench: GpuBench | null;
  masterVolume: number; // 0..1
  musicVolume: number;
  sfxVolume: number;
  voiceLines: boolean; // speak hero quotes (speechSynthesis)
  /** background music: 'noname' = 无名杀 recordings (streamed), 'original' = the procedural score */
  musicSource: 'noname' | 'original';
  touchControls: 'auto' | 'on' | 'off';
  /** camera: 'auto' = first person with mouse + keyboard, third person on touch controls (render/camera/viewMode.ts) */
  cameraView: 'auto' | 'first' | 'third';
  net: NetServerConfig;
}

export const DEFAULT_SETTINGS: UserSettings = {
  playerName: '',
  lang: 'zh',
  mouseSensitivity: 1,
  adsSensitivity: 0.6,
  invertY: false,
  fov: 75,
  quality: 'medium',
  qualityAuto: true,
  autoAdjust: true,
  autoRenderScale: 0,
  showFps: false,
  gpuBench: null,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  voiceLines: true,
  musicSource: 'noname',
  touchControls: 'auto',
  cameraView: 'auto',
  net: {
    mode: 'peer',
    peerHost: '',
    peerPort: 443,
    peerPath: '/',
    peerSecure: true,
    wsUrl: '',
    turnUrl: '',
    turnUser: '',
    turnPass: '',
  },
};

const KEY = 'sgwl.settings.v1';
type Listener = (s: UserSettings) => void;

/** What the device looks like, for first-run defaults (injectable for tests). */
export interface DeviceHints {
  /** matchMedia('(pointer: coarse)') — a finger, not a mouse */
  coarse: boolean;
  /** min(screen.width, screen.height) in CSS px (0 = unknown) */
  minSide: number;
  /** navigator.hardwareConcurrency (absent: unknown) */
  cores?: number;
  /** navigator.deviceMemory in GB (Chrome; absent: unknown) */
  memoryGb?: number;
  /** the WebGL renderer string of the page's GPU probe ('' unknown; absent: not probed — no DOM) */
  gpu?: string;
}

type HintSource = {
  matchMedia?: (q: string) => { matches: boolean };
  screen?: { width: number; height: number };
  navigator?: { hardwareConcurrency?: number; deviceMemory?: number };
  document?: Document;
};

export function deviceHints(g: HintSource = globalThis as never): DeviceHints {
  let coarse = false;
  try {
    coarse = !!g.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  const w = Number(g.screen?.width) || 0;
  const h = Number(g.screen?.height) || 0;
  const out: DeviceHints = { coarse, minSide: w > 0 && h > 0 ? Math.min(w, h) : 0 };
  const cores = Number(g.navigator?.hardwareConcurrency) || 0;
  const mem = Number(g.navigator?.deviceMemory) || 0;
  if (cores > 0) out.cores = cores;
  if (mem > 0) out.memoryGb = mem;
  // the GPU only in a page (the probe creates a throwaway WebGL context once)
  if (g.document && typeof g.document.createElement === 'function') out.gpu = probeGpu(g.document).renderer;
  return out;
}

/**
 * First-run graphics tier, before the GPU benchmark has run (the automatic
 * quality replaces it then): phones and tablets (touch, or a small screen), ≤ 4
 * CPU cores or ≤ 4 GB of memory, and integrated / mobile / software / unknown GPUs
 * start on 'low'; a discrete card or Apple silicon on 'medium'. Without a page
 * (no GPU probe: node, workers) the GPU and CPU are not judged: 'medium'.
 */
export function defaultQuality(d: DeviceHints = deviceHints()): Quality {
  if (d.coarse || (d.minSide > 0 && d.minSide <= 500)) return 'low';
  if (d.gpu === undefined) return 'medium';
  if ((d.cores !== undefined && d.cores <= 4) || (d.memoryGb !== undefined && d.memoryGb <= 4)) return 'low';
  const c = classifyGpu(d.gpu);
  return c === 'discrete' || c === 'apple' ? 'medium' : 'low';
}

/**
 * First-run render-scale cap (settings.autoRenderScale), before the benchmark:
 * Apple silicon runs 均衡 fine but its Retina screens (DPR 2) would draw up to
 * 2.25× the pixels at 均衡's own cap — 1.25 instead. 0: the tier's own cap.
 */
export function defaultRenderScale(d: DeviceHints = deviceHints()): number {
  return d.gpu !== undefined && classifyGpu(d.gpu) === 'apple' ? 1.25 : 0;
}

/** Tier a profile saved before 自动 existed started on (its quality differs → the player picked it). */
function legacyDefaultQuality(d: DeviceHints): Quality {
  return d.coarse || (d.minSide > 0 && d.minSide <= 500) ? 'low' : 'medium';
}

// ── GPU ──────────────────────────────────────────────────────────────────────

/**
 * What kind of GPU a WebGL renderer string names. 'software': the browser draws
 * WebGL on the CPU (hardware acceleration off, or the GPU blocklisted) — every
 * frame is slow however strong the machine is.
 */
export type GpuClass = 'software' | 'mobile' | 'apple' | 'discrete' | 'integrated' | 'unknown';

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software|gdi generic/i;
const MOBILE_GPU = /mali|adreno|powervr|videocore|tegra|apple a\d/i;
const APPLE_GPU = /apple (m\d|gpu)/i;
// AMD APUs: "Radeon(TM) Graphics", "Radeon 780M", "Radeon RX Vega 8 Graphics" (Ryzen laptops)
const AMD_APU = /radeon(\(tm\))?\s+graphics|radeon\s+\d{3}m\b|vega \d+ graphics/i;
// Intel Arc and AMD's RX / Pro / R9 lines are cards
const DISCRETE_GPU = /nvidia|geforce|quadro|\brtx\b|\bgtx\b|radeon\s*(\(tm\)\s*)?(rx|pro|r9|r7|hd \d{4})|firepro|\barc\b|arc\(tm\)/i;
const INTEGRATED_GPU = /intel|iris|uhd graphics|hd graphics|radeon|vega/i;

/** The browser renders WebGL without the GPU (hardware acceleration off / blocklisted). */
export function isSoftwareGpu(renderer: string): boolean {
  return SOFTWARE_GPU.test(renderer);
}

export function classifyGpu(renderer: string): GpuClass {
  const r = renderer.trim();
  if (!r) return 'unknown';
  if (SOFTWARE_GPU.test(r)) return 'software';
  if (MOBILE_GPU.test(r)) return 'mobile';
  if (APPLE_GPU.test(r)) return 'apple';
  if (AMD_APU.test(r)) return 'integrated';
  if (DISCRETE_GPU.test(r)) return 'discrete';
  if (INTEGRATED_GPU.test(r)) return 'integrated';
  return 'unknown';
}

/** A GPU benchmark result (render/bench.ts), kept so it runs again only when the GPU changes. */
export interface GpuBench {
  /** the GPU it ran on (WebGL renderer string) */
  gpu: string;
  /** median frame time (ms) of the benchmark scene at its reference size (1280×720), and at a quarter of it (0: no benchmark — a software renderer, or it failed) */
  ms: number;
  msSmall: number;
  /** Date.now() */
  at: number;
}

/** The one WebGL probe of the page (a throwaway context, read once). */
export interface GpuInfo {
  /** a WebGL 2 context could be created (three.js needs it) */
  webgl2: boolean;
  /** why not (when !webgl2) */
  reason: string | null;
  /** the GPU the browser renders WebGL with (UNMASKED_RENDERER_WEBGL); '' = unknown */
  renderer: string;
  vendor: string;
}

const NO_GPU: GpuInfo = { webgl2: false, reason: 'no DOM', renderer: '', vendor: '' };
let gpuCache: GpuInfo | null = null;

/** Renderer / vendor strings of a context (the unmasked ones when the browser masks gl.RENDERER). */
export function readGpuStrings(gl: WebGLRenderingContext | WebGL2RenderingContext): { renderer: string; vendor: string } {
  let renderer = '';
  let vendor = '';
  try {
    renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    vendor = String(gl.getParameter(gl.VENDOR) ?? '');
    // Chrome / Safari answer the masked "WebKit WebGL"; Firefox already gives the real (sanitized) name
    if (!renderer || /^webkit/i.test(renderer)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? renderer);
        vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? vendor);
      }
    }
  } catch {
    /* a lost / odd context: unknown */
  }
  return { renderer: renderer.trim(), vendor: vendor.trim() };
}

/**
 * Probe WebGL once per page (cached; `fresh` probes again): can a WebGL 2 context
 * be created, and which GPU does the browser use for it — asked like the game
 * asks (high-performance: a laptop's discrete GPU, not its integrated one). The
 * context is freed right away.
 */
export function probeGpu(doc: Document | undefined = (globalThis as { document?: Document }).document, fresh = false): GpuInfo {
  if (gpuCache && !fresh) return gpuCache;
  if (!doc || typeof doc.createElement !== 'function') return NO_GPU;
  const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: false, powerPreference: 'high-performance' };
  try {
    const canvas = doc.createElement('canvas');
    const gl = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    if (gl) {
      gpuCache = { webgl2: true, reason: null, ...readGpuStrings(gl) };
      // free the probe context right away (browsers cap live contexts)
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } else {
      const reason = typeof WebGL2RenderingContext === 'undefined' ? 'WebGL 2 is not supported by this browser' : 'WebGL 2 context creation failed (disabled or blocklisted GPU)';
      // WebGL 1 may still say which renderer the browser fell back to
      const gl1 = doc.createElement('canvas').getContext('webgl', attrs) as WebGLRenderingContext | null;
      gpuCache = { webgl2: false, reason, ...(gl1 ? readGpuStrings(gl1) : { renderer: '', vendor: '' }) };
      gl1?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (err) {
    gpuCache = { webgl2: false, reason: err instanceof Error ? err.message : String(err), renderer: '', vendor: '' };
  }
  return gpuCache;
}

/** Test / harness hook: pretend the probe found `info` (null: probe again). */
export function setGpuInfoForTests(info: GpuInfo | null): void {
  gpuCache = info;
}

function load(): UserSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserSettings>;
      const quality: Quality = migrateQuality(parsed.quality) ?? defaultQuality();
      // saved before 自动 existed: a tier other than the old first-run default was the player's pick
      const qualityAuto = typeof parsed.qualityAuto === 'boolean' ? parsed.qualityAuto : parsed.quality === undefined || quality === legacyDefaultQuality(deviceHints());
      return { ...DEFAULT_SETTINGS, ...parsed, quality, qualityAuto, net: { ...DEFAULT_SETTINGS.net, ...(parsed.net ?? {}) } };
    }
  } catch {
    /* storage unavailable (private mode / file://) */
  }
  const hints = deviceHints();
  return { ...structuredClone(DEFAULT_SETTINGS), quality: defaultQuality(hints), autoRenderScale: defaultRenderScale(hints) };
}

/** Test hook: settings as a fresh load from storage would produce them. */
export function loadSettingsForTest(): UserSettings {
  return load();
}

let current: UserSettings = load();
const listeners = new Set<Listener>();

export const settings = {
  get(): UserSettings {
    return current;
  },
  update(patch: Partial<UserSettings>): void {
    current = { ...current, ...patch, net: { ...current.net, ...(patch.net ?? {}) } };
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
    for (const l of listeners) l(current);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
