// Visual for a hero / troop / NPC ViewEntity: procedural rig + animation,
// status tints, auras, stealth, mounts and nameplates.
//
// Visibility: heroes are NEVER distance-culled (at most 8; a sniper must see
// what can shoot it on every quality preset) — far heroes only drop to a
// cheaper animation rate. Troops / NPCs are hidden beyond the preset's
// characterDistance.
import * as THREE from 'three';
import { lerpAngle } from '../../core/math';
import type { RoleId, ViewEntity } from '../../core/types';
import {
  VF_BOOSTED,
  VF_BURNING,
  VF_CHARMED,
  VF_DEAD,
  VF_DOWNED,
  VF_EXPOSED,
  VF_FROZEN,
  VF_INVULN,
  VF_LORD,
  VF_MARKED,
  VF_MOUNTED,
  VF_STEALTH,
} from '../../core/types';
import { HERO_BY_ID, ROLE_BY_ID, TROOP_BY_ID } from '../../data';
import { CharacterRig, type RigUpdate } from '../models/character';
import { heroMountCoat, heroSpec, troopLook, troopMountCoat } from '../models';
import { kingdomColor } from '../palette';
import { AuraSet } from './auras';
import { Nameplate, type PlateData } from './nameplate';
import type { EntityCtx } from './context';
import { CAM_FADE_HIDDEN, cameraFadeTarget, type CamFadeOptions } from './camFade';
import { LOS_MAX_AGE_HERO, LosCache, needsLos, overheadTarget, stepOcclusion, type OverheadVisibility } from './occlusion';
import { displayName } from '../../game/names';

const _v = new THREE.Vector3();
const _losTop = new THREE.Vector3();
const _losChest = new THREE.Vector3();
const EMISSIVE = {
  invuln: new THREE.Color(0.55, 0.42, 0.1),
  frozen: new THREE.Color(0.12, 0.25, 0.4),
  burn: new THREE.Color(0.5, 0.18, 0.02),
  boost: new THREE.Color(0.45, 0.08, 0.02),
  charm: new THREE.Color(0.45, 0.1, 0.3),
  stealth: new THREE.Color(0.1, 0.3, 0.5),
  hit: new THREE.Color(0.8, 0.15, 0.1),
  none: new THREE.Color(0, 0, 0),
};
const WHITE = new THREE.Color(1, 1, 1);
const ICE = new THREE.Color(0.72, 0.88, 1.25);

/** Beyond this distance (m) a non-local hero animates at a third of the frame rate. */
export const HERO_ANIM_LOD_DIST = 120;
/** Heroes cast shadows within this distance (m) of the camera. */
export const HERO_SHADOW_DIST = 60;
/** Troops / NPCs cast shadows within this distance (m) of the camera. */
export const TROOP_SHADOW_DIST = 25;
/** Hero nameplates fade out beyond this distance (m). */
const PLATE_MAX_DIST = 140;
/** Troop / NPC pennants are drawn within this distance (m). */
const BADGE_MAX_DIST = 70;
/** Near-camera fade of a rider: the mount's half length (m, before scale) stands in for the body radius. */
const MOUNT_FADE_RADIUS = 1.05;

const kingdomColors = new Map<string, THREE.Color>();
function kingdomColorLinear(k: ViewEntity['kingdom']): THREE.Color {
  const key = k ?? '';
  let c = kingdomColors.get(key);
  if (!c) {
    c = new THREE.Color(kingdomColor(k));
    kingdomColors.set(key, c);
  }
  return c;
}

