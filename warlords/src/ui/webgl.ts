// One-time WebGL 2 probe (three.js r163+ renders with WebGL 2 only). The title
// screen blocks 单人练习 / 联机 with an explanation when it is missing, instead of
// letting the player walk into a black, unplayable match.

export interface WebGLSupport {
  ok: boolean;
  /** short technical reason when !ok (shown under the explanation) */
  reason: string | null;
}

let cached: WebGLSupport | null = null;

export function probeWebGL(doc: Document = document): WebGLSupport {
  if (cached) return cached;
  try {
    const canvas = doc.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false, powerPreference: 'default' }) as WebGL2RenderingContext | null;
    if (!gl) {
      cached = { ok: false, reason: typeof WebGL2RenderingContext === 'undefined' ? 'WebGL 2 is not supported by this browser' : 'WebGL 2 context creation failed (disabled or blocklisted GPU)' };
    } else {
      // free the probe context right away (browsers cap live contexts)
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      cached = { ok: true, reason: null };
    }
  } catch (err) {
    cached = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return cached;
}
