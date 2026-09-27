import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AOZHAN_AT,
  mirrorOrder,
  musicSourceOf,
  NONAME_MIRRORS,
  playlistOrder,
  resetStreamStateForTest,
  STREAM_PLAYLISTS,
  StreamMusic,
  streamingAvailable,
  streamsTrack,
  trackUrl,
} from '../../../src/audio/streamMusic';
import type { MixGraph } from '../../../src/audio/graph';

describe('streamMusic helpers', () => {
  it('reads the setting: anything but "original" is noname', () => {
    expect(musicSourceOf('original')).toBe('original');
    expect(musicSourceOf('noname')).toBe('noname');
    expect(musicSourceOf(undefined)).toBe('noname');
    expect(musicSourceOf('garbage')).toBe('noname');
  });

  it('streams menu and battle only', () => {
    expect(streamsTrack('menu')).toBe(true);
    expect(streamsTrack('battle')).toBe(true);
    expect(streamsTrack('victory')).toBe(false);
    expect(streamsTrack('defeat')).toBe(false);
    expect(streamsTrack(null)).toBe(false);
  });

  it('builds pinned URLs into the background folder', () => {
    for (const m of NONAME_MIRRORS) {
      expect(m).toMatch(/^https:\/\//);
      expect(m).toMatch(/[0-9a-f]{40}\/$/);
    }
    expect(trackUrl(NONAME_MIRRORS[0], 'music_default')).toMatch(/\/apps\/core\/audio\/background\/music_default\.mp3$/);
  });

  it('rotates playlists by seed and keeps every track', () => {
    const list = STREAM_PLAYLISTS.battle;
    expect(playlistOrder(list, 0)).toEqual([...list]);
    expect(playlistOrder(list, 1)[0]).toBe(list[1]);
    expect(playlistOrder(list, -1)[0]).toBe(list[list.length - 1]);
    for (let s = 0; s < 9; s++) expect([...playlistOrder(list, s)].sort()).toEqual([...list].sort());
    expect(playlistOrder([], 3)).toEqual([]);
  });

  it('tries the mirror that worked first, then the rest in order', () => {
    expect(mirrorOrder(4, -1)).toEqual([0, 1, 2, 3]);
    expect(mirrorOrder(4, 2)).toEqual([2, 0, 1, 3]);
    expect(mirrorOrder(4, 9)).toEqual([0, 1, 2, 3]);
  });
});

// ── StreamMusic with a fake <audio> and AudioContext ──────────────────────────
class FakeParam {
  value = 0;
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
}
class FakeNode {
  gain = new FakeParam();
  connect(n: unknown): unknown {
    return n;
  }
  disconnect(): void {}
}
type Handler = () => void;
class FakeAudio {
  static all: FakeAudio[] = [];
  crossOrigin = '';
  preload = '';
  loop = false;
  src = '';
  private handlers = new Map<string, Handler[]>();
  constructor() {
    FakeAudio.all.push(this);
  }
  addEventListener(type: string, fn: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emit(type: string): void {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  removeAttribute(): void {
    this.src = '';
  }
  load(): void {}
}

function fakeGraph(): MixGraph {
  const ctx = {
    currentTime: 0,
    createGain: () => new FakeNode(),
    createMediaElementSource: () => new FakeNode(),
  };
  return { ctx, music: new FakeNode() } as unknown as MixGraph;
}

describe('StreamMusic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.all = [];
    resetStreamStateForTest();
    vi.stubGlobal('Audio', FakeAudio);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is supported only with <audio> and a live AudioContext', () => {
    expect(StreamMusic.supported(fakeGraph())).toBe(true);
    const g = fakeGraph();
    (g.ctx as unknown as { createMediaElementSource?: unknown }).createMediaElementSource = undefined;
    expect(StreamMusic.supported(g)).toBe(false);
  });

  it('plays the classic theme on the menu, looping, from the first mirror', () => {
    const m = new StreamMusic(fakeGraph(), () => {});
    m.play('menu', 0);
    const el = FakeAudio.all[0];
    expect(el.crossOrigin).toBe('anonymous');
    expect(el.loop).toBe(true);
    expect(el.src).toBe(trackUrl(NONAME_MIRRORS[0], 'music_default'));
    expect(m.track).toBe('menu');
  });

  it('moves to the next mirror on an error or a stall, and remembers the one that played', () => {
    const m = new StreamMusic(fakeGraph(), () => {});
    m.play('menu', 0);
    const el = FakeAudio.all[0];
    el.emit('error');
    expect(el.src).toBe(trackUrl(NONAME_MIRRORS[1], 'music_default'));
    vi.advanceTimersByTime(10_000); // stalled
    expect(el.src).toBe(trackUrl(NONAME_MIRRORS[2], 'music_default'));
    el.emit('playing');
    m.stop(0);
    vi.advanceTimersByTime(1000);
    m.play('battle', 0);
    const el2 = FakeAudio.all[FakeAudio.all.length - 1];
    expect(el2.src.startsWith(NONAME_MIRRORS[2])).toBe(true);
    expect(el2.loop).toBe(false);
  });

  it('reports failure once every mirror failed, then gives up for the session', () => {
    const failed: string[] = [];
    const m = new StreamMusic(fakeGraph(), (t) => failed.push(t));
    for (let round = 0; round < 2; round++) {
      m.play('menu', 0);
      const el = FakeAudio.all[FakeAudio.all.length - 1];
      for (let i = 0; i < NONAME_MIRRORS.length; i++) el.emit('error');
    }
    expect(failed).toEqual(['menu', 'menu']);
    expect(m.track).toBe(null);
    expect(streamingAvailable()).toBe(false);
  });

  it('chains the battle playlist and turns to 鏖战 once in the final circle', () => {
    const m = new StreamMusic(fakeGraph(), () => {});
    m.play('battle', 0);
    const first = FakeAudio.all[0];
    expect(first.src).toContain(`${STREAM_PLAYLISTS.battle[0]}.mp3`);
    first.emit('playing');
    first.emit('ended');
    expect(FakeAudio.all[1].src).toContain(`${STREAM_PLAYLISTS.battle[1]}.mp3`);
    m.setIntensity(AOZHAN_AT - 0.1);
    expect(FakeAudio.all).toHaveLength(2);
    m.setIntensity(AOZHAN_AT);
    expect(FakeAudio.all).toHaveLength(3);
    expect(FakeAudio.all[2].src).toMatch(/aozhan_/);
    m.setIntensity(1);
    expect(FakeAudio.all).toHaveLength(3);
  });

  it('a menu → battle switch replaces the song; the same track again is a no-op', () => {
    const m = new StreamMusic(fakeGraph(), () => {});
    m.play('menu', 0);
    m.play('menu', 0);
    expect(FakeAudio.all).toHaveLength(1);
    m.play('battle', 3);
    expect(FakeAudio.all).toHaveLength(2);
    expect(m.track).toBe('battle');
  });
});