export class CharacterView {
  readonly id: number;
  readonly kind: ViewEntity['kind'];
  readonly sub: string;
  readonly rig: CharacterRig;
  readonly root = new THREE.Group();
  private plate: Nameplate | null = null;
  private readonly auras = new AuraSet();
  private readonly lastPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly headPos = new THREE.Vector3();
  private yaw = 0;
  private initialised = false;
  private hitFlash = 0;
  /**
   * Line-of-sight opacity of the overhead UI drawn through the world (plate,
   * pennant, mark chevron): 0 while a wall / hill hides the character from the
   * camera (see ./occlusion.ts), 1 in sight.
   */
  private occlusion = 0;
  private readonly los = new LosCache();
  private readonly overheadVis: OverheadVisibility = { exposed: false, local: false, squad: false };
  private bubble: { text: string; until: number } | null = null;
  private readonly defaultWeapon: string | null;
  private deadFor = 0;
  /** near-camera / camera-line fade (non-local characters), 1 = opaque, 0 = hidden */
  private camFade = 1;
  private readonly fadeOpts: CamFadeOptions = { squad: false, camDir: null, fovDeg: 60 };
  /** dt accumulated while a far hero skips animation frames */
  private animDt = 0;
  // per-frame scratch (no allocations in update)
  private readonly rigIn: RigUpdate = { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 };
  private readonly plateData: PlateData = {
    heroName: '',
    playerName: '',
    hp: 0,
    maxHp: 1,
    shield: 0,
    lord: false,
    downed: false,
    kingdom: undefined,
    friendly: false,
  };
  private claimKey = '';
  private claimLabel: string | undefined;
  /** true while this view is a corpse kept after the entity left the view */
  corpse = false;
  corpseTime = 0;
  /** reusable copy of the last ViewEntity for corpse updates (owned by the EntityManager) */
  corpseEnt: ViewEntity | null = null;
  corpseBaseY: number | undefined;
  last: ViewEntity;

  constructor(e: ViewEntity) {
    this.id = e.id;
    this.kind = e.kind;
    this.sub = e.sub;
    this.last = e;
    if (e.kind === 'hero') {
      this.rig = new CharacterRig(heroSpec(e.sub, e.kingdom));
      this.rig.tryGlbOverride(e.sub);
      this.defaultWeapon = HERO_BY_ID[e.sub]?.signatureWeapon ?? null;
    } else {
      const look = troopLook(e.sub, e.kingdom);
      const tdef = TROOP_BY_ID[e.sub];
      this.defaultWeapon = tdef?.weapon ?? (e.kind === 'turret' ? 'turret_smg' : 'troop_rifle');
      this.rig = new CharacterRig(look.spec);
      this.rig.root.scale.setScalar(look.rootScale);
      if (look.mount) this.rig.setMount(look.mount, troopMountCoat(look.mount), look.spec.kingdom, '#d8ac4c');
    }
    this.root.add(this.rig.root);
    this.root.add(this.auras.group);
    this.root.name = `${e.kind}_${e.id}`;
  }

  /** Height of the head top above the feet (for plates / auras). */
  headHeight(): number {
    if (this.last.flags & (VF_DOWNED | VF_DEAD)) return 0.7 * this.rig.root.scale.y;
    return this.rig.headHeight();
  }

  onShot(): void {
    this.rig.animator.fire(1);
  }
  onMelee(): void {
    this.rig.animator.melee();
  }
  onCast(): void {
    this.rig.animator.cast();
  }
  onHit(): void {
    this.rig.animator.hit();
    this.hitFlash = 0.14;
  }
  say(text: string, until: number): void {
    this.bubble = { text, until };
  }

  /** Chest position in world space. */
  chestWorld(out: THREE.Vector3): THREE.Vector3 {
    const h = this.headHeight();
    return out.set(this.root.position.x, this.root.position.y + h * 0.7, this.root.position.z);
  }

