// The pluck caches (music notes) are bounded by bytes, not only by count: a
// long session must not keep ~40 MB of samples alive at the title (G3-4).
import { describe, expect, it } from 'vitest';
import { Kit, pluckDataCacheBytes } from '../../../src/audio/dsp';

/** Minimal BaseAudioContext stand-in: createBuffer → an AudioBuffer-like object. */
function fakeCtx(sampleRate = 48000): BaseAudioContext {
  return {
    sampleRate,
    createBuffer(_ch: number, length: number, sr: number) {
      const data = new Float32Array(length);
      return { length, sampleRate: sr, numberOfChannels: 1, duration: length / sr, getChannelData: () => data } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
}

describe('Kit pluck cache', () => {
  it('stays within its byte budgets however many notes are played', () => {
    const kit = new Kit(fakeCtx());
    // three octaves of long notes in several timbres: far more than the budgets hold
    for (let v = 0; v < 3; v++) {
      for (let semi = 0; semi < 36; semi++) {
        kit.pluck(110 * Math.pow(2, semi / 12), 4, 0.5, 0.2, v);
      }
    }
    expect(pluckDataCacheBytes()).toBeLessThanOrEqual(4 * 1024 * 1024);
    // the Kit's own AudioBuffer LRU
    const kitBytes = (kit as unknown as { pluckBytes: number }).pluckBytes;
    expect(kitBytes).toBeGreaterThan(0);
    expect(kitBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it('still serves a repeated note from the cache', () => {
    const kit = new Kit(fakeCtx());
    const a = kit.pluck(220, 1.2, 0.5, 0.2);
    const b = kit.pluck(220, 1.2, 0.5, 0.2);
    expect(b).toBe(a);
  });
});
