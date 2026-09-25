// GameEvent → visuals. The renderer drains the ViewSource once per frame and
// passes the batch here (then re-emits it to HUD / audio subscribers).
import * as THREE from 'three';
import type { EntityId, GameEvent, RoleId } from '../../core/types';
import { ITEM_BY_ID, ROLE_BY_ID, WEAPON_BY_ID } from '../../data';
import type { Lang } from '../../game/settings';
import { PT } from '../core/textures';
import type { EntityManager } from '../entities/manager';
import { FX_COLORS, type Effects, type ShotClass } from './effects';
import { genericAbilityVfx, getAbilityVfx, type AbilityVfxContext } from './abilities';
import { getItemVfx } from './itemRegistry';
import { QUICKCHAT, type QuickChatLine } from '../../ui/theme';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

/** Visual class for a weapon id (tracer / muzzle styling). */
export function shotClass(weaponId: string | undefined): ShotClass {
  const def = weaponId ? WEAPON_BY_ID[weaponId] : undefined;
  if (!def) {
    const id = (weaponId ?? '').toLowerCase();
    if (id.includes('shotgun')) return 'shotgun';
    if (id.includes('crossbow')) return 'crossbow';
    if (id.includes('melee')) return 'melee';
    if (id.includes('smg') || id.includes('turret')) return 'smg';
    return 'rifle';
  }
  if (def.special === 'chainLightning' || def.dtype === 'thunder') return 'tesla';
  if (def.special === 'freeze') return 'ice';
  if (def.class === 'flamer') return 'flamer';
  if (def.special === 'fireConvert' || def.dtype === 'fire') return 'fire';
  if (def.class === 'dmr') return 'rifle';
  return def.class as ShotClass;
}

/**
 * Overhead quick-chat bubbles use the UI's shared line table (ui/theme.ts
 * QUICKCHAT — the ids the sim / bots emit), plus snake_case aliases. An
 * unknown id shows a generic call-out, never the raw id.
 */
const QUICKCHAT_LINES = new Map<string, QuickChatLine>();
for (const l of QUICKCHAT) {
  QUICKCHAT_LINES.set(l.id, l);
  QUICKCHAT_LINES.set(l.id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), l);
}
const QUICKCHAT_FALLBACK: QuickChatLine = { id: '', zh: '注意！', en: 'Heads up!' };

/** Bubble text for a quick-chat id in the given language. */
export function quickChatBubble(id: string, lang: Lang): string {
  const l = QUICKCHAT_LINES.get(id) ?? QUICKCHAT_FALLBACK;
  return lang === 'en' ? l.en : l.zh;
}

