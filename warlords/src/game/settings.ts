// User preferences store (contract). Persisted to localStorage when available.
// Read by render (fov/quality), input (sensitivity), audio (volumes), net (server), UI (everything).

export type Lang = 'zh' | 'en';
export type Quality = 'low' | 'medium' | 'high';

export interface NetServerConfig {
  /** 'peer' = PeerJS WebRTC (default public cloud or custom), 'ws' = WebSocket relay server */
  mode: 'peer' | 'ws';
  /** custom PeerJS server; empty = public cloud 0.peerjs.com */
  peerHost: string;
  peerPort: number;
  peerPath: string;
  peerSecure: boolean;
  /** ws relay url, e.g. ws://192.168.1.5:8787/ws */
  wsUrl: string;
  /** optional TURN server for strict NATs */
  turnUrl: string;
  turnUser: string;
  turnPass: string;
}

export interface UserSettings {
  playerName: string;
  lang: Lang;
  mouseSensitivity: number; // 0.2 .. 3
  adsSensitivity: number; // multiplier while aiming
  invertY: boolean;
  fov: number; // 60 .. 100
  quality: Quality;
  showFps: boolean;
  masterVolume: number; // 0..1
  musicVolume: number;
  sfxVolume: number;
  voiceLines: boolean; // speak hero quotes (speechSynthesis)
  touchControls: 'auto' | 'on' | 'off';
  net: NetServerConfig;
}

export const DEFAULT_SETTINGS: UserSettings = {
  playerName: '',
  lang: 'zh',
  mouseSensitivity: 1,
  adsSensitivity: 0.6,
  invertY: false,
  fov: 75,
  quality: 'medium',
  showFps: false,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  voiceLines: true,
  touchControls: 'auto',
  net: {
    mode: 'peer',
    peerHost: '',
    peerPort: 443,
    peerPath: '/',
    peerSecure: true,
    wsUrl: '',
    turnUrl: '',
    turnUser: '',
    turnPass: '',
  },
};

const KEY = 'sgwl.settings.v1';
type Listener = (s: UserSettings) => void;

function load(): UserSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed, net: { ...DEFAULT_SETTINGS.net, ...(parsed.net ?? {}) } };
    }
  } catch {
    /* storage unavailable (private mode / file://) */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

let current: UserSettings = load();
const listeners = new Set<Listener>();

export const settings = {
  get(): UserSettings {
    return current;
  },
  update(patch: Partial<UserSettings>): void {
    current = { ...current, ...patch, net: { ...current.net, ...(patch.net ?? {}) } };
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
    for (const l of listeners) l(current);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
