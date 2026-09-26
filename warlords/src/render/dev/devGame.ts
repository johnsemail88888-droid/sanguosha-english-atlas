// Dev harness: GameRenderer + InputController on a synthetic DevView.
//   ?hero=<id>      local hero (default guanyu)
//   ?cam=free       fly camera (WASD + drag, Q/E down/up)
//   ?quality=low|medium|high
//   ?map=showcase   hand-made showcase map (default: the real generated map)
//   ?at=x,z         lineup origin override
//   ?far=<m>        a hero standing <m> metres straight ahead (hero visibility at range)
//   ?texcap=off     AI-art character / weapon textures at their shipped size on every tier (A/B)
//   ?qstaged=0      a mid-match quality switch applies all at once (A/B of the staged switch)
import { generateMap } from '../../sim/map/generate';
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { Quality } from '../../game/settings';
import { GameRenderer } from '../renderer';
import { InputController } from '../../game/input';
import { DevView } from './devView';
import { buildShowcaseMap } from './showcase';
import { colliderAabb } from '../camera/pick';
import { QUALITY_PRESETS } from '../quality';

declare global {
  interface Window {
    __ready?: boolean;
    __info?: unknown;
    __renderer?: GameRenderer;
    __dev?: DevView;
    /** e2e: render a frame and measure the canvas (mean / std-dev luminance, distinct colour buckets) */
    __sampleCanvas?: () => { mean: number; std: number; buckets: number; width: number; height: number };
  }
}

/** Find a flat, collider-free rectangle near `near` for the lineup. */
function findOpenArea(map: MapData, near: { x: number; z: number }, w = 70, d = 50): { x: number; z: number } {
  const boxes = map.colliders.map(colliderAabb);
  let best = near;
  let bestScore = Infinity;
  const half = map.size / 2 - w / 2 - 20;
  for (let r = 0; r < 140; r += 6) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / Math.max(4, r / 6)) {
      const x = near.x + Math.cos(a) * r;
      const z = near.z + Math.sin(a) * r;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      let hits = 0;
      for (const b of boxes) if (b[2] > x - w / 2 && b[0] < x + w / 2 && b[3] > z - d / 2 && b[1] < z + d / 2) hits++;
      let hmin = Infinity;
      let hmax = -Infinity;
      for (let i = -3; i <= 3; i++)
        for (let j = -3; j <= 3; j++) {
          const h = terrainHeight(map, x + (i * w) / 6, z + (j * d) / 6);
          hmin = Math.min(hmin, h);
          hmax = Math.max(hmax, h);
        }
      if (hmin < map.waterLevel + 0.3) continue;
      const score = hits * 10 + (hmax - hmin) * 3 + r * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    if (bestScore < 2) break;
  }
  return best;
}

