// Hero portraits: offscreen three.js render of the hero bust (the AI-art GLB
// body when the deploy ships it, else the procedural one) with dramatic lighting
// on a kingdom-coloured ink-wash backdrop → PNG data URL. The UI prefers the
// painted portraits (assets/portraits/*.webp); this is their fallback.
// One shared offscreen WebGLRenderer; renders are serialised and cached per
// heroId+size. Falls back to a 2D-canvas calligraphy card without WebGL.
import * as THREE from 'three';
import type { Kingdom } from '../core/types';
import { HERO_BY_ID } from '../data';
import { CharacterRig } from './models/character';
import { heroSpec } from './models';
import { heroModelPath, loadCharTemplate, modelUrl } from './models/glb';
import { loadAllClips } from './anim/glbClips';
import { CALLIGRAPHY_FONT, inkBackdropCanvas, makeCanvas } from './core/textures';
import { KINGDOM_COLORS } from './palette';

interface Offscreen {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
}

let offscreen: Offscreen | null | undefined;
const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

function getOffscreen(): Offscreen | null {
  if (offscreen !== undefined) return offscreen;
  try {
    if (typeof document === 'undefined') return (offscreen = null);
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    canvas.addEventListener('webglcontextlost', () => {
      offscreen = undefined;
    });
    offscreen = { renderer, canvas };
  } catch {
    offscreen = null;
  }
  return offscreen;
}

/** Render a hero portrait (bust, dramatic light) and return a data URL (PNG). Cached per id+size. */
export async function renderHeroPortrait(heroId: string, size = 256): Promise<string> {
  const px = Math.max(32, Math.min(1024, Math.round(size)));
  const key = `${heroId}|${px}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = queue.then(async () => {
    await prepareGlb(heroId);
    return renderNow(heroId, px);
  });
  queue = job.catch(() => undefined);
  const p = job.catch(() => fallbackPortrait(heroId, px));
  cache.set(key, p);
  return p;
}

/** Forget cached portraits (e.g. after hero data hot-reload). */
export function clearPortraitCache(): void {
  cache.clear();
}

/** Load the hero's GLB body + clips first when the deploy ships them (so renderNow can pose it synchronously). */
async function prepareGlb(heroId: string): Promise<void> {
  try {
    if (!(await modelUrl(heroModelPath(heroId)))) return;
    await Promise.all([loadCharTemplate(heroModelPath(heroId)), loadAllClips()]);
  } catch {
    /* procedural portrait */
  }
}

function renderNow(heroId: string, size: number): string {
  const off = getOffscreen();
  if (!off) return fallbackPortrait(heroId, size);
  const def = HERO_BY_ID[heroId];
  const kingdom: Kingdom = def?.kingdom ?? 'qun';
  const { renderer } = off;
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  // backdrop
  const bdCanvas = inkBackdropCanvas(kingdom, 512, heroId.length * 7 + 3);
  const bdTex = bdCanvas ? new THREE.CanvasTexture(bdCanvas.canvas as HTMLCanvasElement) : null;
  if (bdTex) bdTex.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: bdTex, color: bdTex ? 0xffffff : KINGDOM_COLORS[kingdom], toneMapped: false }));
  backdrop.position.set(0, 1.45, -1.6);
  scene.add(backdrop);
  // hero
  const rig = new CharacterRig(heroSpec(heroId, kingdom));
  rig.setWeapon(def?.signatureWeapon ?? null);
  rig.tryGlbOverride(heroId); // synchronous when prepareGlb loaded it
  rig.root.rotation.y = Math.PI + 0.42;
  const t0 = 0.8;
  for (let i = 0; i < 30; i++) rig.update(1 / 30, t0 + i / 30, { speed: 0, moveX: 0, moveZ: 0, pitch: 0.05, flags: 0, lowReady: true });
  scene.add(rig.root);
  const h = rig.usesGlb ? rig.headHeight() / 1.835 : rig.spec.body === 'huge' ? 1.1 : rig.spec.body === 'heavy' ? 1.02 : 1;
  // lights: warm key from front-left-above, cool rim from behind-right, dim fill
  const key = new THREE.DirectionalLight('#ffe0b0', 3.4);
  key.position.set(-1.6, 3.2, 2.4);
  const rim = new THREE.DirectionalLight('#9fc4ff', 2.6);
  rim.position.set(1.8, 2.2, -2.2);
  const rim2 = new THREE.DirectionalLight('#ffb070', 1.4);
  rim2.position.set(-2.2, 1.2, -1.8);
  scene.add(key, rim, rim2, new THREE.HemisphereLight('#c8d4e0', '#3a2a1a', 0.7));
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  const headY = 1.6 * h;
  // GLB bodies: a touch wider (hair buns, helmets and plumes are modelled, not stylised)
  const back = rig.usesGlb ? 1.95 : 1.75;
  cam.position.set(0.3, headY + (rig.usesGlb ? 0.02 : 0.08), back);
  cam.lookAt(0.02, headY - (rig.usesGlb ? 0.1 : 0.06), 0);
  renderer.setClearColor('#1a1410', 1);
  renderer.render(scene, cam);
  const url = off.canvas.toDataURL('image/png');
  // cleanup (shared geometry caches are kept)
  rig.dispose();
  backdrop.geometry.dispose();
  (backdrop.material as THREE.Material).dispose();
  bdTex?.dispose();
  return url;
}

/** 2D fallback: ink backdrop + the hero's name in calligraphy. */
function fallbackPortrait(heroId: string, size: number): string {
  const def = HERO_BY_ID[heroId];
  const kingdom: Kingdom = def?.kingdom ?? 'qun';
  const c = inkBackdropCanvas(kingdom, size) ?? makeCanvas(size, size);
  if (!c) return 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const g = c.ctx;
  g.fillStyle = '#1c1a18';
  g.font = `bold ${Math.round(size * 0.34)}px ${CALLIGRAPHY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const name = def?.nameZh ?? heroId;
  g.fillText(name.slice(0, 2), size / 2, size * 0.52);
  const canvas = c.canvas as HTMLCanvasElement;
  return typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
}
