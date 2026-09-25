// Hero portraits: offscreen three.js render of the hero bust (the AI-art GLB
// body when the deploy ships it, else the procedural one) with dramatic lighting
// on a kingdom-coloured ink-wash backdrop → PNG data URL. The UI prefers the
// painted portraits (assets/portraits/*.webp); this is their fallback.
// One shared offscreen "studio" (renderer, lights, backdrop); cached per
// heroId+size. Falls back to a 2D-canvas calligraphy card without WebGL.
//
// Scheduling (hero select opens with ~30 portraits to draw on a fresh client):
//   - jobs wait in a priority queue (renderHeroPortrait(id, size, priority),
//     bumpHeroPortraits(ids) for the cards the player is looking at);
//   - each job is split into stages — load the hero's GLB body + clips when
//     the deploy ships them (async, network / decode) / build the rig and issue
//     its shader compiles / draw / read the pixels back / encode the PNG — and the runner
//     yields to the browser between stages whenever the current slice has used
//     its ~12 ms budget, and always between two jobs (a job never runs in the
//     microtask chain of another);
//   - shader programs are compiled once: the previous rig is disposed only
//     after the next draw reused its programs, the drawing buffer is resized
//     only when the size changes;
//   - the pixels come back through a pixel-pack buffer + fence polled from later
//     tasks (WebGL2), so the main thread never blocks on the GPU (SwiftShader
//     rasterises in the GPU process meanwhile); the PNG is encoded by an async
//     canvas.toBlob. Without WebGL2 / fences: one synchronous toDataURL.
import * as THREE from 'three';
import type { Kingdom } from '../core/types';
import { HERO_BY_ID } from '../data';
import { CharacterRig } from './models/character';
import { heroSpec } from './models';
import { heroModelPath, loadCharTemplate, modelUrl } from './models/glb';
import { loadAllClips } from './anim/glbClips';
import { CALLIGRAPHY_FONT, inkBackdropCanvas, makeCanvas } from './core/textures';
import { KINGDOM_COLORS } from './palette';

interface Studio {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** current drawing-buffer size (setSize reallocates the buffers: only on change) */
  size: number;
  scene: THREE.Scene;
  cam: THREE.PerspectiveCamera;
  backdropMat: THREE.MeshBasicMaterial;
  /**
   * The previous portrait's rig + backdrop texture, disposed only after the next
   * draw (or when the queue has been idle a while): disposing a material right
   * away releases its shader program, and the next portrait would compile it
   * again (seconds on software GL).
   */
  prev: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Job {
  key: string;
  heroId: string;
  size: number;
  prio: number;
  seq: number;
  resolve: (url: string) => void;
}

/** Work budget of one slice (ms) before the runner yields to the browser. */
export const PORTRAIT_SLICE_MS = 12;
/** After issuing new shader programs, give the GPU process this long (ms) to compile before the first draw (no KHR_parallel_shader_compile). */
const COMPILE_GRACE_MS = 200;
/** Fence polling interval (ms). */
const PROBE_MS = 8;
/** The last rig / texture (and with them the cached programs) are freed after this long without portrait work (ms). */
const IDLE_RELEASE_MS = 15_000;

const STUB_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

let studio: Studio | null | undefined;
const cache = new Map<string, Promise<string>>();
const queue: Job[] = [];
let seq = 0;
let running = false;
let sliceStart = 0;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function getStudio(): Studio | null {
  if (studio !== undefined) return studio;
  try {
    if (typeof document === 'undefined') return (studio = null);
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.setClearColor('#1a1410', 1);
    const scene = new THREE.Scene();
    // backdrop (its ink-wash texture is swapped per hero)
    const backdropMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), backdropMat);
    backdrop.position.set(0, 1.45, -1.6);
    scene.add(backdrop);
    // lights: warm key from front-left-above, cool rim from behind-right, dim fill
    const key = new THREE.DirectionalLight('#ffe0b0', 3.4);
    key.position.set(-1.6, 3.2, 2.4);
    const rim = new THREE.DirectionalLight('#9fc4ff', 2.6);
    rim.position.set(1.8, 2.2, -2.2);
    const rim2 = new THREE.DirectionalLight('#ffb070', 1.4);
    rim2.position.set(-2.2, 1.2, -1.8);
    scene.add(key, rim, rim2, new THREE.HemisphereLight('#c8d4e0', '#3a2a1a', 0.7));
    const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    const s: Studio = { renderer, canvas, size: 0, scene, cam, backdropMat, prev: null, idleTimer: null };
    canvas.addEventListener('webglcontextlost', () => {
      if (studio === s) studio = undefined;
    });
    studio = s;
  } catch {
    studio = null;
  }
  return studio;
}

/**
 * Render a hero portrait (bust, dramatic light) and return a data URL (PNG).
 * Cached per id+size. Higher `priority` renders first (a pending request is
 * bumped when asked again with a higher priority).
 */
