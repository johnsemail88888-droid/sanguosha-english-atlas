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
import { HERO_VIEW_RANGE, qualityPreset, type CharacterArt, type QualityPreset } from './quality';
import { AdaptiveResolution, adaptiveFloor } from './adaptiveRes';
import { LocalFirePredictor, type LocalFireGate } from './localFire';
import { sharedUniforms, disposeSharedMaterials } from './core/materials';
import { SKY } from './palette';
import { createSkyLayer, type SkyLayer } from './scene/sky';
import { SceneLights, SUN_DIR } from './scene/lights';
import { buildTerrain, type TerrainMeshes } from './scene/terrain';
import { displayMap } from './scene/rimShape';
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
import { preloadCharacterArt } from './models/preload';
import { evictUnusedTemplates } from './models/glb';
import { setWorldArtQuality, worldTexturesSettled } from './core/worldArt';
import { releaseObjectGeometryCache } from './entities/objects';
import { releaseModelCaches } from './models';
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
  /** lower the pixel ratio while frames are slow, raise it again when fast (default true) */
  adaptiveResolution?: boolean;
  /**
   * A quality switch during a match is applied in stages (default true): see
   * setQuality(). false: all at once, in the next frame (dev A/B only).
   */
  stagedQualitySwitch?: boolean;
}