export function startDevGame(canvas: HTMLCanvasElement, params: URLSearchParams): void {
  const qp = params.get('quality');
  // dev override only: do not persist into the player's stored settings
  const quality: Quality | undefined = qp === 'low' || qp === 'medium' || qp === 'high' ? qp : undefined;
  // measurement A/B only: the per-tier GLB texture caps off
  if (params.get('texcap') === 'off') for (const p of Object.values(QUALITY_PRESETS)) Object.assign(p, { charTexture: 1 << 14, weaponTexture: 1 << 14 });
  const t0 = performance.now();
  const showcase = params.get('map') === 'showcase';
  const map = showcase ? buildShowcaseMap() : generateMap(Number(params.get('seed') ?? 20260924));
  const at = params.get('at')?.split(',').map(Number);
  const origin = at && at.length === 2 ? { x: at[0], z: at[1] } : showcase ? { x: 0, z: 25 } : findOpenArea(map, { x: 0, z: 60 });
  const view = new DevView({ heroId: params.get('hero') ?? 'guanyu', map, origin, farHeroDist: Number(params.get('far') ?? 0) });
  const renderer = new GameRenderer(canvas, view, { quality, stagedQualitySwitch: params.get('qstaged') !== '0' });
  const tBuild = performance.now() - t0;
  // debug: ?hide=zone,terrain_skirt,water,... hides scene objects by name prefix
  const hide = params.get('hide')?.split(',') ?? [];
  if (hide.length) renderer.scene.traverse((o) => {
    if (hide.some((h) => o.name.startsWith(h))) o.visible = false;
  });
  const input = new InputController(canvas);
  window.__renderer = renderer;
  window.__dev = view;
  window.__sampleCanvas = () => {
    // render synchronously and read back in the same task (drawing buffer still valid)
    renderer.frame(1 / 60);
    const w = 160;
    const h = Math.max(1, Math.round((w * canvas.height) / Math.max(1, canvas.width)));
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const g = c2.getContext('2d')!;
    g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let sum = 0;
    let sum2 = 0;
    const buckets = new Set<number>();
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += l;
      sum2 += l * l;
      buckets.add(((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4));
    }
    const n = px.length / 4;
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), buckets: buckets.size, width: canvas.width, height: canvas.height };
  };
  const onResize = (): void => renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // optional fly camera
  const free = params.get('cam') === 'free';
  const fc = { pos: { x: origin.x + 18, y: terrainHeight(map, origin.x, origin.z) + 9, z: origin.z + 26 }, yaw: 0.55, pitch: -0.28 };
  const fcp = params.get('fc')?.split(',').map(Number);
  if (fcp && fcp.length === 5) Object.assign(fc, { pos: { x: fcp[0], y: fcp[1], z: fcp[2] }, yaw: fcp[3], pitch: fcp[4] });
  // ?rel=1: fc height is relative to the terrain under the camera
  if (params.get('rel') === '1') fc.pos.y += Math.max(terrainHeight(map, fc.pos.x, fc.pos.z), map.waterLevel);
  const keys = new Set<string>();
  if (free) {
    input.setEnabled(false);
    window.addEventListener('keydown', (e) => keys.add(e.code));
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('mousedown', (e) => (drag = { x: e.clientX, y: e.clientY }));
    window.addEventListener('mouseup', () => (drag = null));
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      fc.yaw -= (e.clientX - drag.x) * 0.004;
      fc.pitch = Math.max(-1.5, Math.min(1.5, fc.pitch - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    });
  }
  // ?fire=1 holds the trigger (tests local fire feedback without pointer lock); ?ads=1 aims
  if (params.get('fire') === '1') input.state.setMouseButton('fire', true);
  if (params.get('ads') === '1') input.state.setMouseButton('ads', true);
  // scripted look for screenshots: ?look=yaw,pitch
  const look = params.get('look')?.split(',').map(Number);
  if (look && look.length === 2) input.setLook(look[0], look[1]);

  const stats = document.getElementById('stats');
  let last = performance.now();
  let frames = 0;
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (free) {
      const sp = (keys.has('ShiftLeft') ? 40 : 12) * dt;
      const fx = -Math.sin(fc.yaw);
      const fz = -Math.cos(fc.yaw);
      if (keys.has('KeyW')) (fc.pos.x += fx * sp), (fc.pos.z += fz * sp);
      if (keys.has('KeyS')) (fc.pos.x -= fx * sp), (fc.pos.z -= fz * sp);
      if (keys.has('KeyA')) (fc.pos.x += fz * sp), (fc.pos.z -= fx * sp);
      if (keys.has('KeyD')) (fc.pos.x -= fz * sp), (fc.pos.z += fx * sp);
      if (keys.has('KeyE')) fc.pos.y += sp;
      if (keys.has('KeyQ')) fc.pos.y -= sp;
      renderer.setFreeCamera(fc);
    }
    const frame = input.sample(renderer);
    view.pushInput(frame);
    view.update(dt);
    renderer.frame(dt);
    frames++;
    if (stats && frames % 15 === 0) {
      const s = renderer.stats();
      stats.textContent = `fps ${s.fps}  calls ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k\nentities ${s.entities}  particles ${s.particles}\nprops ${s.worldProps}  chunks ${s.worldChunks}  build ${tBuild.toFixed(0)}ms\n${map.nameZh} ${renderer.getCameraPose().pos.x.toFixed(1)},${renderer.getCameraPose().pos.z.toFixed(1)}`;
    }
    if (frames === 20) {
      window.__ready = true;
    }
    window.__info = { ...renderer.stats(), buildMs: Math.round(tBuild), origin, map: map.nameEn, props: map.props.length };
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
