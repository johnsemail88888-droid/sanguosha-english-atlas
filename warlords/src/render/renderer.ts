// GameRenderer — the three.js presentation layer (GAME_SPEC §10, §12).
// Reads only ViewSource + static data + user settings; never mutates the sim.
//
// Frame order expected from the owner (game loop):
//   input.sample(renderer) → view.pushInput(frame) → view.update(dt) → renderer.frame(dt)
// frame() does NOT call view.update() unless constructed with { updateView: true }.
// GameRenderer is the ONLY consumer of view.drainEvents(); subscribe with onEvents().
import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { dirFromYawPitch } from '../core/math';
import type { EntityId, GameEvent, ViewEntity } from '../core/types';
import { VF_DANCING, VF_DEAD, VF_DOWNED, VF_STUNNED } from '../core/types';
import { WEAPON_BY_ID } from '../data';
import { settings, type Quality, type UserSettings } from '../game/settings';
import type { ViewSource } from './view';
import { HERO_VIEW_RANGE, qualityPreset, type QualityPreset } from './quality';
import { LocalFirePredictor, type LocalFireGate } from './localFire';
import { sharedUniforms, disposeSharedMaterials } from './core/materials';
import { SKY } from './palette';
import { createSkyLayer, type SkyLayer } from './scene/sky';
import { SceneLights, SUN_DIR } from './scene/lights';
import { buildTerrain, type TerrainMeshes } from './scene/terrain';
import { buildWater, type WaterMesh } from './scene/water';
import { PostChain } from './scene/post';
import { installSkyFog } from './scene/skyfog';
import { buildWorld, type WorldBuild } from './world/world';
import { FireSystem } from './world/fires';
import { GrassField } from './scene/grass';
import { PickWorld } from './camera/pick';
import { CameraOccluders } from './camera/camOccluders';
import { TpsCameraRig, tpsCameraPose, PITCH_LIMIT, adsPull } from './camera/tpsCamera';
import { EntityManager } from './entities/manager';
import type { EntityCtx } from './entities/context';
import { updateAuraShared } from './entities/auras';
import { Effects } from './vfx/effects';
import { handleEvents, shotClass } from './vfx/eventVfx';
import { ZoneVisual } from './vfx/zone';

export { registerAbilityVfx } from './vfx/abilities';
export type { AbilityVfxFn, AbilityVfxContext, AbilityEvent } from './vfx/abilities';