  muzzleWorld(out: THREE.Vector3): boolean {
    return this.rig.muzzleWorld(out);
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    this.last = e;
    const dt = ctx.dt;
    const isLocal = e.id === ctx.localId;
    const isHero = this.kind === 'hero';
    const pos = _v.set(e.x, e.y, e.z);
    if (!this.initialised) {
      this.lastPos.copy(pos);
      this.yaw = e.yaw;
      this.initialised = true;
    }
    // smoothed velocity from displayed motion (drives strafe / backpedal blending)
    if (dt > 1e-4) {
      const k = 1 - Math.exp(-dt * 10);
      this.vel.x += ((pos.x - this.lastPos.x) / dt - this.vel.x) * k;
      this.vel.z += ((pos.z - this.lastPos.z) / dt - this.vel.z) * k;
    }
    this.lastPos.copy(pos);
    this.root.position.copy(pos);
    this.yaw = isLocal ? e.yaw : lerpAngle(this.yaw, e.yaw, 1 - Math.exp(-dt * 18));
    this.root.rotation.y = this.yaw;
    const dist = ctx.camPos.distanceTo(pos);
    // heroes are never distance-culled (fairness: every quality sees every hero in weapon range)
    const visible = isHero || isLocal || dist < ctx.characterDistance;
    this.root.visible = visible;
    if (!visible) return;

    // mounts: heroes ride when the sim flags them (mount item) or their visual is always mounted (马超 / 吕布)
    const fallen = (e.flags & (VF_DOWNED | VF_DEAD)) !== 0;
    if (isHero) {
      const coat = fallen ? null : heroMountCoat(e.sub, e.mount, (e.flags & VF_MOUNTED) !== 0);
      if (coat) this.rig.setMount('horse', coat, kingdomColor(e.kingdom), '#d8ac4c');
      else this.rig.setMount(null);
    }
    this.rig.setWeapon(e.weapon ?? this.defaultWeapon);

    // animation (far heroes: every third frame with the accumulated dt)
    this.animDt += dt;
    const animNow = isLocal || dist < HERO_ANIM_LOD_DIST || (ctx.frame + this.id) % 3 === 0;
    if (animNow) {
      // movement direction in the character frame
      const sp = Math.hypot(this.vel.x, this.vel.z);
      const u = this.rigIn;
      u.moveX = 0;
      u.moveZ = 0;
      if (sp > 0.3) {
        // forward(yaw) = (−sin, −cos), right(yaw) = (cos, −sin) — see core/math
        const sy = Math.sin(this.yaw);
        const cy = Math.cos(this.yaw);
        u.moveX = (this.vel.x * cy - this.vel.z * sy) / sp;
        u.moveZ = (-this.vel.x * sy - this.vel.z * cy) / sp;
      }
      u.speed = e.speed > 0 ? e.speed : sp;
      u.pitch = e.pitch;
      u.flags = e.flags;
      this.rig.update(Math.min(0.2, this.animDt), ctx.time, u);
      this.animDt = 0;
    }

    // stealth: only you / your squad receive stealthed entities → translucent shimmer
    this.rig.setStealth((e.flags & VF_STEALTH) !== 0);
    // revealed (观星 / 狼顾 / 鬼谋): red silhouette through walls
    this.rig.setXray((e.flags & VF_EXPOSED) !== 0 && !isLocal && (e.flags & VF_DEAD) === 0);
    this.rig.setShadows(ctx.shadows && dist < (isHero ? HERO_SHADOW_DIST : TROOP_SHADOW_DIST));
    this.applyTint(e.flags, dt, ctx.time, isLocal);
    const inSquad = ctx.squad.has(e.id);
    // characters hugging the camera, your own soldiers filling the view, and anyone
    // standing between the camera and the followed hero turn translucent / hide
    if (!isLocal) {
      let target = 1;
      if (dist < 12) {
        const fo = this.fadeOpts;
        fo.squad = inSquad;
        fo.camDir = ctx.camDir ?? null;
        fo.fovDeg = ctx.fovDeg;
        // low crawling camera while your hero is downed: troops / NPCs get a larger near volume
        fo.downedCam = !isHero && (ctx.local?.downed ?? false);
        // a rider's body reaches the mount's head / rump: its "radius" is the half length
        const radius = (this.rig.mount ? MOUNT_FADE_RADIUS : 0.45) * this.rig.root.scale.x;
        target = cameraFadeTarget(ctx.camPos, ctx.focusPos ?? null, pos, this.headHeight(), radius, fo);
      }
      // hiding is immediate (a body inside the camera must never flash on screen), fading back in is smooth
      if (target <= CAM_FADE_HIDDEN) this.camFade = 0;
      else this.camFade += (target - this.camFade) * (1 - Math.exp(-dt * 14));
      if (target === 1 && this.camFade > 0.985) this.camFade = 1;
      const shown = this.camFade > CAM_FADE_HIDDEN;
      this.rig.root.visible = shown;
      if (shown) this.rig.setFade(this.camFade);
    } else if (!this.rig.root.visible) this.rig.root.visible = true;
    const plateFade = Math.max(0, Math.min(1, (this.camFade - 0.35) / 0.55));
    // crown / chevron / status auras go with the body
    this.auras.group.visible = plateFade > 0.25;

    // death bookkeeping (plates fade a few seconds after death)
    if (e.flags & VF_DEAD) this.deadFor += dt;
    else this.deadFor = 0;

    const head = this.headHeight();
    // your own crown / chevron would sit in the middle of the TPS view
    const auraFlags = isLocal ? e.flags & ~(VF_LORD | VF_MARKED) : e.flags;
    this.auras.update(auraFlags, head, pos, dt, ctx.time, ctx.fx, ctx.fovDeg, dist, true, isLocal);

    // overhead UI (drawn on top of the world: gated by line of sight, never a wallhack)
    const vis = this.overheadVis;
    vis.exposed = (e.flags & VF_EXPOSED) !== 0;
    vis.local = isLocal;
    vis.squad = inSquad;
    const marked = (auraFlags & VF_MARKED) !== 0 && (e.flags & VF_DEAD) === 0;
    if (isHero) {
      if (isLocal) {
        if (this.plate) this.plate.sprite.visible = false;
      } else if (dist > PLATE_MAX_DIST) {
        if (this.plate) this.plate.sprite.visible = false;
        if (marked) this.updateOcclusion(ctx, pos, head, dist, true);
        else this.hideOverhead();
      } else {
        if (!this.plate) {
          this.plate = new Nameplate();
          this.root.add(this.plate.sprite);
        }
        this.headPos.set(pos.x, pos.y + head + 0.3, pos.z);
        this.updateOcclusion(ctx, pos, head, dist, true);
        const def = HERO_BY_ID[e.sub];
        const d = this.plateData;
        d.heroName = def ? (ctx.lang === 'en' ? def.nameEn : def.nameZh) : e.sub;
        d.playerName = e.name ? displayName(e.name, ctx.lang) : '';
        d.hp = e.hp;
        d.maxHp = e.maxHp;
        d.shield = e.shield;
        d.lord = (e.flags & VF_LORD) !== 0;
        d.role = e.role as RoleId | undefined;
        d.claim = e.claim;
        d.claimLabel = this.claimLabelFor(e.claim, ctx.lang);
        d.downed = (e.flags & VF_DOWNED) !== 0;
        d.kingdom = e.kingdom;
        d.friendly = inSquad;
        d.bubble = this.bubble && this.bubble.until > ctx.time ? this.bubble.text : undefined;
        this.plate.set(d);
        const fadeDead = e.flags & VF_DEAD ? Math.max(0, 1 - (this.deadFor - 4) / 2) : 1;
        const distFade = Math.max(0, Math.min(1, (PLATE_MAX_DIST - dist) / 20));
        this.plate.opacity = this.occlusion * fadeDead * distFade * plateFade;
        this.plate.sprite.position.set(0, head + 0.3, 0);
        this.plate.layout(ctx.fovDeg, dist);
      }
    } else if ((e.flags & VF_DEAD) === 0 && dist < BADGE_MAX_DIST && plateFade > 0.5) {
      // troops / NPCs: one instance each in the shared badge batch (hidden behind walls / hills)
      this.updateOcclusion(ctx, pos, head, dist, false);
      if (this.occlusion > 0.02) {
        const showBar = e.hp < e.maxHp - 0.5 && dist < 45;
        ctx.badges.add(pos.x, pos.y + head + 0.2, pos.z, kingdomColorLinear(e.kingdom), inSquad, e.hp / Math.max(1, e.maxHp), showBar, dist, this.occlusion);
      }
    } else if (marked) this.updateOcclusion(ctx, pos, head, dist, false);
    else this.hideOverhead();
    // the 鬼谋 mark chevron is drawn through walls too: same line-of-sight rule
    this.auras.setMarkVisible(isLocal || this.occlusion > 0.3);
  }

