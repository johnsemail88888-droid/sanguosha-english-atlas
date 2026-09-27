// Recorded background music streamed from 无名杀 (noname,
// https://github.com/libnoname/noname, apps/core/audio/background). The files are
// not shipped with the game: they stream from public CDN mirrors of that repo,
// pinned to one commit, and fall back to the procedural score (music.ts) when
// none of them answers (offline, blocked, removed) or the player picked 原创国风.
//
//  menu    music_default (the classic theme)
//  battle  a shuffled playlist; the final circle (intensity ≥ AOZHAN_AT) switches
//          once to a 鏖战 track for the rest of the match
//  victory / defeat stay procedural stingers (noname has none)
import type { MixGraph } from './graph';
import type { MusicTrack } from './music';

export type MusicSource = 'noname' | 'original';

/** The player's choice ('noname' unless they picked the original score). */
export function musicSourceOf(v: unknown): MusicSource {
  return v === 'original' ? 'original' : 'noname';
}

/** libnoname/noname commit the files are read from (pinned: the URLs never move). */
export const NONAME_COMMIT = '6ef5b0106b71c44215c0ff1bb02296767e4439e7';
const DIR = 'apps/core/audio/background/';

/**
 * Base URLs, tried in order until one plays. jsDelivr first (fast, CORS, reachable
 * from most of the world); its alternate hostnames help where the main one is
 * slow or blocked; raw.githubusercontent.com last.
 */
export const NONAME_MIRRORS: readonly string[] = [
  `https://cdn.jsdelivr.net/gh/libnoname/noname@${NONAME_COMMIT}/`,
  `https://fastly.jsdelivr.net/gh/libnoname/noname@${NONAME_COMMIT}/`,
  `https://gcore.jsdelivr.net/gh/libnoname/noname@${NONAME_COMMIT}/`,
  `https://raw.githubusercontent.com/libnoname/noname/${NONAME_COMMIT}/`,
];

export const STREAM_PLAYLISTS = {
  menu: ['music_default'],
  battle: ['music_jifeng', 'music_shezhan', 'music_jilve', 'music_danji'],
  aozhan: ['aozhan_chaoming', 'aozhan_rewrite', 'aozhan_shousha', 'aozhan_online'],
} as const;

/** Final-circle intensity at which the battle music turns to 鏖战. */
export const AOZHAN_AT = 0.8;

export function trackUrl(mirror: string, name: string): string {
  return `${mirror}${DIR}${name}.mp3`;
}

/** Tracks with a streamed version (the rest are always procedural). */
export function streamsTrack(track: MusicTrack | null): track is 'menu' | 'battle' {
  return track === 'menu' || track === 'battle';
}

/** A playlist order: `list` rotated by `seed` (varies per match, deterministic in tests). */
export function playlistOrder(list: readonly string[], seed: number): string[] {
  const n = list.length;
  if (!n) return [];
  const k = ((Math.floor(seed) % n) + n) % n;
  return [...list.slice(k), ...list.slice(0, k)];
}

/** Mirror indices to try, the one that worked last time first. */
export function mirrorOrder(count: number, good: number): number[] {
  const out: number[] = [];
  if (good >= 0 && good < count) out.push(good);
  for (let i = 0; i < count; i++) if (i !== good) out.push(i);
  return out;
}

/** How long a track may take to start before the next mirror is tried. */
const START_TIMEOUT_MS = 9000;
/** Level of the recorded music on the music bus (the procedural score peaks ~0.9). */
const LEVEL = 0.62;
const FADE_IN = 1.5;

// Session-wide: which mirror answered, and whether streaming works at all.
let goodMirror = -1;
let failures = 0;
/** After this many tracks found no mirror, stop trying for the session. */
const GIVE_UP_AFTER = 2;

export function streamingAvailable(): boolean {
  return failures < GIVE_UP_AFTER;
}

/** Test hook. */
export function resetStreamStateForTest(): void {
  goodMirror = -1;
  failures = 0;
}

type Ctx = AudioContext;

/** One playing recording: an <audio> element through a gain into the music bus. */
class StreamSong {
  readonly gain: GainNode;
  private readonly el: HTMLAudioElement;
  private src: MediaElementAudioSourceNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tries: number[];
  private disposed = false;
  started = false;

  constructor(
    private readonly g: MixGraph,
    readonly name: string,
    loop: boolean,
    private readonly onFail: (s: StreamSong) => void,
    private readonly onEnded: (s: StreamSong) => void,
  ) {
    const ctx = g.ctx as Ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(g.music);
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.loop = loop;
    this.el = el;
    el.addEventListener('playing', this.onPlaying);
    el.addEventListener('error', this.next);
    el.addEventListener('ended', () => {
      if (!this.disposed) this.onEnded(this);
    });
    this.tries = mirrorOrder(NONAME_MIRRORS.length, goodMirror);
    this.next();
  }

