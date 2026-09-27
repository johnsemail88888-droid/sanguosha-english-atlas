// One-time WebGL 2 probe (three.js r163+ renders with WebGL 2 only). The title
// screen blocks 单人练习 / 联机 with an explanation when it is missing, instead of
// letting the player walk into a black, unplayable match. The same throwaway
// context says which GPU the browser renders with (settings.probeGpu): a software
// renderer (hardware acceleration off) gets its own warning.
import { probeGpu } from '../game/settings';

export interface WebGLSupport {
  ok: boolean;
  /** short technical reason when !ok (shown under the explanation) */
  reason: string | null;
}

export function probeWebGL(doc: Document = document): WebGLSupport {
  const g = probeGpu(doc);
  return { ok: g.webgl2, reason: g.webgl2 ? null : g.reason };
}