  /** No overhead UI this frame (out of range): forget the cached line of sight. */
  private hideOverhead(): void {
    this.los.reset();
    this.occlusion = 0;
  }

  private claimLabelFor(claim: RoleId | undefined, lang: string): string | undefined {
    if (!claim) return undefined;
    const key = claim + lang;
    if (key !== this.claimKey) {
      this.claimKey = key;
      const c = ROLE_BY_ID[claim];
      this.claimLabel = c ? (lang === 'en' ? `Claims ${c.nameEn}` : `自称${c.nameZh}`) : undefined;
    }
    return this.claimLabel;
  }

  /**
   * Staggered, cached static line-of-sight test (colliders + terrain) from the
   * camera to the head top (heroes: or the chest), driving `occlusion`. Your
   * own hero / squad and revealed heroes (VF_EXPOSED) are never hidden.
   */
  private updateOcclusion(ctx: EntityCtx, pos: THREE.Vector3, head: number, dist: number, hero: boolean): void {
    const vis = this.overheadVis;
    if (!needsLos(vis, dist)) {
      this.los.reset();
      this.occlusion = 1;
      return;
    }
    if (this.los.due(ctx.frame, ctx.time, this.id, hero ? LOS_MAX_AGE_HERO : Infinity)) {
      let blocked = ctx.blocked(ctx.camPos, _losTop.set(pos.x, pos.y + head, pos.z));
      // a hero whose head is behind a beam but whose body is in the open still shows
      if (blocked && hero) blocked = ctx.blocked(ctx.camPos, _losChest.set(pos.x, pos.y + head * 0.6, pos.z));
      if (this.los.set(blocked, ctx.time)) {
        // first result: start at it (a hidden plate must never flash in; a visible one needs no fade)
        this.occlusion = blocked ? 0 : 1;
        return;
      }
    }
    this.occlusion = stepOcclusion(this.occlusion, overheadTarget(this.los.blocked, vis), ctx.dt);
  }