export interface GameRendererOptions {
  /** call view.update(dt) at the start of frame() (default false: the game loop owns it) */
  updateView?: boolean;
  /** initial quality (default: settings.quality) */
  quality?: Quality;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  entities: number;
  particles: number;
  fps: number;
  worldProps: number;
  worldChunks: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class GameRenderer {
  readonly camera: THREE.PerspectiveCamera;
  readonly view: ViewSource;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: GameRendererOptions;
  private readonly sky: SkyLayer;
  private readonly lights: SceneLights;
  private readonly terrain: TerrainMeshes;
  private readonly water: WaterMesh;
  private readonly world: WorldBuild;
  private readonly fires: FireSystem;
  private readonly grass: GrassField;
  private readonly post: PostChain;
  private readonly pickWorld: PickWorld;
  private readonly rig: TpsCameraRig;
  private readonly entities = new EntityManager();
  private readonly fx: Effects;
  private readonly zone: ZoneVisual;
  private readonly fog: THREE.Fog;
  private quality: Quality;
  private preset: QualityPreset;
  private size = { w: 1, h: 1 };
  private time = 0;
  private frameNo = 0;
  private fps = 60;
  private disposed = false;
  private contextLost = false;
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    console.warn('[render] WebGL context lost');
  };
  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.applyQuality();
    this.resize(this.size.w, this.size.h);
  };
  private unsubSettings: () => void;
  // local control (from InputController)
  private look = { yaw: 0, pitch: 0, ads: false, fire: false, fresh: false };
  private spectateId: EntityId | null = null;
  private freeCam: { pos: Vec3; yaw: number; pitch: number } | null = null;
  private readonly eventSubs = new Set<(evs: readonly GameEvent[]) => void>();
  private readonly fireSubs = new Set<(weaponId: string) => void>();
  // local fire prediction (muzzle / tracer / audio before the host confirms)
  private readonly firePredictor = new LocalFirePredictor();
  private readonly fireGate: LocalFireGate = { canShoot: false, reloading: false, noReload: false };
  private readonly fireWeapon = { id: '', slot: 0, mag: 0 };
  /** far plane actually in use (drawDistance, extended to keep far heroes on screen) */
  private farNow = 0;
  private ctx: EntityCtx | null = null;
  private damagePulse = 0;
  private lastLocalHp = -1;
  private squad = new Set<EntityId>();
  private zoomNow = 1;

  constructor(canvas: HTMLCanvasElement, view: ViewSource, opts: GameRendererOptions = {}) {
    this.canvas = canvas;
    this.view = view;
    this.opts = opts;
    const s = settings.get();
    this.quality = opts.quality ?? s.quality;
    this.preset = qualityPreset(this.quality);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA lives on the post-processing target
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = false;
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.camera = new THREE.PerspectiveCamera(s.fov, 1, 0.1, this.preset.drawDistance);
    this.rig = new TpsCameraRig(this.camera);
    this.rig.baseFov = s.fov;

    const map = view.map;
    installSkyFog(SUN_DIR);
    this.fog = new THREE.Fog(SKY.fog, this.preset.drawDistance * 0.35, this.preset.drawDistance * 0.95);
    this.scene.fog = this.fog;
    this.scene.background = null;
    this.sky = createSkyLayer(map.size, SUN_DIR);
    this.lights = new SceneLights(this.scene);
    this.terrain = buildTerrain(map);
    this.scene.add(this.terrain.group);
    this.water = buildWater(map, SUN_DIR);
    if (this.water.mesh) this.scene.add(this.water.mesh);
    this.world = buildWorld(map);
    this.scene.add(this.world.group);
    this.fires = new FireSystem(this.scene, this.world.fires);
    this.pickWorld = new PickWorld(map);
    // roof shells / under dock decks: the camera boom stops short of them (no black inside faces)
    this.pickWorld.setCameraOccluders(new CameraOccluders(this.world.cameraOccluders, map.size));
    this.grass = new GrassField(map, this.pickWorld);
    this.scene.add(this.grass.mesh);
    this.fx = new Effects(this.scene, this.preset.vfxLights);
    this.fx.groundY = (x, z) => this.pickWorld.groundHeight(x, z);
    this.fx.entityPos = (id, out) => {
      const c = this.entities.character(id);
      if (!c) return false;
      c.chestWorld(out);
      return true;
    };
    this.fx.shakeAt = (pos, intensity, radius) => this.shakeAt(pos, intensity, radius);
    this.scene.add(this.fx.group);
    this.scene.add(this.entities.group);
    this.zone = new ZoneVisual(map);
    this.scene.add(this.zone.group);
    this.post = new PostChain(this.renderer, this.sky, this.scene, this.camera, {
      bloom: this.preset.bloom,
      vignette: this.preset.post,
      msaa: this.preset.msaa,
    });
    this.applyQuality();
    const rect = canvas.getBoundingClientRect();
    this.resize(Math.max(1, rect.width || canvas.width), Math.max(1, rect.height || canvas.height));
    this.unsubSettings = settings.subscribe((u) => this.onSettings(u));
    // initial camera: orbit around the lord spawn
    const ls = map.lordSpawn;
    this.rig.orbit({ x: ls.x, y: ls.y, z: ls.z }, 60, 30, 0);
    this.rig.apply(0);
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /** Render one frame. dt = real seconds since the previous frame. */
  frame(dt: number): void {
    if (this.disposed) return;
    if (this.contextLost) {
      // keep draining so HUD / audio still get events while the GPU is gone
      const evs = this.view.drainEvents();
      if (evs.length) for (const cb of this.eventSubs) cb(evs);
      return;
    }
    const d = Math.min(0.1, Math.max(0, dt));
    if (this.opts.updateView) this.view.update(d);
    this.time += d;
    this.frameNo++;
    if (d > 0) this.fps += (1 / d - this.fps) * 0.05;
    sharedUniforms.uTime.value = this.time;
    updateAuraShared(this.time);

    const view = this.view;
    const localId = view.localId();
    const local = view.local();
    const localEnt = localId !== null ? view.get(localId) : undefined;
    this.squad.clear();
    if (local) for (const s of local.squad) this.squad.add(s.id);

    // 1. camera first (entities + nameplates read it)
    this.updateCamera(d, localEnt, local?.dead ?? false);

    // 2. entities
    const ctx = this.entityCtx(d, localId, local);
    ctx.focusPos = this.cameraFocus(localEnt);
    this.entities.sync(view.entities(), ctx);

    // fade the local hero when the camera is pushed into them (walls behind,
    // tight corners) and while aiming a magnifying weapon (the camera slides in)
    if (localEnt) {
      const lv = this.entities.character(localEnt.id);
      if (lv) {
        let fade = 1;
        if (this.rig.mode === 'follow') {
          const d = this.camera.position.distanceTo(_v.set(localEnt.x, localEnt.y + 1.5, localEnt.z));
          const near = Math.min(1, Math.max(0, (d - 0.55) / 0.9));
          const ads = 1 - 0.7 * Math.min(1, Math.max(0, (adsPull(this.zoomNow) - 0.5) / 0.5)) * this.rig.adsBlend;
          fade = Math.min(near, ads);
        }
        lv.rig.setFade(fade);
        lv.rig.setLocalView(this.rig.mode === 'follow');
      }
    }

    // 3. events → VFX, then re-emit to subscribers
    let evs = view.drainEvents();
    if (this.injected.length) {
      evs = evs.length ? [...evs, ...this.injected] : this.injected;
      this.injected = [];
    }
    if (evs.length) {
      handleEvents(evs, {
        fx: this.fx,
        entities: this.entities,
        localId,
        consumePredictedShot: (weaponId) => this.firePredictor.confirmHostShot(this.time, weaponId),
        lang: settings.get().lang,
        time: this.time,
        camPos: this.camera.position,
      });
      this.trackLocalDamage(evs, localId);
    }

    // 4. local fire feedback (instant muzzle / tracer, audio hook)
    this.localFire(d, localEnt, local);

    // 5. world systems
    const focus = localEnt ? _v.set(localEnt.x, localEnt.y, localEnt.z) : _v.copy(this.camera.position);
    this.lights.follow(focus);
    this.fires.update(d, this.camera.position, this.time);
    this.grass.update(this.camera.position);
    this.zone.update(view.zone(), this.camera.position, d);
    this.fx.update(d);
    this.damagePulse = Math.max(0, this.damagePulse - d * 1.6);
    this.post.setDamage(this.damagePulse * 0.9 + (local?.downed ? 0.55 + 0.15 * Math.sin(this.time * 4) : 0));

    // 6. render (far plane stretched so no hero within weapon range is clipped)
    this.updateFarPlane(localId);
    this.renderer.info.reset();
    this.post.render(d);

    if (evs.length) {
      for (const cb of this.eventSubs) {
        try {
          cb(evs);
        } catch (err) {
          console.error('[render] onEvents subscriber failed', err);
        }
      }
    }
  }

  /**
   * Loading-screen warm-up: create the visuals for the entities that exist now
   * and compile every shader program the scene can use (hidden VFX pools and the
   * translucent character variant included), so the first rendered frames do
   * not stall on shader compilation. With KHR_parallel_shader_compile the GPU
   * compiles in the background; without it (SwiftShader, some drivers) the scene
   * is compiled in batches and each batch's programs are linked right away, with
   * a yield to the event loop in between — no single multi-second freeze (network
   * keep-alives and the loading bar keep running). `onProgress` gets 0..1.
   */
  async warmup(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.disposed || this.contextLost) return;
    const view = this.view;
    const localId = view.localId();
    const local = view.local();
    const localEnt = localId !== null ? view.get(localId) : undefined;
    this.updateCamera(0, localEnt, local?.dead ?? false);
    const ctx = this.entityCtx(0, localId, local);
    ctx.focusPos = this.cameraFocus(localEnt);
    this.entities.sync(view.entities(), ctx);
    // every object visible for the compile (pools / hidden meshes still need their programs)
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    // translucent variant of the character material (near-camera / stealth fade)
    let faded: { setFade(a: number): void } | null = null;
    this.entities.forEachCharacter((v) => {
      if (!faded && v.id !== localId) faded = v.rig;
    });
    const fadedRig = faded as { setFade(a: number): void } | null;
    fadedRig?.setFade(0.5);
    const restore = (): void => {
      for (const o of hidden) o.visible = false;
      fadedRig?.setFade(1);
    };
    try {
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) {
        await this.renderer.compileAsync(this.scene, this.camera);
        onProgress?.(1);
        return;
      }
      // batches: the scene's top-level objects, big groups split into their children
      const batches: THREE.Object3D[] = [];
      for (const c of this.scene.children) {
        if ((c as THREE.Light).isLight) continue;
        if (c.children.length > 6) batches.push(...c.children);
        else batches.push(c);
      }
      const gl = this.renderer.getContext();
      const linked = new Set<unknown>(this.renderer.info.programs ?? []);
      let lastYield = performance.now();
      for (let i = 0; i < batches.length; i++) {
        this.renderer.compile(batches[i], this.camera, this.scene);
        // link the new programs now (blocks until each is ready) instead of at the first draw
        for (const p of this.renderer.info.programs ?? []) {
          if (linked.has(p)) continue;
          linked.add(p);
          const prog = (p as { program?: WebGLProgram }).program;
          if (prog) gl.getProgramParameter(prog, gl.LINK_STATUS);
        }
        onProgress?.((i + 1) / batches.length);
        if (performance.now() - lastYield > 120) {
          await new Promise<void>((r) => setTimeout(r, 0));
          lastYield = performance.now();
          if (this.disposed || this.contextLost) return;
        }
      }
    } catch (err) {
      console.warn('[render] shader warm-up failed', err);
    } finally {
      restore();
    }
  }

  resize(w: number, h: number): void {
    this.size = { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.post.setSize(this.size.w, this.size.h, pr);
    this.camera.aspect = this.size.w / this.size.h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.preset = qualityPreset(q);
    this.applyQuality();
    this.resize(this.size.w, this.size.h);
  }

  /**
   * Crosshair query: ray from the (latest) camera through the screen centre
   * against colliders + terrain + water + entities (render meshes are ignored).
   */
  pick(): { aimPoint: Vec3; aimTargetId?: EntityId } {
    const localId = this.view.localId();
    const ent = localId !== null ? this.view.get(localId) : undefined;
    let origin: Vec3;
    let dir: Vec3;
    let minDist = 0;
    if (ent && this.freeCam === null && !(ent.flags & VF_DEAD)) {
      // canonical pose from the freshest look angles (not last frame's camera)
      const yaw = this.look.fresh ? this.look.yaw : ent.yaw;
      const pitch = this.look.fresh ? this.look.pitch : ent.pitch;
      const pose = tpsCameraPose(ent, yaw, pitch, (ent.flags & VF_DOWNED) !== 0);
      origin = pose.origin;
      dir = pose.dir;
      minDist = Math.max(0, pose.nearClip - 0.3);
    } else {
      const p = this.camera.position;
      this.camera.getWorldDirection(_dir);
      origin = { x: p.x, y: p.y, z: p.z };
      dir = { x: _dir.x, y: _dir.y, z: _dir.z };
    }
    const maxDist = 600;
    const hit = this.pickWorld.raycast(origin, dir, maxDist, {
      entities: this.view.entities(),
      ignore: localId,
      minDist,
      maxUnitDist: this.preset.characterDistance,
    });
    if (!hit) return { aimPoint: { x: origin.x + dir.x * maxDist, y: origin.y + dir.y * maxDist, z: origin.z + dir.z * maxDist } };
    return hit.entityId !== undefined ? { aimPoint: hit.point, aimTargetId: hit.entityId } : { aimPoint: hit.point };
  }

  getCameraPose(): { pos: Vec3; yaw: number; pitch: number } {
    return this.rig.pose();
  }

  setSpectateTarget(id: EntityId | null): void {
    this.spectateId = id;
  }

  onLocalFire(cb: (weaponId: string) => void): () => void {
    this.fireSubs.add(cb);
    return () => this.fireSubs.delete(cb);
  }

  /** Every drained GameEvent batch is re-emitted here once per frame (HUD, audio, kill feed). */
  onEvents(cb: (evs: readonly GameEvent[]) => void): () => void {
    this.eventSubs.add(cb);
    return () => this.eventSubs.delete(cb);
  }

  /** Add camera shake (0..1 trauma). */
  shake(intensity: number): void {
    this.rig.shake.add(intensity);
  }

  /**
   * Latest local look state (called by InputController.sample every frame so
   * the camera and pick() use this frame's yaw/pitch, not the last snapshot's).
   */
  setLookAngles(yaw: number, pitch: number, ads = false, fireHeld = false): void {
    this.look.yaw = yaw;
    this.look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    this.look.ads = ads;
    this.look.fire = fireHeld;
    this.look.fresh = true;
  }

  /** ADS zoom of the local hero's active weapon when aiming (1 otherwise). UI draws a scope when ≥ 3. */
  get adsZoom(): number {
    const local = this.view.local();
    if (!local || !this.look.ads) return 1;
    const w = local.weapons[local.activeSlot];
    return (w && WEAPON_BY_ID[w.id]?.adsZoom) || 1;
  }

  /** Current (smoothed) zoom applied to the camera FOV. */
  get currentZoom(): number {
    return this.zoomNow;
  }

  /** Project a world point to CSS pixels relative to the canvas (null when behind the camera / off-screen far). */
  worldToScreen(p: Vec3): { x: number; y: number } | null {
    _v.set(p.x, p.y, p.z).project(this.camera);
    if (_v.z < -1 || _v.z > 1) return null;
    return { x: ((_v.x + 1) / 2) * this.size.w, y: ((1 - _v.y) / 2) * this.size.h };
  }

  /** Dev / photo mode: fly camera (null returns to normal behaviour). */
  setFreeCamera(pose: { pos: Vec3; yaw: number; pitch: number } | null): void {
    this.freeCam = pose ? { pos: { ...pose.pos }, yaw: pose.yaw, pitch: pose.pitch } : null;
  }

  stats(): RenderStats {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      entities: this.entities.size,
      particles: this.fx.add.liveCount + this.fx.alpha.liveCount,
      fps: Math.round(this.fps),
      worldProps: this.world.stats.props,
      worldChunks: this.world.stats.chunks,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.unsubSettings();
    this.eventSubs.clear();
    this.fireSubs.clear();
    this.entities.dispose();
    this.fx.dispose();
    this.zone.dispose();
    this.fires.dispose();
    this.grass.dispose();
    this.world.dispose();
    this.water.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.post.dispose();
    disposeSharedMaterials();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private pixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(this.preset.maxPixelRatio, dpr * this.preset.pixelRatioScale);
  }

  private applyQuality(): void {
    const p = this.preset;
    const shadowsChanged = this.renderer.shadowMap.enabled !== p.shadows;
    this.renderer.shadowMap.enabled = p.shadows;
    this.lights.setShadows(p.shadows, p.shadowMapSize, p.shadowExtent);
    if (shadowsChanged) this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((mm) => (mm.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
    this.farNow = p.drawDistance;
    this.camera.far = p.drawDistance;
    this.camera.updateProjectionMatrix();
    this.fog.near = p.drawDistance * 0.35;
    this.fog.far = p.drawDistance * 0.95;
    this.fires.setLightCount(p.brazierLights);
    this.grass.setDensity(p.grass);
    this.fx.setBudget(p.particles, p.vfxLights);
    this.post.configure({ bloom: p.bloom, vignette: p.post, msaa: p.msaa });
  }

  private onSettings(u: UserSettings): void {
    if (u.quality !== this.quality) this.setQuality(u.quality);
    this.rig.baseFov = u.fov;
  }

  private entityCtx(dt: number, localId: EntityId | null, local: ReturnType<ViewSource['local']>): EntityCtx {
    // one context object for the renderer's lifetime (mutated per frame, no per-frame closures)
    let c = this.ctx;
    if (!c) {
      c = this.ctx = {
        time: 0,
        dt: 0,
        camPos: this.camera.position,
        fovDeg: this.camera.fov,
        localId: null,
        local: null,
        squad: this.squad,
        lang: settings.get().lang,
        fx: this.fx,
        blocked: (a, b) => this.pickWorld.segmentBlocked(a, b),
        groundY: (x, z) => this.pickWorld.groundHeight(x, z),
        characterDistance: this.preset.characterDistance,
        badges: this.entities.badges,
        shadows: this.preset.shadows,
        frame: 0,
      };
    }
    c.time = this.time;
    c.dt = dt;
    c.fovDeg = this.camera.fov;
    c.camDir = this.camera.getWorldDirection(this.camDirVec);
    c.localId = localId;
    c.local = local;
    c.lang = settings.get().lang;
    c.characterDistance = this.preset.characterDistance;
    c.shadows = this.preset.shadows;
    c.frame = this.frameNo;
    return c;
  }

  /**
   * Heroes are never distance-culled (at most 8): when a non-local hero within
   * HERO_VIEW_RANGE stands beyond the preset draw distance, the far plane is
   * stretched to include it, so the world in between still occludes it (no
   * see-through-hills on low quality) and every preset sees the same heroes.
   * Character materials clamp their fog (see scene/skyfog.ts FOG_MAX).
   */
  private updateFarPlane(localId: EntityId | null): void {
    const base = this.preset.drawDistance;
    let need = base;
    const cam = this.camera.position;
    for (const e of this.view.entities()) {
      if (e.kind !== 'hero' || e.id === localId || e.flags & VF_DEAD) continue;
      const d = Math.hypot(e.x - cam.x, e.y - cam.y, e.z - cam.z);
      if (d > need - 12 && d <= HERO_VIEW_RANGE) need = d + 12;
    }
    // quantise so the projection is not rebuilt every frame while someone walks
    const far = need > base ? Math.ceil(need / 20) * 20 : base;
    if (far !== this.farNow) {
      this.farNow = far;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateCamera(dt: number, localEnt: ViewEntity | undefined, localDead: boolean): void {
    const rig = this.rig;
    if (this.freeCam) {
      rig.setPose(this.freeCam.pos, this.freeCam.yaw, this.freeCam.pitch);
      rig.setZoom(1, dt);
    } else if (localEnt && !localDead && !(localEnt.flags & VF_DEAD)) {
      const yaw = this.look.fresh ? this.look.yaw : localEnt.yaw;
      const pitch = this.look.fresh ? this.look.pitch : localEnt.pitch;
      rig.mode = 'follow';
      const zoom = this.adsZoom;
      rig.follow(this.pickWorld, localEnt, yaw, pitch, dt, false, (localEnt.flags & VF_DOWNED) !== 0, zoom);
      rig.setZoom(zoom, dt);
    } else {
      // dead / not spawned: spectate a target or orbit
      const target = this.spectateId !== null ? this.view.get(this.spectateId) : undefined;
      if (target && !(target.flags & VF_DEAD)) {
        rig.mode = 'spectate';
        rig.follow(this.pickWorld, target, target.yaw, target.pitch * 0.5, dt, true, (target.flags & VF_DOWNED) !== 0);
      } else {
        rig.mode = 'orbit';
        const c = localEnt ?? this.view.map.lordSpawn;
        rig.orbit({ x: c.x, y: c.y, z: c.z }, localEnt ? 9 : 60, localEnt ? 5 : 32, dt);
      }
      rig.setZoom(1, dt);
    }
    this.zoomNow = rig.currentZoom;
    rig.apply(dt);
  }

  private readonly focusVec = new THREE.Vector3();
  private readonly camDirVec = new THREE.Vector3();
  private injected: GameEvent[] = [];

  /**
   * Debug / tests: handle these events next frame exactly like drained ones
   * (VFX + re-emitted to HUD / audio subscribers). Never used by gameplay.
   */
  injectEvents(evs: readonly GameEvent[]): void {
    for (const e of evs) this.injected.push(e);
  }

  /** Chest of the hero the camera is following (for the near-camera fade), null otherwise. */
  private cameraFocus(localEnt: ViewEntity | undefined): THREE.Vector3 | null {
    if (this.freeCam) return null;
    let e: ViewEntity | undefined;
    if (this.rig.mode === 'follow') e = localEnt;
    else if (this.rig.mode === 'spectate' && this.spectateId !== null) e = this.view.get(this.spectateId);
    if (!e) return null;
    const downed = (e.flags & VF_DOWNED) !== 0;
    return this.focusVec.set(e.x, e.y + (downed ? 0.5 : 1.3), e.z);
  }

  private shakeAt(pos: THREE.Vector3, intensity: number, radius: number): void {
    const dist = pos.distanceTo(this.camera.position);
    const falloff = Math.max(0, 1 - dist / (radius * 6 + 12));
    if (falloff > 0) this.rig.shake.add(intensity * falloff);
  }

  private trackLocalDamage(evs: readonly GameEvent[], localId: EntityId | null): void {
    if (localId === null) return;
    for (const ev of evs) {
      if (ev.t === 'hit' && ev.target === localId && !ev.blocked && ev.amount > 0) {
        this.damagePulse = Math.min(1, this.damagePulse + Math.min(0.6, ev.amount / 120));
        this.rig.shake.add(Math.min(0.25, ev.amount / 300));
      }
    }
  }

  /**
   * Instant local muzzle flash + tracer (+ onLocalFire for audio) for the
   * shots the host is about to fire — see LocalFirePredictor for the gating.
   */
  private localFire(dt: number, ent: ViewEntity | undefined, local: ReturnType<ViewSource['local']>): void {
    const held = this.look.fire;
    const w = local ? local.weapons[local.activeSlot] : null;
    const gate = this.fireGate;
    gate.canShoot = false;
    gate.reloading = false;
    gate.noReload = false;
    if (ent && local && !local.dead && !local.downed && !(ent.flags & (VF_DEAD | VF_DOWNED | VF_STUNNED | VF_DANCING))) {
      gate.canShoot = true;
      for (const st of local.statuses) {
        if (st.remaining <= 0) continue;
        if (st.id === 'disarm' || st.id === 'stun' || st.id === 'dance') gate.canShoot = false;
        else if (st.id === 'noReload') gate.noReload = true;
      }
      gate.reloading = local.reloading > 0;
    }
    let weapon: { id: string; slot: number; mag: number } | null = null;
    if (w && local) {
      weapon = this.fireWeapon;
      weapon.id = w.id;
      weapon.slot = local.activeSlot;
      weapon.mag = w.mag;
    }
    const def = w ? WEAPON_BY_ID[w.id] : undefined;
    const shots = this.firePredictor.update(this.time, dt, held, weapon, def, gate);
    if (shots <= 0 || !ent || !w) return;
    const view = this.entities.character(ent.id);
    const cls = shotClass(w.id);
    const aim = this.pick().aimPoint;
    const muzzle = _v2;
    if (!view || !view.muzzleWorld(muzzle)) muzzle.set(ent.x, ent.y + 1.4, ent.z);
    const d = dirFromYawPitch(this.look.fresh ? this.look.yaw : ent.yaw, this.look.fresh ? this.look.pitch : ent.pitch);
    _dir.set(d.x, d.y, d.z);
    for (let s = 0; s < shots; s++) {
      this.fx.muzzleFlash(muzzle, _dir, cls, s === 0);
      if (!def?.projectile && !def?.melee) {
        const pellets = Math.min(4, def?.pellets ?? 1);
        for (let i = 0; i < pellets; i++) {
          const spread = pellets > 1 ? 0.6 : 0;
          _v.set(aim.x + (Math.random() - 0.5) * spread, aim.y + (Math.random() - 0.5) * spread, aim.z + (Math.random() - 0.5) * spread);
          this.fx.tracer(muzzle, _v, cls);
        }
      }
      view?.onShot();
      const kick = Math.min(0.05, ((def?.recoil ?? 1) * Math.PI) / 180);
      this.rig.shake.kick(kick * 0.6, (Math.random() - 0.5) * kick * 0.3);
      for (const cb of this.fireSubs) {
        try {
          cb(w.id);
        } catch (err) {
          console.error('[render] onLocalFire subscriber failed', err);
        }
      }
    }
  }
}
