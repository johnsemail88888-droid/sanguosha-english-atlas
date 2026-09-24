// Visual for a hero / troop / NPC ViewEntity: procedural rig + animation,
// status tints, auras, stealth, mounts and nameplates.
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
import { CharacterRig } from '../models/character';
import { heroSpec, mountCoat, troopLook } from '../models';
import { kingdomColor } from '../palette';
import { AuraSet } from './auras';
import { Nameplate, TroopBadge } from './nameplate';
import type { EntityCtx } from './context';

const _v = new THREE.Vector3();
const _head = new THREE.Vector3();
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

export class CharacterView {
  readonly id: number;
  readonly kind: ViewEntity['kind'];
  readonly sub: string;
  readonly rig: CharacterRig;
  readonly root = new THREE.Group();
  private plate: Nameplate | null = null;
  private badge: TroopBadge | null = null;
  private readonly auras = new AuraSet();
  private readonly lastPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private initialised = false;
  private hitFlash = 0;
  private occlusion = 1;
  private occluded = false;
  private bubble: { text: string; until: number } | null = null;
  private readonly troopMount: string | null;
  private readonly defaultWeapon: string | null;
  private deadFor = 0;
  /** true while this view is a corpse kept after the entity left the view */
  corpse = false;
  corpseTime = 0;
  last: ViewEntity;

  constructor(e: ViewEntity) {
    this.id = e.id;
    this.kind = e.kind;
    this.sub = e.sub;
    this.last = e;
    if (e.kind === 'hero') {
      this.rig = new CharacterRig(heroSpec(e.sub, e.kingdom));
      this.rig.tryGlbOverride(e.sub);
      this.troopMount = null;
      this.defaultWeapon = HERO_BY_ID[e.sub]?.signatureWeapon ?? null;
    } else {
      const look = troopLook(e.sub, e.kingdom);
      const tdef = TROOP_BY_ID[e.sub];
      this.defaultWeapon = tdef?.weapon ?? (e.kind === 'turret' ? 'turret_smg' : 'troop_rifle');
      this.rig = new CharacterRig(look.spec);
      this.troopMount = look.mount;
      if (look.mount) this.rig.setMount(look.mount, look.mount === 'elephant' ? '#8a8580' : '#5a3f2a', look.spec.kingdom, '#d8ac4c');
    }
    this.root.add(this.rig.root);
    this.root.add(this.auras.group);
    this.root.name = `${e.kind}_${e.id}`;
  }

  /** Height of the head top above the feet (for plates / auras). */
  headHeight(): number {
    const base = this.rig.spec.body === 'huge' ? 1.98 : 1.84;
    if (this.rig.mount?.kind === 'elephant') return base + 2.4;
    if (this.rig.mount) return base + 0.75;
    if (this.last.flags & (VF_DOWNED | VF_DEAD)) return 0.7;
    return base;
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
    const visible = dist < ctx.characterDistance || isLocal;
    this.root.visible = visible;
    if (!visible) return;

    // mounts: heroes ride when flagged (or carrying a mount item)
    if (this.kind === 'hero') {
      const mounted = (e.flags & VF_MOUNTED) !== 0;
      if (mounted) this.rig.setMount('horse', mountCoat(e.mount), kingdomColor(e.kingdom), '#d8ac4c');
      else this.rig.setMount(null);
    }
    this.rig.setWeapon(e.weapon ?? this.defaultWeapon);

    // movement direction in the character frame
    const sp = Math.hypot(this.vel.x, this.vel.z);
    let mx = 0;
    let mz = 0;
    if (sp > 0.3) {
      // forward(yaw) = (−sin, −cos), right(yaw) = (cos, −sin) — see core/math
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      mx = (this.vel.x * cy - this.vel.z * sy) / sp;
      mz = (-this.vel.x * sy - this.vel.z * cy) / sp;
    }
    const speed = e.speed > 0 ? e.speed : sp;
    this.rig.update(dt, ctx.time, { speed, moveX: mx, moveZ: mz, pitch: e.pitch, flags: e.flags });

    // stealth: only you / your squad receive stealthed entities → translucent shimmer
    this.rig.setStealth((e.flags & VF_STEALTH) !== 0);
    // revealed (观星 / 狼顾 / 鬼谋): red silhouette through walls
    this.rig.setXray((e.flags & VF_EXPOSED) !== 0 && !isLocal && (e.flags & VF_DEAD) === 0);
    this.rig.setShadows(ctx.shadows && dist < 60);
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
    _head.set(pos.x, pos.y + head + 0.3, pos.z);
    if (this.kind === 'hero') {
      if (isLocal) {
        if (this.plate) this.plate.sprite.visible = false;
      } else {
        if (!this.plate) {
          this.plate = new Nameplate();
          this.root.add(this.plate.sprite);
        }
        this.updateOcclusion(ctx, _head, dist);
        const def = HERO_BY_ID[e.sub];
        const heroName = def ? (ctx.lang === 'en' ? def.nameEn : def.nameZh) : e.sub;
        const claimDef = e.claim ? ROLE_BY_ID[e.claim] : undefined;
        const fadeDead = e.flags & VF_DEAD ? Math.max(0, 1 - (this.deadFor - 4) / 2) : 1;
        const maxDist = 140;
        const distFade = Math.max(0, Math.min(1, (maxDist - dist) / 20));
        this.plate.set({
          heroName,
          playerName: e.name ?? '',
          hp: e.hp,
          maxHp: e.maxHp,
          shield: e.shield,
          lord: (e.flags & VF_LORD) !== 0,
          role: e.role as RoleId | undefined,
          claim: e.claim,
          claimLabel: claimDef ? (ctx.lang === 'en' ? `Claims ${claimDef.nameEn}` : `自称${claimDef.nameZh}`) : undefined,
          downed: (e.flags & VF_DOWNED) !== 0,
          kingdom: e.kingdom,
          friendly: inSquad,
          bubble: this.bubble && this.bubble.until > ctx.time ? this.bubble.text : undefined,
        });
        this.plate.opacity = this.occlusion * fadeDead * distFade;
        this.plate.sprite.position.set(0, head + 0.3, 0);
        this.plate.layout(ctx.fovDeg, dist);
      }
    } else {
      if (!this.badge) {
        this.badge = new TroopBadge();
        this.root.add(this.badge.group);
      }
      const dead = (e.flags & VF_DEAD) !== 0;
      const damaged = e.hp < e.maxHp - 0.5;
      this.badge.group.visible = !dead && dist < 70;
      this.badge.group.position.set(0, head + 0.2, 0);
      this.badge.set(kingdomColor(e.kingdom), inSquad, e.hp / Math.max(1, e.maxHp), damaged && dist < 45, ctx.fovDeg, dist);
    }
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
    this.badge?.dispose();
    this.auras.dispose();
  }
}

export { ROLE_BY_ID };
