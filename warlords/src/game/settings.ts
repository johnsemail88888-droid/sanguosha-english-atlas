// User preferences store (contract). Persisted to localStorage when available.
// Read by render (fov/quality), input (sensitivity), audio (volumes), net (server), UI (everything).

export type Lang = 'zh' | 'en';
export type Quality = 'low' | 'medium' | 'high';

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
  showFps: boolean;
  masterVolume: number; // 0..1
  musicVolume: number;
  sfxVolume: number;
  voiceLines: boolean; // speak hero quotes (speechSynthesis)
  /** background music: 'noname' = 无名杀 recordings (streamed), 'original' = the procedural score */
  musicSource: 'noname' | 'original';
  touchControls: 'auto' | 'on' | 'off';
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
  showFps: false,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  voiceLines: true,
  musicSource: 'noname',
  touchControls: 'auto',
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
}

export function deviceHints(g: { matchMedia?: (q: string) => { matches: boolean }; screen?: { width: number; height: number } } = globalThis as never): DeviceHints {
  let coarse = false;
  try {
    coarse = !!g.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  const w = Number(g.screen?.width) || 0;
  const h = Number(g.screen?.height) || 0;
  return { coarse, minSide: w > 0 && h > 0 ? Math.min(w, h) : 0 };
}

/** First-run graphics quality: phones and tablets (touch, or a small screen) start on 'low'. */
export function defaultQuality(d: DeviceHints = deviceHints()): Quality {
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
function readGpuStrings(gl: WebGLRenderingContext | WebGL2RenderingContext): { renderer: string; vendor: string } {
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
 * Probe WebGL once per page (cached): can a WebGL 2 context be created, and which
 * GPU does the browser use for it. The context is freed right away.
 */
export function probeGpu(doc: Document | undefined = (globalThis as { document?: Document }).document): GpuInfo {
  if (gpuCache) return gpuCache;
  if (!doc || typeof doc.createElement !== 'function') return NO_GPU;
  const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: false, powerPreference: 'default' };
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
      const q = parsed.quality;
      const quality: Quality = q === 'low' || q === 'medium' || q === 'high' ? q : defaultQuality();
      return { ...DEFAULT_SETTINGS, ...parsed, quality, net: { ...DEFAULT_SETTINGS.net, ...(parsed.net ?? {}) } };
    }
  } catch {
    /* storage unavailable (private mode / file://) */
  }
  return { ...structuredClone(DEFAULT_SETTINGS), quality: defaultQuality() };
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
