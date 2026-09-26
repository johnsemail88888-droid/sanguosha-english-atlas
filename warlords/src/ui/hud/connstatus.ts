// A guest's own link to the host (等待房主响应… / 房主已恢复响应 / 连接中断… / 已重新连接)
// as ONE live chip in the HUD instead of a chat line + an announcement per status
// event: after a host freeze guests used to get 4–6 stacked lines that covered the
// role card on small screens. The chip is replaced in place, turns green on
// recovery and hides itself; the chat gets one line only for a trouble that lasts
// (TROUBLE_LOG_AFTER) or turns into a reconnect, updated in place when the link is
// back. Host notices (a player left, a bot took over…) are not link statuses and
// keep their chat line + announcement.
// Pure logic (no DOM): unit-tested in tests/unit/ui.
import type { SessionEventMap } from '../../game/session';

export type StatusMsg = SessionEventMap['status'];

/**
 * 'ok' = the link is fine; the others are trouble. 'unreachable': the automatic rejoin
 * cannot find the host and keeps trying (a frozen host's peer id is gone, MP2-2).
 */
export type LinkState = 'ok' | 'waiting' | 'reconnecting' | 'unreachable';

/** session/clientSession.ts: the key of the "waiting for host" condition */
export const WAITING_HOST = 'waitingHost';
/** session/clientSession.ts: the key of the "cannot reach the host, retrying…" condition */
export const HOST_UNREACHABLE = 'hostUnreachable';

/**
 * What a status event says about the link, or null when it is not about the link
 * (host notices). The client session keys the waiting and unreachable conditions; the
 * reconnect pair is recognised by its (fixed) English text.
 */
export function linkStateOf(st: StatusMsg): LinkState | null {
  if (st.key === WAITING_HOST) return st.clear ? 'ok' : 'waiting';
  // (its English line starts like the reconnect line: the key decides first)
  if (st.key === HOST_UNREACHABLE) return st.clear ? 'ok' : 'unreachable';
  if (/^connection lost/i.test(st.en)) return 'reconnecting';
  if (/^(reconnected|connected to the room)$/i.test(st.en.trim())) return 'ok';
  return null;
}

/** A button on the chip: 重试 (session.retryNow) / 离开 (leave the room). */
export type LinkAction = 'retry' | 'leave';

/**
 * The chip's buttons: a silent host can be left (it may never answer again), an
 * unreachable one retried now or left; a reconnect in progress and a recovery need none.
 */
export function linkActions(state: LinkState): LinkAction[] {
  if (state === 'waiting') return ['leave'];
  if (state === 'unreachable') return ['retry', 'leave'];
  return [];
}

/** Whole seconds of the host's silence (session.hostSilentMs) for the waiting chip. */
export function silentSecs(ms: number | undefined): number {
  return Math.max(0, Math.round((ms ?? 0) / 1000));
}

export interface LinkChip {
  zh: string;
  en: string;
  tone: 'warn' | 'bad' | 'ok';
  /** buttons on the chip */
  actions?: readonly LinkAction[];
  /** the waiting chip counts the host's silence: 「等待房主响应… 12 秒」 */
  counter?: boolean;
}

/** The chip's text, with the silence counter (`secs` > 0) on a waiting chip. */
export function linkChipText(chip: LinkChip, secs: number, lang: 'zh' | 'en'): string {
  const base = lang === 'en' ? chip.en : chip.zh;
  if (!chip.counter || secs <= 0) return base;
  return lang === 'en' ? `${base} ${secs} s` : `${base} ${secs} 秒`;
}

/** Seconds the green "back" chip stays up. */
export const OK_CHIP_SECS = 3;
/**
 * A trouble episode reaches the chat only once it has lasted this long, or when it
 * turns into a reconnect (MP2-7): a short host freeze is the chip alone. The one
 * line an episode gets is updated in place when the link is back.
 */
export const TROUBLE_LOG_AFTER = 10;

/** A chat line about the link: `key` names the episode's one line (a later line with the same key replaces it). */
export interface LinkLine {
  key: string;
  zh: string;
  en: string;
}

export interface LinkUpdate {
  /** true: a link status, handled here (no announcement) */
  handled: boolean;
  /** the chat line to add / update for this event, if any */
  chat: LinkLine | null;
}

/** The online flow calls the host 房主 everywhere (UX-17): the net layer's 主机 lines read the same. */
export function hostWording(zh: string): string {
  return zh.replace(/主机/g, '房主');
}

export class LinkStatus {
  state: LinkState = 'ok';
  chip: LinkChip | null = null;
  private okUntil = 0;
  /** the current trouble episode: since when, its chat key, whether its line is in the chat */
  private since = 0;
  private episode = 0;
  private logged = false;

  push(st: StatusMsg, now: number): LinkUpdate {
    const next = linkStateOf(st);
    if (next === null) return { handled: false, chat: null };
    const prev = this.state;
    this.state = next;
    const zh = hostWording(st.zh);
    if (next === 'ok') {
      // nothing was wrong (the first "connected" of a session): no chip, no line
      if (prev === 'ok') return { handled: true, chat: null };
      this.chip = { zh, en: st.en, tone: 'ok' };
      this.okUntil = now + OK_CHIP_SECS;
      const logged = this.logged;
      this.logged = false;
      if (!logged) return { handled: true, chat: null };
      // the episode's line becomes "back (after N s)"
      const secs = Math.max(1, Math.round(now - this.since));
      return { handled: true, chat: { key: this.key(), zh: `${zh}（中断 ${secs} 秒）`, en: `${st.en} (after ${secs} s)` } };
    }
    this.chip = { zh, en: st.en, tone: next === 'waiting' ? 'warn' : 'bad', actions: linkActions(next), counter: next === 'waiting' };
    if (prev === 'ok') {
      this.episode++;
      this.since = now;
      this.logged = false;
    }
    // a reconnect is always worth its line (the waiting line, if any, turns into it); an
    // unreachable host is the same episode's line, updated in place
    if ((next === 'reconnecting' && prev !== 'reconnecting') || (next === 'unreachable' && prev !== 'unreachable')) {
      this.logged = true;
      return { handled: true, chat: { key: this.key(), zh, en: st.en } };
    }
    return { handled: true, chat: null };
  }

  /**
   * Per frame: hides the green chip once its time is up (`chip`: the chip changed), and
   * logs a trouble that has lasted TROUBLE_LOG_AFTER seconds (`chat`).
   */
  update(now: number): { chip: boolean; chat: LinkLine | null } {
    if (this.chip?.tone === 'ok' && now >= this.okUntil) {
      this.chip = null;
      return { chip: true, chat: null };
    }
    if (this.state !== 'ok' && !this.logged && this.chip && now - this.since >= TROUBLE_LOG_AFTER) {
      this.logged = true;
      return { chip: false, chat: { key: this.key(), zh: this.chip.zh, en: this.chip.en } };
    }
    return { chip: false, chat: null };
  }

  private key(): string {
    return `link-${this.episode}`;
  }
}
