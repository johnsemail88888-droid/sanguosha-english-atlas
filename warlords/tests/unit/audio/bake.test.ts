import { describe, expect, it } from 'vitest';
import { bakeKey, bakeModeFor, defaultBakePlan, drumKey, FAR_DISTANCE, SampleBank } from '../../../src/audio/bake';

describe('sample bank', () => {
  it('plans guns, impacts, footsteps and drums with sane rates', () => {
    const plan = defaultBakePlan(48000, 2);
    expect(plan.length).toBeGreaterThan(50);
    const keys = new Set(plan.map((j) => j.key));
    expect(keys.has(bakeKey('gun', 'rifle', 'N'))).toBe(true);
    expect(keys.has(bakeKey('gun', 'rifle', 'F'))).toBe(true);
    expect(keys.has(bakeKey('gun', 'rifle', 'L'))).toBe(true);
    expect(keys.has(bakeKey('gun', 'flamer', 'N'))).toBe(false);
    expect(keys.has(bakeKey('impact', 'flesh', 'N'))).toBe(true);
    expect(keys.has(drumKey('taiko', 0.92))).toBe(true);
    for (const j of plan) {
      expect(j.seconds).toBeGreaterThan(0);
      expect(j.seconds).toBeLessThan(4);
      expect(j.rate).toBeGreaterThanOrEqual(22050);
      expect(j.rate).toBeLessThanOrEqual(48000);
    }
  });

  it('maps distance to bake buckets', () => {
    expect(bakeModeFor(true, 0)).toBe('L');
    expect(bakeModeFor(false, 10)).toBe('N');
    expect(bakeModeFor(false, FAR_DISTANCE + 1)).toBe('F');
  });

  it('picks random takes and tracks memory', () => {
    const bank = new SampleBank();
    const a = { length: 100 } as AudioBuffer;
    const b = { length: 50 } as AudioBuffer;
    expect(bank.pick('k')).toBeNull();
    bank.add('k', a);
    bank.add('k', b);
    expect(bank.has('k')).toBe(true);
    expect(bank.count).toBe(2);
    expect(bank.frames).toBe(150);
    for (let i = 0; i < 20; i++) expect([a, b]).toContain(bank.pick('k'));
    bank.clear();
    expect(bank.pick('k')).toBeNull();
    expect(bank.count).toBe(0);
  });

  it('baking without OfflineAudioContext resolves and stays empty', async () => {
    const bank = new SampleBank();
    await bank.bake(defaultBakePlan(48000, 1).slice(0, 5));
    expect(bank.count).toBe(0);
  });
});
