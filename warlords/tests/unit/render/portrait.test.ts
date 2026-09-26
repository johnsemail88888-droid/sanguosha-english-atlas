// Portrait job queue (G3-3): priority order + bump, one job per task (the
// runner yields between jobs instead of chaining ~30 renders as microtasks).
// In node there is no WebGL: every job resolves to the 2D / stub fallback.
import { describe, expect, it } from 'vitest';
import { bumpHeroPortraits, pendingHeroPortraits, renderHeroPortrait } from '../../../src/render/portrait';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('renderHeroPortrait queue', () => {
  it('runs higher priorities first and bumps pending jobs', async () => {
    const done: string[] = [];
    const ids = ['liubei', 'guanyu', 'zhangfei', 'zhaoyun'];
    const ps = ids.map((id, i) => renderHeroPortrait(id, 64, i === 3 ? 5 : 0).then((u) => (done.push(id), u)));
    expect(pendingHeroPortraits()).toEqual(['zhaoyun|64', 'liubei|64', 'guanyu|64', 'zhangfei|64']);
    // the cards the player looks at jump the queue (earlier ids first)
    bumpHeroPortraits(['zhangfei', 'guanyu'], 10);
    expect(pendingHeroPortraits()).toEqual(['zhangfei|64', 'guanyu|64', 'zhaoyun|64', 'liubei|64']);
    // asking again with a higher priority bumps too; the same promise comes back
    const again = renderHeroPortrait('liubei', 64, 20);
    expect(again).toBe(renderHeroPortrait('liubei', 64));
    expect(pendingHeroPortraits()[0]).toBe('liubei|64');
    const urls = await Promise.all(ps);
    expect(done).toEqual(['liubei', 'zhangfei', 'guanyu', 'zhaoyun']);
    for (const u of urls) expect(u.startsWith('data:')).toBe(true);
    expect(pendingHeroPortraits()).toEqual([]);
  });

  it('yields to the event loop between two jobs (never one long microtask chain)', async () => {
    const done: string[] = [];
    const ps = ['caocao', 'simayi', 'xuchu'].map((id) => renderHeroPortrait(id, 96).then(() => done.push(id)));
    expect(done).toHaveLength(0); // nothing runs synchronously in the caller
    await tick(); // the runner's first task has run: exactly one job, the others wait for later tasks
    expect(done).toEqual(['caocao']);
    await tick();
    expect(done.length).toBeLessThanOrEqual(2);
    await Promise.all(ps);
    expect(done).toEqual(['caocao', 'simayi', 'xuchu']);
  });

  it('caches per hero + size', async () => {
    const a = renderHeroPortrait('diaochan', 128);
    expect(renderHeroPortrait('diaochan', 128)).toBe(a);
    expect(renderHeroPortrait('diaochan', 256)).not.toBe(a);
    await a;
  });
});
