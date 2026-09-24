// STUB (orchestrator) — SIM-CORE replaces the bodies; keep these exported names/signatures.
// Shared by the host sim and client-side prediction (net/clientView.ts).
import type { MapData } from '../core/map';
import { terrainHeight } from '../core/map';
import type { Vec3 } from '../core/math';
import { forwardFromYaw, rightFromYaw } from '../core/math';
import type { InputFrame } from '../core/types';

export interface CollisionWorld {
  map: MapData;
}

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export interface MoveMods {
  speedMul: number;
  canSprint: boolean;
  canJump: boolean;
  rooted: boolean;
  ads: boolean;
  downed: boolean;
}

export const buildCollisionWorld = (map: MapData): CollisionWorld => ({ map });

/** Advance a character's locomotion by dt from an input frame (pure; deterministic). */
export function predictMove(cw: CollisionWorld, st: MoveState, input: InputFrame, dt: number, mods: MoveMods): void {
  if (mods.rooted) return;
  const f = forwardFromYaw(input.yaw);
  const r = rightFromYaw(input.yaw);
  const speed = 4.6 * mods.speedMul;
  st.pos.x += (f.x * input.moveZ + r.x * input.moveX) * speed * dt;
  st.pos.z += (f.z * input.moveZ + r.z * input.moveX) * speed * dt;
  st.pos.y = terrainHeight(cw.map, st.pos.x, st.pos.z);
  st.onGround = true;
}