  private readonly onPlaying = (): void => {
    if (this.disposed || this.started) return;
    this.started = true;
    this.clearTimer();
    const i = NONAME_MIRRORS.findIndex((m) => this.el.src.startsWith(m));
    if (i >= 0) goodMirror = i;
    failures = 0;
    const ctx = this.g.ctx;
    const t = ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(0, t);
    this.gain.gain.linearRampToValueAtTime(LEVEL, t + FADE_IN);
  };

  /** Try the next mirror (on error / timeout); all failed → onFail. */
  private readonly next = (): void => {
    if (this.disposed || this.started) return;
    this.clearTimer();
    const i = this.tries.shift();
    if (i === undefined) {
      failures++;
      this.onFail(this);
      return;
    }
    try {
      if (!this.src) this.src = (this.g.ctx as Ctx).createMediaElementSource(this.el);
      this.src.connect(this.gain);
      this.el.src = trackUrl(NONAME_MIRRORS[i], this.name);
      this.timer = setTimeout(this.next, START_TIMEOUT_MS);
      const p = this.el.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          // autoplay refused (no gesture yet): not the mirror's fault — retry the same one on the next gesture
          if ((err as { name?: string })?.name === 'NotAllowedError') {
            this.tries.unshift(i);
            this.clearTimer();
            const retry = (): void => {
              removeEventListener('pointerdown', retry, true);
              removeEventListener('keydown', retry, true);
              this.next();
            };
            addEventListener('pointerdown', retry, true);
            addEventListener('keydown', retry, true);
          }
        });
      }
    } catch {
      this.next();
    }
  };

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  fadeOut(time: number): void {
    const t = this.g.ctx.currentTime;
    const gg = this.gain.gain;
    gg.cancelScheduledValues(t);
    gg.setValueAtTime(gg.value, t);
    gg.linearRampToValueAtTime(0, t + Math.max(0.05, time));
    setTimeout(() => this.dispose(), (time + 0.2) * 1000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch {
      /* ignore */
    }
    try {
      this.src?.disconnect();
      this.gain.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Streams 'menu' / 'battle'. `onFail(track)` fires when no mirror plays the
 * track — the caller then plays the procedural version instead.
 */
export class StreamMusic {
  private song: StreamSong | null = null;
  private current: 'menu' | 'battle' | null = null;
  private queue: string[] = [];
  private aozhan = false;
  private matchSeed = 0;

  constructor(
    private readonly g: MixGraph,
    private readonly onFail: (track: 'menu' | 'battle') => void,
  ) {}

  /** Recorded music plays only through a live AudioContext with <audio> support. */
  static supported(g: MixGraph): boolean {
    return typeof Audio !== 'undefined' && typeof (g.ctx as Partial<Ctx>).createMediaElementSource === 'function';
  }

  get track(): 'menu' | 'battle' | null {
    return this.current;
  }

  play(track: 'menu' | 'battle', seed: number): void {
    if (this.current === track && this.song) return;
    this.stop(1.2);
    this.current = track;
    this.aozhan = false;
    this.matchSeed = seed;
    this.queue = track === 'menu' ? [...STREAM_PLAYLISTS.menu] : playlistOrder(STREAM_PLAYLISTS.battle, seed);
    this.startNext(1.2);
  }

  /** Final circle → 鏖战 (once per battle). */
  setIntensity(x: number): void {
    if (this.current !== 'battle' || this.aozhan || !(x >= AOZHAN_AT)) return;
    this.aozhan = true;
    this.queue = playlistOrder(STREAM_PLAYLISTS.aozhan, this.matchSeed);
    this.startNext(2.5);
  }

  stop(fade = 0.5): void {
    this.song?.fadeOut(fade);
    this.song = null;
    this.current = null;
    this.queue = [];
  }

  dispose(): void {
    this.song?.dispose();
    this.song = null;
    this.current = null;
  }

  private startNext(fade: number): void {
    const track = this.current;
    if (!track) return;
    const prev = this.song;
    if (prev) prev.fadeOut(fade);
    const name = this.queue.shift();
    if (!name) {
      this.song = null;
      return;
    }
    // keep cycling: a played track goes to the back of the queue
    this.queue.push(name);
    const single = this.queue.length === 1;
    this.song = new StreamSong(
      this.g,
      name,
      single,
      (s) => {
        if (s !== this.song) return;
        this.song = null;
        this.current = null;
        this.onFail(track);
      },
      (s) => {
        if (s === this.song) this.startNext(0.5);
      },
    );
  }
}
