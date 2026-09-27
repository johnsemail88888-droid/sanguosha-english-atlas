// GPU benchmark (性能体检 / automatic quality): ~2 s of a synthetic, 'medium'-like
// scene in its own offscreen WebGL context — a few hundred lit, shadowed meshes
// (~0.4 M triangles), fog, tone mapping, a 2048² PCF shadow map, a 4× MSAA
// half-float target resolved by a full-screen pass, like the game's composer.
//
// Every timed frame is synchronised (a 1-pixel readPixels waits for the GPU), so
// a sample is the CPU submission + GPU time of one frame. Frames alternate
// between the reference size (1280×720) and a quarter of it (640×360): the pair
// tells the fixed cost of a frame from the per-pixel cost (adaptiveRes.frameCost).
// The page is yielded to between frames, so the menus stay responsive.
import * as THREE from 'three';
import { readGpuStrings } from '../game/settings';

export interface BenchResult {
  /** median frame ms at 1280×720, and at 640×360 (0: the benchmark failed) */
  ms: number;
  msSmall: number;
  /** timed frames (both sizes) */
  frames: number;
  /** the GPU it ran on (WebGL renderer string) */
  renderer: string;
  /** why it failed (no WebGL…) */
  error?: string;
}

export interface BenchOptions {
  /** time budget for the timed frames (ms); default 2000 */
  durationMs?: number;
  /** stop after this many timed frames; default 80 */
  maxFrames?: number;
  /** stop early (a match started) */
  signal?: { aborted: boolean };
}

const W = 1280;
const H = 720;

/** Deterministic pseudo-random numbers (the scene is the same on every machine). */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

interface BenchScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update(i: number): void;
  dispose(): void;
}

