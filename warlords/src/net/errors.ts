// Bilingual network errors. Everything the UI may show for a connection problem
// goes through NetError so the message is always available in zh and en.

export type NetErrorCode =
  | 'roomNotFound'
  | 'timeout'
  | 'networkRestricted'
  | 'serverUnreachable'
  | 'noServerConfigured'
  | 'invalidCode'
  | 'roomFull'
  | 'versionMismatch'
  | 'inProgress'
  | 'kicked'
  | 'hostLeft'
  | 'connectionLost'
  | 'simFailed'
  | 'unsupported'
  | 'closed'
  /** this seat was taken over by the same player's newer connection (a duplicated tab): no auto-rejoin (MP2-4) */
  | 'replacedElsewhere'
  /** the host lost the relay server and could not get its room back (MP2-8) */
  | 'relayLost';

const MESSAGES: Record<NetErrorCode, { zh: string; en: string }> = {
  roomNotFound: { zh: '房间不存在', en: 'Room not found' },
  timeout: { zh: '连接超时', en: 'Connection timed out' },
  networkRestricted: {
    zh: '网络受限，请尝试局域网服务器',
    en: 'Network restricted — try a LAN / self-hosted server',
  },
  serverUnreachable: { zh: '无法连接服务器', en: 'Cannot reach the server' },
  noServerConfigured: {
    zh: '未配置服务器地址，请在设置中填写',
    en: 'No server configured — set the server address in Settings',
  },
  invalidCode: { zh: '房间号无效', en: 'Invalid room code' },
  roomFull: { zh: '房间已满', en: 'The room is full' },
  versionMismatch: {
    zh: '你与房主的游戏版本不同，请双方刷新到最新版本',
    en: "Your game version differs from the host's — both of you should refresh to the latest version",
  },
  inProgress: { zh: '对局进行中，无法加入', en: 'A match is in progress' },
  kicked: { zh: '你已被房主移出房间', en: 'You were removed by the host' },
  hostLeft: { zh: '房主已离开，房间已关闭', en: 'The host left — the room is closed' },
  connectionLost: { zh: '与房主的连接已断开', en: 'Lost connection to the host' },
  simFailed: { zh: '对局创建失败', en: 'Failed to start the match' },
  unsupported: { zh: '当前浏览器不支持联机', en: 'This browser does not support online play' },
  closed: { zh: '连接已关闭', en: 'Connection closed' },
  replacedElsewhere: { zh: '你已在其他窗口进入该房间', en: 'You entered this room from another window' },
  relayLost: { zh: '与中转服务器的连接已断开', en: 'Lost the connection to the relay server' },
};

export class NetError extends Error {
  readonly code: NetErrorCode;
  readonly zh: string;
  readonly en: string;

  constructor(code: NetErrorCode, detail?: string) {
    const m = MESSAGES[code];
    super(detail ? `${m.en} (${detail})` : m.en);
    this.name = 'NetError';
    this.code = code;
    this.zh = m.zh;
    this.en = detail ? `${m.en} (${detail})` : m.en;
  }

  /** Payload shape used by GameSession 'error' events. */
  toPayload(): { code: string; zh: string; en: string } {
    return { code: this.code, zh: this.zh, en: this.en };
  }
}

export const netErrorText = (code: NetErrorCode): { zh: string; en: string } => MESSAGES[code];

export const isNetError = (e: unknown): e is NetError => e instanceof NetError;

/** Wrap anything thrown into a NetError (unknown errors map to `fallback`). */
export function toNetError(e: unknown, fallback: NetErrorCode = 'serverUnreachable'): NetError {
  if (e instanceof NetError) return e;
  const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : undefined;
  return new NetError(fallback, detail);
}