/** Order of the character-art tiers (a switch to a higher one preloads its models first). */
const ART_RANK: Record<CharacterArt, number> = { none: 0, heroes: 1, all: 2 };

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
  /** pixel ratio the canvas renders at now (adaptive resolution) */
  pixelRatio: number;
  /** the quality preset's pixel ratio on this device (the adaptive ceiling) */
  pixelRatioMax: number;
  /** smoothed real frame time (ms) the adaptive resolution reacts to */
  frameMs: number;
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
  /** pixel ratio controller (frame time → canvas resolution) */
  private readonly adaptive = new AdaptiveResolution();
  private lastFrameAt = -1;
  /**
   * Point lights allocated to braziers / VFX flashes. Their number is part of
   * every lit shader program's key: changing it mid-match recompiles every
   * material (5–15 s on software GL, seconds on phones) — see applyQuality().
   */
  private lightSlots: { fires: number; vfx: number } | null = null;
  /** the tier asked for last (the one in use until a staged switch reaches it) */
  private wantedQuality: Quality;
  /** a staged quality switch is running (qualityApplying) */
  private applyingQuality = false;
  /** bumped by every switch: a superseded staged switch stops at its next step */
  private qualitySeq = 0;
  /** keep the last picture on screen while a switch compiles the scene's programs */
  private holdRender = false;
  private readonly applyingSubs = new Set<(applying: boolean) => void>();

  constructor(canvas: HTMLCanvasElement, view: ViewSource, opts: GameRendererOptions = {}) {
    this.canvas = canvas;
    this.view = view;
    this.opts = opts;
    const s = settings.get();
    this.quality = opts.quality ?? s.quality;
    this.wantedQuality = this.quality;
    this.preset = qualityPreset(this.quality);
    this.adaptive.enabled = opts.adaptiveResolution !== false;
    // world-art texture sizes / low-tier shaders follow the tier in use (incl. opts.quality)
    setWorldArtQuality(this.quality);
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
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);

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
    // ground visuals follow the displayed rim shape (scene/rimShape.ts); pick / camera keep the sim heights
    this.grass = new GrassField(displayMap(map), this.pickWorld);
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
    this.zone = new ZoneVisual(displayMap(map));
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
    // (frames that hold the picture during a quality switch are no frame-rate sample)
    if (this.holdRender) this.lastFrameAt = -1;
    else this.adaptResolution();
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
    // (a staged quality switch holds the last picture while it compiles the scene)
    if (!this.holdRender) {
      this.renderer.info.reset();
      this.post.render(d);
    }

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
   * keep-alives and the loading bar keep running). `onProgress` gets 0..1 and
   * the stage: AI-art models (characters, prop models, world textures), then shaders.
   */
  async warmup(onProgress?: (fraction: number, stage: 'models' | 'shaders') => void): Promise<void> {
    if (this.disposed || this.contextLost) return;
    const view = this.view;
    // AI-art world (prop models + decoded texture arrays) in parallel with the
    // character bodies, capped at 8 s: prop programs are compiled below and the
    // first frames show the textured world instead of placeholders popping in
    let artTimer: ReturnType<typeof setTimeout> | undefined;
    const worldArt = Promise.race([
      this.world.artReady.then(() => worldTexturesSettled()),
      new Promise<void>((r) => (artTimer = setTimeout(r, 8000))),
    ]);
    // AI-art character bodies first (0 → 0.45 of the bar): the views created below
    // then start with their GLB body and its shaders get compiled with the rest
    const heroIds = new Set<string>();
    for (const p of view.players()) heroIds.add(p.heroId);
    for (const e of view.entities()) if (e.kind === 'hero') heroIds.add(e.sub);
    await preloadCharacterArt(heroIds, (f) => onProgress?.(0.45 * f, 'models'), this.preset.glbCharacters);
    await worldArt;
    clearTimeout(artTimer);
    if (this.disposed || this.contextLost) return;
    const shaderProgress = onProgress ? (f: number): void => onProgress(0.45 + 0.55 * f, 'shaders') : undefined;
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
      // the sky layer's own programs (its scene: no lights in their keys)
      this.forWorldTarget(() => this.renderer.compile(this.sky.scene, this.sky.camera));
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) {
        await this.forWorldTarget(() => this.renderer.compileAsync(this.scene, this.camera));
        shaderProgress?.(1);
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
        this.forWorldTarget(() => this.renderer.compile(batches[i], this.camera, this.scene));
        // link the new programs now (blocks until each is ready) instead of at the first draw
        for (const p of this.renderer.info.programs ?? []) {
          if (linked.has(p)) continue;
          linked.add(p);
          const prog = (p as { program?: WebGLProgram }).program;
          if (prog) gl.getProgramParameter(prog, gl.LINK_STATUS);
        }
        shaderProgress?.((i + 1) / batches.length);
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
      // one hidden draw: the shadow pass's depth programs and every vertex buffer / texture
      // upload, instead of in the first visible frame
      if (!this.disposed && !this.contextLost) this.prerender();
    }
  }

  resize(w: number, h: number): void {
    if (this.disposed) return;
    this.size = { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
    // same ceiling (plain window resize): the adapted ratio is kept
    this.adaptive.setRange(this.pixelRatio(), adaptiveFloor(this.quality));
    this.applySize();
    this.camera.aspect = this.size.w / this.size.h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Switch the graphics tier. Before the first frame (menus, loading screen) it
   * applies at once — the loading warm-up compiles everything anyway. During a
   * match it is staged so no single frame carries the whole switch (it used to
   * freeze for seconds, much longer with the AI art):
   *   1. the new tier's character art (troop / NPC models when leaving 流畅) is
   *      fetched, decoded and prepared while the old tier keeps drawing;
   *   2. the tier switches; when that recompiles materials (shadows toggled, the
   *      character art or the ground shader changed) the last picture stays on
   *      screen while the scene's programs compile in batches, yielding to the
   *      event loop in between (network, HUD and input keep running);
   *   3. textures the new tier shows first (new bodies…) upload a few at a time;
   *   4. bloom's programs compile one per frame and it turns on when they are ready.
   * qualityApplying is true from the call until the end of 4 (onQualityApplying
   * reports both edges): the UI shows 「应用中…」 meanwhile.
   */
  setQuality(q: Quality): void {
    if (this.disposed || q === this.wantedQuality) return;
    this.wantedQuality = q;
    if (this.frameNo === 0 || this.opts.stagedQualitySwitch === false) {
      this.qualitySeq++;
      this.holdRender = false;
      this.switchQuality(q);
      this.setApplying(false);
      return;
    }
    void this.applyQualityStaged(q);
  }

  /** True while a quality switch is being applied (UI: 「应用中…」). */
  get qualityApplying(): boolean {
    return this.applyingQuality;
  }

  /** Called with true when a staged quality switch starts and false when it has fully applied. */
  onQualityApplying(cb: (applying: boolean) => void): () => void {
    if (this.disposed) return () => false;
    this.applyingSubs.add(cb);
    return () => this.applyingSubs.delete(cb);
  }

  /**
   * Crosshair query: ray from the (latest) camera through the screen centre
   * against colliders + terrain + water + entities (render meshes are ignored).
   */
  pick(): { aimPoint: Vec3; aimTargetId?: EntityId } {
    if (this.disposed) return { aimPoint: { x: 0, y: 0, z: 0 } };
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
    if (this.disposed) return () => false;
    this.fireSubs.add(cb);
    return () => this.fireSubs.delete(cb);
  }

  /** Every drained GameEvent batch is re-emitted here once per frame (HUD, audio, kill feed). */
  onEvents(cb: (evs: readonly GameEvent[]) => void): () => void {
    if (this.disposed) return () => false;
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
    if (this.disposed) return 1;
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
    if (this.disposed) {
      return { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, entities: 0, particles: 0, fps: 0, worldProps: 0, worldChunks: 0, pixelRatio: 0, pixelRatioMax: 0, frameMs: 0 };
    }
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
      pixelRatio: this.adaptive.ratio,
      pixelRatioMax: this.adaptive.ceil,
      frameMs: Math.round(this.adaptive.frameMs * 10) / 10,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubSettings();
    this.eventSubs.clear();
    this.fireSubs.clear();
    this.qualitySeq++;
    this.applyingSubs.clear();
    this.entities.dispose();
    // the match's character models (textures ~5 MB each) go with it; the next match reloads from the HTTP cache
    evictUnusedTemplates();
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
    this.releaseMatchData();
    // shared geometry caches filled by this match (bodies, body+weapon merges, weapons, loot)
    releaseModelCaches();
    releaseObjectGeometryCache();
  }

  /**
   * After dispose(): drop every reference to the match — scene graph, world /
   * terrain / grass buffers, the pick world (map arrays), entity views, the
   * view source (sim / session) and the per-frame context — so that even a
   * leaked reference to this renderer (a HUD closure that outlived the match)
   * cannot keep the last match's geometry alive.
   */
  private releaseMatchData(): void {
    this.scene.clear();
    this.injected = [];
    this.squad.clear();
    this.ctx = null;
    const self = this as unknown as Record<string, unknown>;
    for (const k of ['view', 'world', 'terrain', 'water', 'grass', 'fires', 'sky', 'post', 'pickWorld', 'fx', 'zone', 'lights', 'fog']) self[k] = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The quality preset's pixel ratio on this device: the adaptive resolution's ceiling. */
  private pixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(this.preset.maxPixelRatio, dpr * this.preset.pixelRatioScale);
  }

  /** Size the canvas / post targets at the adaptive pixel ratio. */
  private applySize(): void {
    const pr = this.adaptive.ratio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.post.setSize(this.size.w, this.size.h, pr);
  }

  /**
   * Feed the real interval since the previous frame to the adaptive resolution
   * (smoothed frame time > 33 ms for 3 s → one step down, fast again for a while
   * → one step up) and re-size the canvas when it moved.
   */
  private adaptResolution(): void {
    const now = performance.now();
    const prev = this.lastFrameAt;
    this.lastFrameAt = now;
    if (prev < 0) return;
    const s = (now - prev) / 1000;
    // real frame rate (the game loop clamps dt to 0.1 s: that would never read below 10 fps)
    if (s > 0 && s < this.adaptive.opts.pauseS) this.fps += (1 / s - this.fps) * (1 - Math.exp(-s / 0.5));
    if (this.adaptive.update(s)) this.applySize();
  }

  /** A hidden tab stops the frame loop: the gap until it is visible again is not a slow frame. */
  private readonly onVisibility = (): void => {
    this.lastFrameAt = -1;
    this.adaptive.restart();
  };

  /** Make `q` the tier in use (everything at once). */
  private switchQuality(q: Quality): void {
    this.quality = q;
    this.preset = qualityPreset(q);
    setWorldArtQuality(q);
    this.applyQuality();
    this.resize(this.size.w, this.size.h);
  }

  private setApplying(on: boolean): void {
    if (on === this.applyingQuality) return;
    this.applyingQuality = on;
    for (const cb of this.applyingSubs) {
      try {
        cb(on);
      } catch (err) {
        console.error('[render] onQualityApplying subscriber failed', err);
      }
    }
  }

  /** The staged mid-match switch (see setQuality). A newer switch or dispose() stops it at its next step. */
  private async applyQualityStaged(q: Quality): Promise<void> {
    const seq = ++this.qualitySeq;
    const live = (): boolean => seq === this.qualitySeq && !this.disposed && !this.contextLost;
    this.setApplying(true);
    try {
      const next = qualityPreset(q);
      // 1. the new tier's character art, loaded while the old tier keeps drawing
      if (ART_RANK[next.glbCharacters] > ART_RANK[this.preset.glbCharacters]) {
        const heroIds = new Set<string>();
        for (const p of this.view.players()) heroIds.add(p.heroId);
        for (const e of this.view.entities()) if (e.kind === 'hero') heroIds.add(e.sub);
        await preloadCharacterArt(heroIds, undefined, next.glbCharacters);
        if (!live()) return;
      }
      // 2. switch; recompiles happen behind the held picture, in batches
      const recompiles =
        next.shadows !== this.renderer.shadowMap.enabled ||
        next.glbCharacters !== this.preset.glbCharacters ||
        (q === 'low') !== (this.quality === 'low'); // the textured ground's cheap variant (terrain.ts GROUND_LQ)
      this.switchQuality(q);
      if (recompiles) {
        this.holdRender = true;
        await this.compileSceneBatched(live);
        if (!live()) return;
      }
      // 3. uploads the first new frames would otherwise do all at once
      await this.uploadPendingTextures(live);
      if (!live()) return;
      if (recompiles) {
        // one hidden draw into a tiny target: the shadow pass's depth programs, new
        // vertex buffers (the swapped-in bodies) — still behind the held picture
        await new Promise<void>((res) => setTimeout(res, 0));
        if (!live()) return;
        this.prerender();
      }
      this.holdRender = false;
      // 4. bloom switches on once its programs are compiled (PostChain: one per frame)
      for (let i = 0; i < 400 && this.post.bloomWarming; i++) {
        await new Promise<void>((r) => setTimeout(r, 50));
        if (!live()) return;
      }
    } catch (err) {
      console.warn('[render] quality switch failed', err);
    } finally {
      if (seq === this.qualitySeq) {
        this.holdRender = false;
        this.setApplying(false);
      }
    }
  }

  /**
   * Compile (and link) every program the scene uses now, a batch of objects at a
   * time with a yield in between (the loading warm-up's scheme, for a running
   * match). With KHR_parallel_shader_compile the driver compiles in the background.
   */
  private async compileSceneBatched(live: () => boolean): Promise<void> {
    const r = this.renderer;
    if (r.extensions.has('KHR_parallel_shader_compile')) {
      await this.forWorldTarget(() => r.compileAsync(this.scene, this.camera));
      return;
    }
    const batches: THREE.Object3D[] = [];
    for (const c of this.scene.children) {
      if ((c as THREE.Light).isLight) continue;
      if (c.children.length > 6) batches.push(...c.children);
      else batches.push(c);
    }
    const gl = r.getContext();
    const linked = new Set<unknown>(r.info.programs ?? []);
    let lastYield = performance.now();
    for (const b of batches) {
      // (compile() visits hidden objects too: VFX pools, far LODs)
      this.forWorldTarget(() => r.compile(b, this.camera, this.scene));
      for (const p of r.info.programs ?? []) {
        if (linked.has(p)) continue;
        linked.add(p);
        const prog = (p as { program?: WebGLProgram }).program;
        if (prog) gl.getProgramParameter(prog, gl.LINK_STATUS);
      }
      if (performance.now() - lastYield > 100) {
        await new Promise<void>((res) => setTimeout(res, 0));
        lastYield = performance.now();
        if (!live()) return;
      }
    }
  }

  /** Draw the scene once into a 4×4 target (same program variants as the world pass): see applyQualityStaged. */
  private prerender(): void {
    const r = this.renderer;
    const t = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    const prev = r.getRenderTarget();
    r.setRenderTarget(t);
    try {
      r.clear(true, true, false);
      r.render(this.scene, this.camera);
    } catch (err) {
      console.warn('[render] quality pre-render failed', err);
    } finally {
      r.setRenderTarget(prev);
      t.dispose();
    }
  }

  /** Run a compile with the world pass's target bound (the program variants the frames use: PostChain.worldTarget). */
  private forWorldTarget<T>(fn: () => T): T {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.post.worldTarget);
    try {
      return fn();
    } finally {
      r.setRenderTarget(prev);
    }
  }

  /** Upload the scene's textures that are not on the GPU yet (or changed), a few per event-loop turn. */
  private async uploadPendingTextures(live: () => boolean): Promise<void> {
    const r = this.renderer;
    const props = r.properties as unknown as { get(o: object): { __version?: number } };
    const todo = new Set<THREE.Texture>();
    const take = (v: unknown): void => {
      const t = v as THREE.Texture | null;
      if (t && t.isTexture && !(t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture && t.image) todo.add(t);
    };
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mt of Array.isArray(m) ? m : [m]) {
        for (const v of Object.values(mt)) take(v);
        const u = (mt as THREE.ShaderMaterial).uniforms;
        if (u) for (const k in u) take(u[k]?.value);
      }
    });
    let lastYield = performance.now();
    for (const t of todo) {
      if (props.get(t).__version === t.version) continue;
      r.initTexture(t);
      if (performance.now() - lastYield > 60) {
        await new Promise<void>((res) => setTimeout(res, 0));
        lastYield = performance.now();
        if (!live()) return;
      }
    }
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
    // Point-light counts are baked into every lit shader program: a switch that
    // changes them recompiles every material in the scene (the multi-second
    // freeze of 均衡 → 精美 mid-match). Keep the match's counts unless this switch
    // recompiles everything anyway (shadows toggled); the preset's own counts
    // then apply from that switch or the next match on.
    if (!this.lightSlots || shadowsChanged) this.lightSlots = { fires: p.brazierLights, vfx: p.vfxLights };
    this.fires.setLightCount(this.lightSlots.fires);
    this.grass.setDensity(p.grass);
    this.fx.setBudget(p.particles, this.lightSlots.vfx);
    // mid-match: bloom's programs compile over the next frames, not in one
    this.post.configure({ bloom: p.bloom, vignette: p.post, msaa: p.msaa }, this.frameNo > 0);
    // character art tier (AI-art vs procedural bodies) follows the active preset, incl. opts.quality
    this.entities.setCharacterArt(p.glbCharacters);
  }

  private onSettings(u: UserSettings): void {
    // (against the tier asked for last: switching back mid-switch cancels it)
    if (u.quality !== this.wantedQuality) this.setQuality(u.quality);
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
    if (this.disposed) return;
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