export interface EventVfxDeps {
  fx: Effects;
  entities: EntityManager;
  localId: EntityId | null;
  /**
   * Called for each host 'shot' by the local hero (with its weapon id): returns
   * true (and consumes it) when local fire feedback already drew that shot's
   * muzzle / tracer. Shots of other weapons / abilities never match.
   */
  consumePredictedShot: (weaponId: string) => boolean;
  lang: Lang;
  time: number;
  camPos: THREE.Vector3;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
let lastRemoteLight = 0;

export function handleEvents(evs: readonly GameEvent[], deps: EventVfxDeps): void {
  const { fx, entities } = deps;
  for (const ev of evs) {
    try {
      switch (ev.t) {
        case 'shot': {
          const cls = shotClass(ev.weapon);
          const to = _b.set(ev.to.x, ev.to.y, ev.to.z);
          const view = entities.character(ev.src) ?? undefined;
          const own = ev.src === deps.localId && deps.consumePredictedShot(ev.weapon);
          if (!own) {
            let from = _a.set(ev.from.x, ev.from.y, ev.from.z);
            if (view && view.muzzleWorld(_d) && _d.distanceTo(from) < 3) from = _a.copy(_d);
            const dir = _d.subVectors(to, from).normalize();
            const near = from.distanceTo(deps.camPos) < 30 && deps.time - lastRemoteLight > 0.06;
            if (near) lastRemoteLight = deps.time;
            fx.muzzleFlash(from, dir, cls, near);
            fx.tracer(from, to, cls);
            view?.onShot();
            const tv = entities.view(ev.src);
            if (tv && 'onShot' in tv && !(tv === view)) (tv as { onShot?: () => void }).onShot?.();
          }
          if (ev.hit === undefined && cls !== 'launcher' && cls !== 'melee') {
            _d.set(ev.from.x - ev.to.x, ev.from.y - ev.to.y, ev.from.z - ev.to.z).normalize();
            fx.impact(to, _d, cls);
          }
          break;
        }
        case 'hit': {
          const p = _a.set(ev.pos.x, ev.pos.y, ev.pos.z);
          const tv = entities.character(ev.target);
          if (ev.blocked) {
            switch (ev.blocked) {
              case 'dodge':
                fx.burst(p, { count: 8, tex: PT.spark, color: C(1.6, 1.6, 1.8), speed: [3, 6], life: [0.15, 0.3], size: [0.05, 0.02], stretch: 0.05 });
                break;
              case 'shield':
                fx.fx.sphere(tv ? tv.chestWorld(_b) : p, C(0.5, 0.9, 2.2), 0.8, 1.0, 0.25, 0.9);
                break;
              case 'armor':
                fx.impact(p, null, 'rifle');
                break;
              case 'invuln':
                fx.fx.sphere(tv ? tv.chestWorld(_b) : p, C(2.2, 1.7, 0.5), 0.8, 1.0, 0.3, 1);
                break;
              case 'nullify':
                fx.burst(p, { count: 1, tex: PT.bagua, color: C(2, 2, 2), speed: [0, 0], life: [0.5, 0.6], size: [0.6, 1.4], spin: 3 });
                break;
            }
          } else {
            const amt = Math.min(3, ev.amount / 40) * (ev.head ? 1.5 : 1);
            if (ev.dtype !== 'zone') fx.inkSplash(p, amt);
            if (ev.dtype === 'fire') fx.burst(p, { count: 5, tex: PT.flame, color: FX_COLORS.fire, speed: [0.5, 2], up: 1, life: [0.3, 0.5], size: [0.2, 0.4], gravity: -2 });
            if (ev.dtype === 'thunder') fx.burst(p, { count: 8, tex: PT.spark, color: FX_COLORS.thunder, speed: [2, 6], life: [0.15, 0.3], size: [0.05, 0.02], stretch: 0.04 });
            if (ev.dtype === 'zone') fx.burst(p, { count: 3, tex: PT.flame, color: C(2.2, 0.4, 0.1), speed: [0.5, 1.5], up: 1, life: [0.3, 0.5], size: [0.2, 0.4], gravity: -2 });
            tv?.onHit();
          }
          break;
        }
        case 'explosion':
          fx.explosion(_a.set(ev.pos.x, ev.pos.y, ev.pos.z), ev.radius, ev.kind);
          break;
        case 'melee': {
          const v = entities.character(ev.src);
          v?.onMelee();
          const yaw = Math.atan2(-ev.dir.x, -ev.dir.z);
          const p = _a.set(ev.pos.x, ev.pos.y, ev.pos.z);
          if (v) {
            v.chestWorld(_b);
            p.set(_b.x, _b.y - 0.1, _b.z);
          }
          fx.slash(p, yaw, Math.max(1.2, ev.range), Math.max(30, ev.arc), v ? fx.kingdomColor(v.last.kingdom, 1.8) : C(2, 2, 2));
          break;
        }
        case 'ability': {
          const src = entities.character(ev.src);
          src?.onCast();
          const srcPos = src ? src.chestWorld(new THREE.Vector3()) : null;
          const tgt = ev.target !== undefined ? entities.character(ev.target) : undefined;
          const targetPos = tgt ? tgt.chestWorld(new THREE.Vector3()) : null;
          const point = ev.pos ? new THREE.Vector3(ev.pos.x, ev.pos.y, ev.pos.z) : targetPos ?? srcPos;
          const dir = ev.dir
            ? new THREE.Vector3(ev.dir.x, ev.dir.y, ev.dir.z).normalize()
            : src
              ? new THREE.Vector3(-Math.sin(src.last.yaw), 0, -Math.cos(src.last.yaw))
              : new THREE.Vector3(0, 0, -1);
          const ctx: AbilityVfxContext = {
            fx,
            src: src?.last,
            srcPos,
            targetPos,
            point,
            dir,
            color: fx.kingdomColor(src?.last.kingdom),
            localId: deps.localId,
          };
          (getAbilityVfx(ev.ability) ?? genericAbilityVfx)(ctx, ev);
          break;
        }
        case 'status': {
          if (!ev.on) break;
          const tv = entities.character(ev.target);
          if (!tv) break;
          const p = tv.chestWorld(_a);
          switch (ev.status) {
            case 'stun':
              fx.burst(p.setY(p.y + 0.5), { count: 6, tex: PT.star, color: C(2.2, 2, 0.8), speed: [1, 2], life: [0.4, 0.7], size: [0.14, 0.06], spin: 6 });
              break;
            case 'freeze':
              fx.explosion(p, 1.2, 'ice');
              break;
            case 'charm':
              fx.burst(p, { count: 8, tex: PT.heart, color: C(2.4, 0.6, 1.1), speed: [0.6, 1.6], up: 1, life: [0.8, 1.2], size: [0.18, 0.1], gravity: -1 });
              break;
            case 'dance':
              fx.burst(p, { count: 8, tex: PT.note, color: C(2.2, 1.7, 0.6), speed: [0.6, 1.6], up: 1, life: [0.8, 1.2], size: [0.2, 0.12], gravity: -1 });
              break;
            case 'shield':
              fx.fx.sphere(p, C(0.5, 0.9, 2.2), 0.4, 1.2, 0.4, 1);
              break;
            case 'invuln':
              fx.fx.sphere(p, C(2.2, 1.7, 0.5), 0.4, 1.3, 0.5, 1);
              break;
            case 'stealth':
              fx.burst(p, { count: 10, tex: PT.smoke, color: C(0.55, 0.6, 0.62), speed: [0.4, 1.4], life: [0.8, 1.2], size: [0.5, 1.4], additive: false, alpha: 0.5, drag: 2 });
              break;
            case 'silence':
            case 'disarm':
              fx.burst(p.setY(p.y + 0.6), { count: 1, tex: PT.ring, color: C(1.6, 1.6, 1.6), speed: [0, 0], life: [0.5, 0.6], size: [0.3, 0.8] });
              break;
            case 'marked':
            case 'reveal':
              fx.burst(p.setY(p.y + 0.9), { count: 1, tex: PT.chevron, color: C(2.4, 0.4, 0.3), speed: [0, 0], life: [0.6, 0.7], size: [0.5, 0.3] });
              break;
            case 'burn':
              fx.burst(p, { count: 10, tex: PT.flame, color: FX_COLORS.fire, speed: [0.5, 2], up: 1, life: [0.3, 0.6], size: [0.3, 0.6], gravity: -2 });
              break;
            case 'haste':
            case 'dmgBoost':
            case 'fireRateUp':
              fx.genericAbility(p, ev.status === 'haste' ? C(1.4, 1.8, 2.2) : C(2.4, 0.7, 0.3), 1.2);
              break;
            default:
              break;
          }
          break;
        }
        case 'heal': {
          const tv = entities.character(ev.target);
          if (tv) fx.heal(tv.chestWorld(_a), ev.amount);
          break;
        }
        case 'downed': {
          const tv = entities.character(ev.target);
          if (!tv) break;
          const p = tv.chestWorld(_a);
          fx.inkSplash(p, 2.5);
          fx.fx.ring(_b.set(p.x, fx.groundY(p.x, p.z) + 0.08, p.z), { color: C(2, 0.2, 0.1), radius0: 0.3, radius1: 2.2, life: 0.8, inner: 0.8 });
          break;
        }
        case 'revived': {
          const tv = entities.character(ev.target);
          if (!tv) break;
          const p = tv.chestWorld(_a);
          fx.fx.pillar(_b.set(p.x, fx.groundY(p.x, p.z), p.z), C(2, 1.7, 0.8), 0.7, 6, 1.0, 1);
          fx.sparkle(p, C(2, 1.7, 0.8), 16);
          break;
        }
        case 'death': {
          entities.noteDeath(ev.target, deps.time);
          const tv = entities.character(ev.target);
          if (!tv) break;
          const p = tv.chestWorld(_a);
          fx.inkSplash(p, ev.kind === 'hero' ? 3 : 1.6);
          if (ev.kind === 'hero') {
            fx.burst(p, { count: 16, tex: PT.smoke, color: C(0.1, 0.08, 0.08), speed: [0.5, 2], up: 0.8, life: [1.2, 2], size: [0.5, 1.8], additive: false, alpha: 0.6, gravity: -0.6, drag: 1 });
            fx.burst(p, { count: 10, tex: PT.glow, color: C(1.6, 1.4, 1.1), speed: [0.4, 1.2], up: 1, life: [1.5, 2.5], size: [0.12, 0.02], gravity: -1.2 });
          }
          break;
        }
        case 'pickup': {
          const tv = entities.character(ev.who);
          if (!tv) break;
          const item = ITEM_BY_ID[ev.item];
          fx.sparkle(tv.chestWorld(_a), new THREE.Color(item?.color ?? '#ffd070').multiplyScalar(1.8), 10);
          break;
        }
        case 'itemUse': {
          const user = entities.character(ev.who);
          const tgt = ev.target !== undefined ? entities.character(ev.target) : undefined;
          const item = ITEM_BY_ID[ev.item];
          const colr = new THREE.Color(item?.color ?? '#ffd070').multiplyScalar(1.8);
          user?.onCast();
          const bespoke = getItemVfx(ev.item);
          if (bespoke) {
            const userPos = user ? user.chestWorld(new THREE.Vector3()) : null;
            const targetPos = tgt ? tgt.chestWorld(new THREE.Vector3()) : null;
            const point = ev.pos ? new THREE.Vector3(ev.pos.x, ev.pos.y, ev.pos.z) : targetPos ?? userPos;
            const dir = user ? new THREE.Vector3(-Math.sin(user.last.yaw), 0, -Math.cos(user.last.yaw)) : new THREE.Vector3(0, 0, -1);
            bespoke({ fx, userPos, targetPos, point, dir, color: colr, localId: deps.localId }, ev);
            break;
          }
          const tv = tgt ?? user;
          const p = ev.pos ? _a.set(ev.pos.x, ev.pos.y, ev.pos.z) : tv ? tv.chestWorld(_a) : null;
          if (!p) break;
          fx.sparkle(p, colr, 12);
          fx.fx.ring(_b.set(p.x, fx.groundY(p.x, p.z) + 0.08, p.z), { color: colr, radius0: 0.3, radius1: 1.8, life: 0.5, inner: 0.8 });
          break;
        }
        case 'airdrop': {
          const p = _a.set(ev.pos.x, ev.pos.y, ev.pos.z);
          fx.fx.pillar(_b.set(p.x, fx.groundY(p.x, p.z), p.z), C(2.4, 0.5, 0.3), 1.2, 60, 3, 0.7);
          break;
        }
        case 'command': {
          if (ev.who !== deps.localId) break;
          const attack = ev.order === 'attack' || ev.order === 'charge';
          const colr = attack ? C(2.4, 0.5, 0.3) : C(0.5, 2, 0.7);
          const tgt = ev.target !== undefined ? entities.character(ev.target) : undefined;
          const p = tgt ? tgt.chestWorld(_a) : ev.point ? _a.set(ev.point.x, ev.point.y, ev.point.z) : null;
          if (!p) break;
          fx.fx.ring(_b.set(p.x, fx.groundY(p.x, p.z) + 0.08, p.z), { color: colr, radius0: 2, radius1: 0.6, life: 0.7, inner: 0.75, alpha: 1.2 });
          fx.burst(_b.set(p.x, p.y + 1.2, p.z), { count: 1, tex: PT.chevron, color: colr, speed: [0, 0], life: [0.8, 0.9], size: [0.6, 0.4] });
          break;
        }
        case 'claim': {
          const tv = entities.character(ev.who);
          const role = ROLE_BY_ID[ev.role as RoleId];
          if (tv && role) tv.say(deps.lang === 'en' ? `I am the ${role.nameEn}!` : `我是${role.nameZh}！`, deps.time + 3.5);
          break;
        }
        case 'quickchat': {
          const tv = entities.character(ev.who);
          if (tv) tv.say(quickChatBubble(ev.id, deps.lang), deps.time + 3);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn('[render] event vfx failed', ev.t, err);
    }
  }
}
