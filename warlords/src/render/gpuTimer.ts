// GPU time of a frame (EXT_disjoint_timer_query_webgl2 — desktop Chrome / Edge
// expose it; elsewhere there is none and ms stays -1). 自动调节画质 needs it to
// tell a GPU with headroom from one that only just keeps up: the time between two
// frames cannot say, it is the display's refresh either way. One query every 4th
// frame, read back frames later (never waits for the GPU); a disjoint period
// (power state change, another app took the GPU) drops what was in flight.

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** queries in flight at most (a GPU this far behind is measured by the frame rate anyway) */
const MAX_PENDING = 4;

export class GpuTimer {
  /** smoothed GPU time (ms) of the timed frames; -1 until the first result */
  ms = -1;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private frame = 0;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerQueryExt,
  ) {}

  /** null when the browser has no timer queries (or the context is WebGL 1). */
  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    try {
      if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
      return ext ? new GpuTimer(gl, ext) : null;
    } catch {
      return null;
    }
  }

  /** Before the frame's draw calls: collect finished results, maybe start a query. */
  begin(): void {
    this.collect();
    if (this.active || this.frame++ % 4 !== 0 || this.pending.length >= MAX_PENDING) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  /** After the frame's last draw call. */
  end(): void {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  private collect(): void {
    const gl = this.gl;
    if (!this.pending.length) return;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      // the timings in flight are meaningless
      this.free.push(...this.pending.splice(0));
      return;
    }
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ms = Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6;
      if (ms > 0 && Number.isFinite(ms)) this.ms = this.ms < 0 ? ms : this.ms + (ms - this.ms) * 0.2;
      this.free.push(q);
    }
  }

  dispose(): void {
    this.end();
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q);
    this.pending.length = 0;
    this.free.length = 0;
    this.active = null;
  }
}
