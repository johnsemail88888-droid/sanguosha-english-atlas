// Renderer e2e (swiftshader): loads the render dev harness, checks for console
// errors, a non-blank canvas and sane draw-call counts. Self-contained: starts
// its own Vite dev server on :5181 unless one is already listening there.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.RENDER_E2E_PORT ?? 5181);
const BASE = `http://localhost:${PORT}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROMIUM = '/opt/pw-browsers/chromium';

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
});
test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/render-dev.html`);
    return r.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  if (await reachable()) return;
  // private config: same root, but no HMR so concurrent edits never reload the page mid-test
  const cfg = join(mkdtempSync(join(tmpdir(), 'render-e2e-')), 'vite.config.mjs');
  writeFileSync(cfg, `export default { root: ${JSON.stringify(ROOT)}, base: './', server: { hmr: false }, logLevel: 'warn' };\n`);
  server = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--config', cfg, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  for (let i = 0; i < 120 && !(await reachable()); i++) await new Promise((r) => setTimeout(r, 500));
  expect(await reachable()).toBe(true);
});

test.afterAll(() => {
  server?.kill();
  server = null;
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function openHarness(page: Page, query: string): Promise<void> {
  await page.goto(`${BASE}/render-dev.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 150_000 });
}

test('renders the generated battlefield without console errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?look=0,-0.08');
  const s = await page.evaluate(() => window.__sampleCanvas!());
  expect(s.width).toBeGreaterThan(100);
  // a real scene: not a flat clear colour
  expect(s.std).toBeGreaterThan(12);
  expect(s.buckets).toBeGreaterThan(60);
  const info = await page.evaluate(() => (window as unknown as { __info: { drawCalls: number; triangles: number; entities: number } }).__info);
  expect(info.entities).toBeGreaterThan(30);
  expect(info.drawCalls).toBeGreaterThan(10);
  // budget: < 300 draw calls in the default TPS view (30+ heroes, troops, loot, hazards on screen)
  expect(info.drawCalls).toBeLessThan(300);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('showcase map at low quality, free camera', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?map=showcase&quality=low&cam=free&fc=0,30,70,0,-0.4');
  const s = await page.evaluate(() => window.__sampleCanvas!());
  expect(s.std).toBeGreaterThan(10);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('mount lineup: the AI-art horses (every coat) and war elephant are rigged and animate', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?mode=mounts&speed=7&rider=0');
  const info = await page.evaluate(() => (window as unknown as { __info: { mounts: { kind: string; glb: boolean }[] } }).__info);
  expect(info.mounts.length).toBe(7);
  // the deploy ships models/mounts/*.glb: every mount is the rigged model, none procedural
  expect(info.mounts.every((m) => m.glb)).toBe(true);
  // the gallop moves the legs: two frames apart differ
  const a = await page.evaluate(() => {
    window.__step!(1);
    return (document.getElementById('c') as HTMLCanvasElement).toDataURL();
  });
  const b = await page.evaluate(() => {
    window.__step!(9);
    return (document.getElementById('c') as HTMLCanvasElement).toDataURL();
  });
  expect(a.length).toBeGreaterThan(5000);
  expect(b).not.toBe(a);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('hero portraits render to PNG data URLs', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openHarness(page, '?mode=portraits&n=4&size=96');
  const srcs = await page.$$eval('img', (imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.length).toBe(4);
  for (const s of srcs) {
    expect(s.startsWith('data:image/png')).toBe(true);
    expect(s.length).toBeGreaterThan(2000);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

/** Minimal binary glTF: one box `h` metres tall standing `lift` metres above its origin. */
function boxGlb(h: number, lift: number): string {
  const w = 0.25;
  const pos = new Float32Array([
    -w, lift, -w, w, lift, -w, w, lift, w, -w, lift, w,
    -w, lift + h, -w, w, lift + h, -w, w, lift + h, w, -w, lift + h, w,
  ]);
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-w, lift, -w], max: [w, lift + h, w] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const binBuf = bin.length % 4 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const chunk = (buf: Buffer, type: number): Buffer => {
    const h2 = Buffer.alloc(8);
    h2.writeUInt32LE(buf.length, 0);
    h2.writeUInt32LE(type, 4);
    return Buffer.concat([h2, buf]);
  };
  return Buffer.concat([header, chunk(jsonBuf, 0x4e4f534a), chunk(binBuf, 0x004e4942)]).toString('base64');
}

test('GLB hero override: a registered GLB replaces the procedural body, normalised to 1.8 m', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?quality=low&look=0,-0.08');
  const r = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
    const models = await import(/* @vite-ignore */ `${location.origin}/src/render/models/index.ts`);
    models.registerHeroGlb('guanyu', url);
    const withGlb = models.createHeroModel('guanyu');
    const without = models.createHeroModel('zhaoyun');
    type Rig = { usesGlb: boolean; mesh: { visible: boolean }; glbObject: { scale: { x: number }; children: { position: { y: number } }[] } };
    const rig = withGlb.userData.rig as Rig;
    for (let i = 0; i < 100 && !rig.usesGlb; i++) await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => setTimeout(res, 300));
    const plain = without.userData.rig as Rig;
    return {
      usesGlb: rig.usesGlb,
      bodyHidden: !rig.mesh.visible,
      scale: rig.glbObject?.scale.x ?? 0,
      feetOffset: rig.glbObject?.children[0]?.position.y ?? 0,
      plainUsesGlb: plain.usesGlb,
    };
  }, boxGlb(3.6, 1));
  expect(r.usesGlb).toBe(true);
  expect(r.bodyHidden).toBe(true);
  expect(r.scale).toBeCloseTo(0.5, 3); // 3.6 m box → 1.8 m hero
  expect(r.feetOffset).toBeCloseTo(-1, 3); // feet moved onto the ground
  expect(r.plainUsesGlb).toBe(false); // no GLB → procedural, and no 404 probes in dev
  expect(errors, errors.join('\n')).toEqual([]);
});

test('heroes are never distance-culled: a 300 m hero renders on low quality', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await openHarness(page, '?quality=low&at=0,100&far=300');
  const r = await page.evaluate(() => {
    // private internals are fine here: this test is about the renderer itself
    const R = (window as unknown as { __renderer: any }).__renderer;
    const dev = (window as unknown as { __dev: any }).__dev;
    const far = dev.entities().find((e: { name?: string }) => e.name === 'Sniper');
    const loc = dev.get(dev.localId());
    // isolate the hero from occluders (terrain / buildings) and look at it through a narrow "scope"
    for (const c of R.scene.children) if (!c.isLight && c.name !== 'entities') c.visible = false;
    const cam = { x: loc.x, y: far.y + 1, z: loc.z };
    const yaw = Math.atan2(-(far.x - loc.x), -(far.z - loc.z));
    R.setFreeCamera({ pos: cam, yaw: yaw + 0.02, pitch: 0.01 });
    R.rig.baseFov = 12;
    for (let i = 0; i < 30; i++) R.frame(1 / 30);
    const canvas = R.renderer.domElement as HTMLCanvasElement;
    const p = R.worldToScreen({ x: far.x, y: far.y + 0.9, z: far.z });
    const grab = (): Uint8ClampedArray => {
      R.frame(1 / 60);
      const s = canvas.width / canvas.clientWidth;
      const c2 = document.createElement('canvas');
      c2.width = 16;
      c2.height = 24;
      const g = c2.getContext('2d')!;
      g.drawImage(canvas, p.x * s - 8, p.y * s - 12, 16, 24, 0, 0, 16, 24);
      return g.getImageData(0, 0, 16, 24).data;
    };
    const a = grab();
    const cameraFar = R.camera.far;
    const callsWith = R.stats().drawCalls;
    const y0 = far.y;
    far.y = y0 - 900; // out of range: the renderer may drop it
    const b = grab();
    const callsWithout = R.stats().drawCalls;
    far.y = y0;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 15) changed++;
    return { dist: Math.hypot(far.x - loc.x, far.z - loc.z), cameraFar, changed, heroCalls: callsWith - callsWithout, visible: R.entities.character(far.id).root.visible };
  });
  expect(r.dist).toBeGreaterThan(290);
  expect(r.visible).toBe(true);
  expect(r.cameraFar).toBeGreaterThan(r.dist); // far plane stretched past the low preset's 230 m
  expect(r.heroCalls).toBeGreaterThanOrEqual(1); // the hero was drawn (not frustum / distance culled)
  expect(r.changed).toBeGreaterThanOrEqual(3); // and its silhouette shows through the fog
  expect(errors, errors.join('\n')).toEqual([]);
});
