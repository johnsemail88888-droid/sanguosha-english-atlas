// Post-processing chain. The scene is ALWAYS rendered into a linear HDR target
// and tone-mapped (ACES) + sRGB-encoded by OutputPass, so fog, sky and lit
// surfaces share one colour pipeline on every quality level.
//   WorldPass (sky layer + main scene) → [UnrealBloom] → OutputPass → [Vignette]
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { SkyLayer } from './sky';

/** A full-screen triangle with exactly the attributes of three's FullScreenQuad (position + uv). */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return g;
}

/** Renders the background sky layer, then the world on top (depth cleared in between). */
class WorldPass extends Pass {
  constructor(
    private readonly sky: SkyLayer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    super();
    this.needsSwap = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const oldAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clear(true, true, true);
    this.sky.sync(this.camera);
    renderer.render(this.sky.scene, this.sky.camera);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAuto;
  }
}

const VignetteShader = {
  name: 'VignetteShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uStrength: { value: 0.32 },
    uDamage: { value: 0 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStrength;
uniform float uDamage;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = vUv - 0.5;
  float v = smoothstep(0.28, 0.85, length(d * vec2(1.15, 1.0)));
  c.rgb *= 1.0 - v * uStrength;
  // warm ink-paper tint in the corners
  c.rgb = mix(c.rgb, c.rgb * vec3(1.02, 0.97, 0.9), v * 0.5);
  // damage flash (red rim)
  c.rgb = mix(c.rgb, vec3(0.6, 0.05, 0.04), v * uDamage * 0.8);
  gl_FragColor = c;
}`,
};

export interface PostOptions {
  bloom: boolean;
  vignette: boolean;
  msaa: number;
}

export class PostChain {
  readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly vignettePass: ShaderPass;
  private readonly outputPass: OutputPass;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly renderer: THREE.WebGLRenderer;
  /**
   * Bloom programs still to compile before the pass is switched on (after a
   * mid-match quality change) instead of all eight blocking the first bloom
   * frame (seconds on software GL / phones): see warmBloom().
   */
  private bloomWarm: { todo: THREE.ShaderMaterial[]; issued: WebGLProgram[] } | null = null;
  private warmMesh: THREE.Mesh | null = null;
  private readonly warmCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    renderer: THREE.WebGLRenderer,
    sky: SkyLayer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    opts: PostOptions,
  ) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: opts.msaa,
    });
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.addPass(new WorldPass(sky, scene, camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.45, 0.92);
    this.composer.addPass(this.bloomPass);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.vignettePass = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignettePass);
    this.configure(opts);
  }

  /**
   * Apply the options. `live` (a running match): turning bloom on compiles its
   * programs a few per frame first and enables the pass once they are ready.
   */
  configure(opts: PostOptions, live = false): void {
    if (opts.bloom && !this.bloomPass.enabled && live) {
      if (!this.bloomWarm) {
        const b = this.bloomPass;
        this.bloomWarm = { todo: [b.materialHighPassFilter, ...b.separableBlurMaterials, b.compositeMaterial, b.blendMaterial], issued: [] };
      }
    } else {
      this.bloomWarm = null;
      this.bloomPass.enabled = opts.bloom;
    }
    this.vignettePass.enabled = opts.vignette;
    if (this.target.samples !== opts.msaa) {
      this.target.samples = opts.msaa;
      this.composer.renderTarget1.samples = opts.msaa;
      this.composer.renderTarget2.samples = opts.msaa;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  /** 0..1 red damage vignette pulse. */
  setDamage(v: number): void {
    this.vignettePass.uniforms.uDamage.value = v;
  }

  /**
   * The target the world pass (sky + scene) draws into. Programs compiled ahead of
   * time must be compiled with it bound: tone mapping and output colour space are
   * part of every program's key, and the world is drawn linear into this HDR
   * target (OutputPass tone-maps afterwards) — compiled for the canvas, the
   * warm-up would build variants the first frame never uses.
   */
  get worldTarget(): THREE.WebGLRenderTarget {
    return this.composer.readBuffer;
  }

  /** true while bloom programs are still being compiled (bloom off meanwhile) */
  get bloomWarming(): boolean {
    return this.bloomWarm !== null;
  }

  render(dt: number): void {
    if (this.bloomWarm) this.warmBloom(this.bloomWarm);
    this.composer.render(dt);
  }

  /**
   * One step of the bloom warm-up, once per frame. Shader compiles run in the
   * GPU process; only querying a program blocks the main thread until it is
   * linked. With KHR_parallel_shader_compile every program is issued at once
   * and polled without blocking; without it one program is issued per frame and
   * queried the frame after (it had that frame to compile). Bloom is switched
   * on once every program is ready, so its first frame compiles nothing.
   */
  private warmBloom(w: { todo: THREE.ShaderMaterial[]; issued: WebGLProgram[] }): void {
    const r = this.renderer;
    const gl = r.getContext();
    const ext = r.extensions.has('KHR_parallel_shader_compile')
      ? (r.extensions.get('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number })
      : null;
    try {
      if (w.issued.length) {
        w.issued = w.issued.filter((p) => (ext ? gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR) !== true : (gl.getProgramParameter(p, gl.LINK_STATUS), false)));
        if (w.issued.length) return;
      }
      if (w.todo.length) {
        const known = new Set<unknown>(r.info.programs ?? []);
        // the same attributes as the passes' FullScreenQuad (position + uv): a normal
        // attribute would compile a different program variant (vertexNormals is in the
        // program key) and every bloom program would compile again on bloom's first frame
        const mesh = (this.warmMesh ??= new THREE.Mesh(fullscreenTriangle()));
        const prev = r.getRenderTarget();
        // the bloom pass draws into its own linear targets: compile that variant
        r.setRenderTarget(this.bloomPass.renderTargetBright);
        try {
          // without the extension: one new program per frame (programs already cached cost nothing)
          while (w.todo.length && (ext || !w.issued.length)) {
            mesh.material = w.todo.shift() as THREE.ShaderMaterial;
            r.compile(mesh, this.warmCam);
            for (const p of r.info.programs ?? []) {
              if (known.has(p)) continue;
              known.add(p);
              const prog = (p as { program?: WebGLProgram }).program;
              if (prog) w.issued.push(prog);
            }
          }
        } finally {
          r.setRenderTarget(prev);
        }
        if (w.issued.length || w.todo.length) return;
      }
    } catch (err) {
      console.warn('[render] bloom warm-up failed', err);
    }
    this.bloomWarm = null;
    this.bloomPass.enabled = true;
  }

  dispose(): void {
    this.bloomWarm = null;
    this.warmMesh?.geometry.dispose();
    this.warmMesh = null;
    this.bloomPass.dispose();
    this.vignettePass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}
