// The music the engine plays: the recorded 无名杀 tracks (streamMusic.ts) for
// menu / battle when the player keeps 配乐 on 无名杀 and they can be streamed,
// otherwise — and always for the victory / defeat stingers — the procedural
// score (music.ts).
import { settings } from '../game/settings';
import type { MixGraph } from './graph';
import { MusicPlayer as ProceduralMusic } from './music';
import type { MusicTrack } from './music';
import { musicSourceOf, StreamMusic, streamingAvailable, streamsTrack } from './streamMusic';
import type { MusicSource } from './streamMusic';

export class MusicPlayer {
  private readonly proc: ProceduralMusic;
  private readonly stream: StreamMusic | null;
  private wanted: MusicTrack | null = null;
  private source: MusicSource;
  private seed = Math.floor(Math.random() * 1000);

  constructor(
    g: MixGraph,
    private readonly getSource: () => MusicSource = () => musicSourceOf(settings.get().musicSource),
  ) {
    this.proc = new ProceduralMusic(g);
    this.stream = StreamMusic.supported(g)
      ? new StreamMusic(g, (track) => {
          // no mirror played it: the procedural version instead
          if (this.wanted === track) this.proc.play(track);
        })
      : null;
    this.source = this.getSource();
  }

  get track(): MusicTrack | null {
    return this.stream?.track ?? this.proc.track;
  }

  /** Whether `track` plays as a recording right now. */
  streams(track: MusicTrack | null): boolean {
    return !!this.stream && streamsTrack(track) && this.source === 'noname' && streamingAvailable();
  }

  play(track: MusicTrack | null, fade = 1.2): void {
    this.wanted = track;
    if (track && streamsTrack(track) && this.streams(track)) {
      if (track === 'battle' && this.stream?.track !== 'battle') this.seed++;
      this.proc.play(null, fade);
      this.stream?.play(track, this.seed);
      return;
    }
    const stinger = track === 'victory' || track === 'defeat';
    this.stream?.stop(stinger ? 0.4 : fade);
    this.proc.play(track, fade);
  }

  setIntensity(x: number): void {
    this.proc.setIntensity(x);
    this.stream?.setIntensity(x);
  }

  pump(until: number): void {
    const s = this.getSource();
    if (s !== this.source) {
      // 设置 → 配乐 changed: replay the current loop from the other source
      this.source = s;
      const w = this.wanted;
      if (w && streamsTrack(w)) {
        this.stream?.stop(0.8);
        this.proc.play(null, 0.8);
        this.play(w);
      }
    }
    this.proc.pump(until);
  }

  stop(fade = 0.5): void {
    this.play(null, fade);
  }

  dispose(): void {
    this.stream?.dispose();
    this.proc.dispose();
  }
}
