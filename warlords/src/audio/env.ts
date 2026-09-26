// Feature detection. Everything in src/audio must be a silent no-op when
// WebAudio is missing (Node unit tests, locked-down browsers).

interface AudioGlobals {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  OfflineAudioContext?: typeof OfflineAudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

export function audioContextCtor(): typeof AudioContext | null {
  const g = globalThis as unknown as AudioGlobals;
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export function offlineContextCtor(): typeof OfflineAudioContext | null {
  const g = globalThis as unknown as AudioGlobals;
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

export function hasWebAudio(): boolean {
  return audioContextCtor() !== null;
}