  /** `local`: your own hero sits in the middle of the view — status glows are a hint there, not a gold statue */
  private applyTint(flags: number, dt: number, time: number, local = false): void {
    const m = this.rig.material;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    let em = EMISSIVE.none;
    let ei = 1;
    if (flags & VF_INVULN) em = EMISSIVE.invuln;
    else if (flags & VF_FROZEN) em = EMISSIVE.frozen;
    else if (flags & VF_BURNING) {
      em = EMISSIVE.burn;
      ei = 0.7 + 0.3 * Math.sin(time * 14);
    } else if (flags & VF_BOOSTED) {
      em = EMISSIVE.boost;
      ei = 0.6 + 0.4 * Math.sin(time * 5);
    } else if (flags & VF_CHARMED) {
      em = EMISSIVE.charm;
      ei = 0.6 + 0.4 * Math.sin(time * 6);
    }
    if (flags & VF_STEALTH) {
      em = EMISSIVE.stealth;
      ei = 0.8 + 0.4 * Math.sin(time * 4);
    }
    if (local) ei *= 0.12;
    if (this.hitFlash > 0) {
      em = EMISSIVE.hit;
      ei = this.hitFlash / 0.14;
    }
    m.emissive.copy(em);
    m.emissiveIntensity = ei;
    m.color.copy(flags & VF_FROZEN ? ICE : WHITE);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.rig.dispose();
    this.plate?.dispose();
    this.auras.dispose();
  }
}

export { ROLE_BY_ID };
