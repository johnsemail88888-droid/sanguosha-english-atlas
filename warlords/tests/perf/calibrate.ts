// Fixed CPU workload used to normalise wall-clock perf budgets to the speed of
// the machine running the tests (dev box vs. a slower shared CI runner).
// Shaped like sim work: small-object allocation, float math, array scans.

interface P {
  x: number;
  y: number;
  z: number;
}

function workload(): number {
  let acc = 0;
  const pts: P[] = [];
  for (let i = 0; i < 4000; i++) pts.push({ x: Math.sin(i) * 50, y: (i % 7) * 0.3, z: Math.cos(i * 1.3) * 50 });
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < pts.length; i += 3) {
      const a = pts[i];
      let best = Infinity;
      for (let j = 0; j < 40; j++) {
        const b = pts[(i * 31 + j * 97 + round) % pts.length];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d < best) best = d;
      }
      const v = { x: a.x + best * 0.001, y: a.y, z: a.z - best * 0.001 };
      acc += Math.sqrt(v.x * v.x + v.z * v.z) + Math.atan2(v.z, v.x);
    }
  }
  return acc;
}

/** Milliseconds for the reference workload (best of `runs`, after a warm-up). */
export function calibrationMs(runs = 7): number {
  workload();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    workload();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
