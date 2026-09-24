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

const _v = new THREE.Vector3();
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
  private occlusion = 1;
  private occluded = false;
  private bubble: { text: string; until: number } | null = null;
  private readonly defaultWeapon: string | null;
  private deadFor = 0;
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
    this.applyTint(e.flags, dt, ctx.time);

    // death bookkeeping (plates fade a few seconds after death)
    if (e.flags & VF_DEAD) this.deadFor += dt;
    else this.deadFor = 0;

    const head = this.headHeight();
    const inSquad = ctx.squad.has(e.id);
    // your own crown / chevron would sit in the middle of the TPS view
    const auraFlags = isLocal ? e.flags & ~(VF_LORD | VF_MARKED) : e.flags;
    this.auras.update(auraFlags, head, pos, dt, ctx.time, ctx.fx, ctx.fovDeg, dist, true);

    // overhead UI
    if (isHero) {
      if (isLocal) {
        if (this.plate) this.plate.sprite.visible = false;
      } else if (dist > PLATE_MAX_DIST) {
        if (this.plate) this.plate.sprite.visible = false;
      } else {
        if (!this.plate) {
          this.plate = new Nameplate();
          this.root.add(this.plate.sprite);
        }
        this.headPos.set(pos.x, pos.y + head + 0.3, pos.z);
        this.updateOcclusion(ctx, this.headPos, dist);
        const def = HERO_BY_ID[e.sub];
        const d = this.plateData;
        d.heroName = def ? (ctx.lang === 'en' ? def.nameEn : def.nameZh) : e.sub;
        d.playerName = e.name ?? '';
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
        this.plate.opacity = this.occlusion * fadeDead * distFade;
        this.plate.sprite.position.set(0, head + 0.3, 0);
        this.plate.layout(ctx.fovDeg, dist);
      }
    } else if ((e.flags & VF_DEAD) === 0 && dist < 70) {
      // troops / NPCs: one instance each in the shared badge batch
      const showBar = e.hp < e.maxHp - 0.5 && dist < 45;
      ctx.badges.add(pos.x, pos.y + head + 0.2, pos.z, kingdomColorLinear(e.kingdom), inSquad, e.hp / Math.max(1, e.maxHp), showBar, dist);
    }
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

  private updateOcclusion(ctx: EntityCtx, head: THREE.Vector3, dist: number): void {
    // staggered static LOS test (every ~8 frames per character)
    if ((ctx.frame + this.id) % 8 === 0) this.occluded = dist > 4 && ctx.blocked(ctx.camPos, head);
    const target = this.occluded ? 0.12 : 1;
    this.occlusion += (target - this.occlusion) * (1 - Math.exp(-ctx.dt * 8));
  }

  private applyTint(flags: number, dt: number, time: number): void {
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