function buildScene(): BenchScene {
  const rand = rng(20260926);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb4c8);
  scene.fog = new THREE.Fog(0x9fb4c8, 60, 260);
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.1, 340);
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const geo = <T extends THREE.BufferGeometry>(g: T): T => (geos.push(g), g);
  const mat = (color: number, rough = 0.85, metal = 0.05): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    mats.push(m);
    return m;
  };

  // lights: sun with shadows (the 'medium' shadow map), sky fill, two point lights (braziers)
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a3a28, 0.9));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sun.position.set(40, 70, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -42;
  sc.right = 42;
  sc.top = 42;
  sc.bottom = -42;
  sc.near = 1;
  sc.far = 180;
  scene.add(sun, sun.target);
  for (const [x, z] of [[-12, 8], [14, -10]]) {
    const p = new THREE.PointLight(0xffa050, 30, 28, 2);
    p.position.set(x, 3, z);
    scene.add(p);
  }

  // ground
  const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(320, 320, 96, 96)), mat(0x6f7d4a, 0.95));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // buildings, walls, trees, characters
  const box = geo(new THREE.BoxGeometry(1, 1, 1));
  const cone = geo(new THREE.ConeGeometry(1, 1, 14));
  const trunk = geo(new THREE.CylinderGeometry(0.18, 0.24, 1, 10));
  const body = geo(new THREE.CapsuleGeometry(0.42, 1.1, 10, 24));
  const armour = geo(new THREE.TorusKnotGeometry(0.34, 0.1, 220, 28));
  const wallMats = [mat(0x8a6e52), mat(0x9a8b78), mat(0x6b4a34), mat(0x7a2a1e, 0.7), mat(0x565c66, 0.6, 0.2)];
  const leaf = mat(0x3f6a34, 0.9);
  const bark = mat(0x5a4030);
  const cloth = [mat(0x2f5aa8, 0.6), mat(0xa83228, 0.6), mat(0x3a8a3a, 0.6), mat(0xc8a040, 0.5, 0.4)];
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): THREE.Mesh => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    o.rotation.y = ry;
    o.castShadow = true;
    o.receiveShadow = true;
    scene.add(o);
    return o;
  };
  for (let i = 0; i < 110; i++) {
    const a = rand() * Math.PI * 2;
    const d = 10 + rand() * 110;
    const w = 3 + rand() * 7;
    const hgt = 3 + rand() * 9;
    add(box, wallMats[i % wallMats.length], Math.cos(a) * d, hgt / 2, Math.sin(a) * d, w, hgt, 2 + rand() * 6, rand() * Math.PI);
    if (i % 2 === 0) add(cone, wallMats[3], Math.cos(a) * d, hgt + 1.2, Math.sin(a) * d, w * 0.8, 2.4, w * 0.8, rand());
  }
  for (let i = 0; i < 60; i++) {
    const x = (rand() - 0.5) * 200;
    const z = (rand() - 0.5) * 200;
    const s = 0.8 + rand() * 0.8;
    add(trunk, bark, x, 1.2 * s, z, s, 2.4 * s, s);
    add(cone, leaf, x, 3.6 * s, z, 2 * s, 4 * s, 2 * s, rand());
  }
  const movers: THREE.Object3D[] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const d = 6 + (i % 5) * 3;
    movers.push(add(body, cloth[i % cloth.length], Math.cos(a) * d, 0.97, Math.sin(a) * d, 1, 1, 1));
    movers.push(add(armour, cloth[3], Math.cos(a) * d, 1.3, Math.sin(a) * d, 0.8, 0.8, 0.8));
  }

  return {
    scene,
    camera,
    update(i: number): void {
      // a slow orbit: every frame is a different view (nothing is cached between samples)
      const a = i * 0.035;
      camera.position.set(Math.cos(a) * 26, 7 + Math.sin(i * 0.05) * 1.5, Math.sin(a) * 26);
      camera.lookAt(0, 2, 0);
      for (let k = 0; k < movers.length; k++) movers[k].rotation.y = i * 0.05 + k;
      sun.position.set(camera.position.x + 40, 70, camera.position.z + 25);
      sun.target.position.set(camera.position.x, 0, camera.position.z);
    },
    dispose(): void {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      sun.shadow.map?.dispose();
    },
  };
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run the benchmark (see the file comment). Never throws: a failure comes back as { ms: 0, error }. */
export async function runGpuBenchmark(opts: BenchOptions = {}): Promise<BenchResult> {
  const durationMs = opts.durationMs ?? 2000;
  const maxFrames = opts.maxFrames ?? 80;
  let renderer: THREE.WebGLRenderer | null = null;
  let built: BenchScene | null = null;
  const targets: THREE.WebGLRenderTarget[] = [];
  let quad: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null = null;
  let name = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    // the GPU the game will use (dual-GPU laptops: the discrete one)
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const gl = renderer.getContext();
    name = readGpuStrings(gl).renderer;
    built = buildScene();
    const { scene, camera } = built;
    for (const [w, h] of [[W, H], [W / 2, H / 2]]) targets.push(new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }));
    // the composer's final pass: the MSAA target resolved and shaded onto the canvas
    const mat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader:
        'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float v = smoothstep(0.9, 0.35, length(vUv - 0.5)); gl_FragColor = vec4(c.rgb * mix(0.7, 1.0, v), 1.0); }',
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    quad = { mesh, mat };
    const postScene = new THREE.Scene();
    postScene.add(mesh);
    const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const px = new Uint8Array(4);
    const r = renderer;
    const frame = (i: number, small: boolean): void => {
      built?.update(i);
      const t = targets[small ? 1 : 0];
      r.setRenderTarget(t);
      r.render(scene, camera);
      r.setRenderTarget(null);
      mat.uniforms.tDiffuse.value = t.texture;
      r.render(postScene, postCam);
      // wait for the GPU: the sample is the whole frame, not just its submission
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    // compile + first uploads (untimed)
    r.compile(scene, camera);
    frame(0, false);
    frame(1, true);
    await yieldToPage();
    const big: number[] = [];
    const small: number[] = [];
    const t0 = performance.now();
    for (let i = 2; big.length + small.length < maxFrames; i++) {
      if (opts.signal?.aborted) break;
      const isSmall = i % 2 === 1;
      const a = performance.now();
      frame(i, isSmall);
      (isSmall ? small : big).push(performance.now() - a);
      // at least 3 frames of each size, then until the time is up
      if (performance.now() - t0 > durationMs && big.length >= 3 && small.length >= 3) break;
      await yieldToPage();
      if (renderer.getContext().isContextLost()) throw new Error('WebGL context lost');
    }
    return { ms: median(big), msSmall: median(small), frames: big.length + small.length, renderer: name };
  } catch (err) {
    return { ms: 0, msSmall: 0, frames: 0, renderer: name, error: err instanceof Error ? err.message : String(err) };
  } finally {
    built?.dispose();
    for (const t of targets) t.dispose();
    quad?.mesh.geometry.dispose();
    quad?.mat.dispose();
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}
