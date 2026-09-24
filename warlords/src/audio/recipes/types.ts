import type { Voice } from '../voice';

export interface RecipeOpts {
  /** recipe-specific variant (weapon family, material, kingdom, ...) */
  variant: string;
  /** playback pitch multiplier (includes random variation) */
  pitch: number;
  /** size / intensity scale (explosion radius, heal amount, ...), ~0.5..2 */
  size: number;
  /** stable 0..1 hash of the emitting content (per-weapon voicing) */
  seed: number;
  /** emitted by the local player (closer, more mechanical detail) */
  local: boolean;
  /** distance to the listener in metres (0 when non-positional) */
  dist: number;
  /** free-form extra parameters */
  flavor: string;
}

/** A one-shot recipe writes into `v.out`, scheduling from `v.t`. */
export type Recipe = (v: Voice, o: RecipeOpts) => void;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