export function renderHeroPortrait(heroId: string, size = 256, priority = 0): Promise<string> {
  const px = Math.max(32, Math.min(1024, Math.round(size)));
  const key = `${heroId}|${px}`;
  const hit = cache.get(key);
  if (hit) {
    bump(key, priority);
    return hit;
  }
  const p = new Promise<string>((resolve) => {
    queue.push({ key, heroId, size: px, prio: priority, seq: seq++, resolve });
  });
  cache.set(key, p);
  schedule();
  return p;
}

/**
 * Render these heroes' pending portraits before anything else still waiting
 * (the player's own options, the cards scrolled into view). Earlier ids first.
 */
export function bumpHeroPortraits(heroIds: readonly string[], priority = 10): void {
  heroIds.forEach((id, i) => {
    const p = priority - i * 1e-3;
    for (const j of queue) if (j.heroId === id && p > j.prio) j.prio = p;
  });
}

/** Pending portrait jobs (`heroId|size`) in the order they will run (tests / debugging). */
export function pendingHeroPortraits(): string[] {
  return [...queue].sort(byPriority).map((j) => j.key);
}

/** Forget cached portraits (e.g. after hero data hot-reload). */
export function clearPortraitCache(): void {
  cache.clear();
}

function bump(key: string, priority: number): void {
  for (const j of queue) if (j.key === key && priority > j.prio) j.prio = priority;
}

const byPriority = (a: Job, b: Job): number => b.prio - a.prio || a.seq - b.seq;

function takeNext(): Job | undefined {
  if (!queue.length) return undefined;
  let bi = 0;
  for (let i = 1; i < queue.length; i++) if (byPriority(queue[i], queue[bi]) < 0) bi = i;
  return queue.splice(bi, 1)[0];
}

/** A later task (never the microtask chain of the caller). */
function nextTask(delay = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, delay));
}

/** Keep going while the slice has budget left, otherwise yield to the browser first. */
async function checkpoint(): Promise<void> {
  if (now() - sliceStart < PORTRAIT_SLICE_MS) return;
  await nextTask();
  sliceStart = now();
}

function schedule(): void {
  if (running) return;
  running = true;
  // start in a fresh task: the caller (a UI render pass) finishes first
  void nextTask().then(runQueue);
}

async function runQueue(): Promise<void> {
  sliceStart = now();
  const st = studio;
  if (st?.idleTimer) {
    clearTimeout(st.idleTimer);
    st.idleTimer = null;
  }
  try {
    for (let job = takeNext(); job; job = takeNext()) {
      let url: string;
      try {
        url = await renderJob(job.heroId, job.size);
      } catch (err) {
        console.warn('[render] portrait failed', job.heroId, err);
        url = fallbackPortrait(job.heroId, job.size);
      }
      job.resolve(url);
      // between two jobs always let input / rAF / timers run
      await nextTask();
      sliceStart = now();
    }
  } finally {
    running = false;
    if (queue.length) schedule();
    else scheduleIdleRelease();
  }
}

function scheduleIdleRelease(): void {
  const st = studio;
  if (!st || !st.prev || st.idleTimer) return;
  st.idleTimer = setTimeout(() => {
    st.idleTimer = null;
    if (running) return;
    st.prev?.();
    st.prev = null;
  }, IDLE_RELEASE_MS);
}

/** Load the hero's GLB body + clips first when the deploy ships them (so the rig can pose it synchronously). */
async function prepareGlb(heroId: string): Promise<void> {
  try {
    if (!(await modelUrl(heroModelPath(heroId)))) return;
    await Promise.all([loadCharTemplate(heroModelPath(heroId)), loadAllClips()]);
  } catch {
    /* procedural portrait */
  }
}

