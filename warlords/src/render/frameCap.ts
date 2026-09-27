// Frame-rate cap for the match loop (the 极速 tier: 30 fps). requestAnimationFrame
// runs at the display's rate; the limiter says which of those callbacks render.
// Frames are scheduled on a fixed grid (next = previous + interval), so a 60 Hz
// display renders exactly every other callback and a 144 Hz one averages the cap
// without drifting; a late frame (the machine is slower than the cap) re-anchors
// the grid instead of rendering a burst to catch up. Pure logic: times in ms.

export class FrameLimiter {
  /** cap in frames per second; 0 = render every callback */
  fps: number;
  private next = -1;

  constructor(fps = 0) {
    this.fps = fps;
  }

  /**
   * Should the rAF callback at `now` (ms) render? `slack` (ms) accepts a
   * callback that arrives this much before its slot (vsync jitter).
   */
  due(now: number, slack = 2): boolean {
    if (!(this.fps > 0)) {
      this.next = -1;
      return true;
    }
    const iv = 1000 / this.fps;
    if (this.next >= 0 && now < this.next - slack) return false;
    // on the grid, unless the frame is late by a whole interval (then start again from now)
    this.next = this.next < 0 || now - this.next > iv ? now + iv : this.next + iv;
    return true;
  }

  /** Forget the schedule (after a pause): the next callback renders. */
  reset(): void {
    this.next = -1;
  }
}