async function renderJob(heroId: string, size: number): Promise<string> {
  let st = getStudio();
  if (!st) return fallbackPortrait(heroId, size);
  // 0. the AI-art body (only with WebGL: the 2D fallback needs none of it)
  await prepareGlb(heroId);
  await checkpoint();
  st = getStudio(); // the context may have been lost while loading
  if (!st) return fallbackPortrait(heroId, size);
  const { renderer } = st;
  // 1. this hero's rig + backdrop into the studio scene
  const def = HERO_BY_ID[heroId];
  const kingdom: Kingdom = def?.kingdom ?? 'qun';
  const bdCanvas = inkBackdropCanvas(kingdom, 512, heroId.length * 7 + 3);
  const bdTex = bdCanvas ? new THREE.CanvasTexture(bdCanvas.canvas as HTMLCanvasElement) : null;
  if (bdTex) bdTex.colorSpace = THREE.SRGBColorSpace;
  if (!!st.backdropMat.map !== !!bdTex) st.backdropMat.needsUpdate = true;
  st.backdropMat.map = bdTex;
  st.backdropMat.color.set(bdTex ? 0xffffff : KINGDOM_COLORS[kingdom]);
  const rig = new CharacterRig(heroSpec(heroId, kingdom));
  rig.setWeapon(def?.signatureWeapon ?? null);
  rig.tryGlbOverride(heroId); // synchronous once prepareGlb loaded it
  rig.root.rotation.y = Math.PI + 0.42;
  const t0 = 0.8;
  for (let i = 0; i < 30; i++) rig.update(1 / 30, t0 + i / 30, { speed: 0, moveX: 0, moveZ: 0, pitch: 0.05, flags: 0, lowReady: true });
  st.scene.add(rig.root);
  const glb = rig.usesGlb;
  const h = glb ? rig.headHeight() / 1.835 : rig.spec.body === 'huge' ? 1.1 : rig.spec.body === 'heavy' ? 1.02 : 1;
  const headY = 1.6 * h;
  // GLB bodies: a touch wider (hair buns, helmets and plumes are modelled, not stylised)
  st.cam.position.set(0.3, headY + (glb ? 0.02 : 0.08), glb ? 1.95 : 1.75);
  st.cam.lookAt(0.02, headY - (glb ? 0.1 : 0.06), 0);
  const release = (): void => {
    rig.dispose();
    bdTex?.dispose();
  };
  let drawn = false;
  try {
    // 2. shader programs: issue the compiles, then let the GPU process work on them
    const programs = renderer.info.programs?.length ?? 0;
    if (renderer.extensions.has('KHR_parallel_shader_compile')) {
      await renderer.compileAsync(st.scene, st.cam);
    } else {
      renderer.compile(st.scene, st.cam);
      if ((renderer.info.programs?.length ?? 0) > programs) await nextTask(COMPILE_GRACE_MS);
    }
    await checkpoint();
    if (studio !== st) return fallbackPortrait(heroId, size); // context lost meanwhile
    // 3. draw, then free the previous portrait (its programs were reused by this draw)
    if (st.size !== size) {
      renderer.setSize(size, size, false);
      st.size = size;
    }
    renderer.render(st.scene, st.cam);
    drawn = true;
    st.scene.remove(rig.root);
    st.prev?.();
    st.prev = release;
    // 4. read back without stalling, encode
    const pixels = await readPixelsAsync(renderer, size);
    if (!pixels) return st.canvas.toDataURL('image/png');
    await checkpoint();
    return await encodePng(pixels, size);
  } finally {
    if (!drawn) {
      st.scene.remove(rig.root);
      release();
    }
  }
}

/**
 * Read the canvas (default framebuffer) back without stalling the main thread:
 * readPixels into a pixel-pack buffer, fence, poll the fence from later tasks.
 * null when unsupported (the caller falls back to a synchronous toDataURL).
 */
async function readPixelsAsync(renderer: THREE.WebGLRenderer, size: number): Promise<Uint8Array | null> {
  const gl = renderer.getContext();
  if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
  const bytes = size * size * 4;
  const buf = gl.createBuffer();
  if (!buf) return null;
  let sync: WebGLSync | null = null;
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return null;
    gl.flush();
    for (;;) {
      await nextTask(PROBE_MS);
      if (gl.isContextLost()) return null;
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.WAIT_FAILED) return null;
      if (st !== gl.TIMEOUT_EXPIRED) break;
    }
    const out = new Uint8Array(bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return out;
  } catch {
    return null;
  } finally {
    if (sync) gl.deleteSync(sync);
    gl.deleteBuffer(buf);
  }
}

/** Bottom-up RGBA rows → PNG data URL (async encoder when available). */
async function encodePng(pixels: Uint8Array, size: number): Promise<string> {
  // a CPU-backed 2D canvas (willReadFrequently): encoding it never waits on the GPU process
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return STUB_URL;
  const img = ctx.createImageData(size, size);
  const row = size * 4;
  for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * row, (size - y) * row), y * row);
  ctx.putImageData(img, 0, 0);
  if (typeof canvas.toBlob === 'function' && typeof FileReader !== 'undefined') {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) {
      return await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : STUB_URL);
        fr.onerror = () => resolve(canvas.toDataURL('image/png'));
        fr.readAsDataURL(blob);
      });
    }
  }
  return typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : STUB_URL;
}

/** 2D fallback: ink backdrop + the hero's name in calligraphy. */
function fallbackPortrait(heroId: string, size: number): string {
  const def = HERO_BY_ID[heroId];
  const kingdom: Kingdom = def?.kingdom ?? 'qun';
  const c = inkBackdropCanvas(kingdom, size) ?? makeCanvas(size, size);
  if (!c) return STUB_URL;
  const g = c.ctx;
  g.fillStyle = '#1c1a18';
  g.font = `bold ${Math.round(size * 0.34)}px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const name = def?.nameZh ?? heroId;
  g.fillText(name.slice(0, 2), size / 2, size * 0.52);
  const canvas = c.canvas as HTMLCanvasElement;
  return typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : STUB_URL;
}
