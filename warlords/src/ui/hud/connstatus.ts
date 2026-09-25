// A guest's own link to the host (等待主机响应… / 主机已恢复响应 / 连接中断… / 已重新连接)
// as ONE live chip in the HUD instead of a chat line + an announcement per status
// event: after a host freeze guests used to get 4–6 stacked lines that covered the
// role card on small screens. The chip is replaced in place, turns green on
// recovery and hides itself; the chat keeps at most one line per change of the
// link's state (and none for quick flapping). Host notices (a player left, a bot
// took over…) are not link statuses and keep their chat line + announcement.
// Pure logic (no DOM): unit-tested in tests/unit/ui.
import type { SessionEventMap } from '../../game/session';

export type StatusMsg = SessionEventMap['status'];

/** 'ok' = the link is fine; the others are trouble. */
export type LinkState = 'ok' | 'waiting' | 'reconnecting';

/** session/clientSession.ts: the key of the "waiting for host" condition */
export const WAITING_HOST = 'waitingHost';

/**
 * What a status event says about the link, or null when it is not about the link
 * (host notices). The client session keys only the waiting condition; the
 * reconnect pair is recognised by its (fixed) English text.
 */
export function linkStateOf(st: StatusMsg): LinkState | null {
  if (st.key === WAITING_HOST) return st.clear ? 'ok' : 'waiting';
  if (/^connection lost/i.test(st.en)) return 'reconnecting';
  if (/^(reconnected|connected to the room)$/i.test(st.en.trim())) return 'ok';
  return null;
}

export interface LinkChip {
  zh: string;
  en: string;
  tone: 'warn' | 'bad' | 'ok';
}

/** Seconds the green "back" chip stays up. */
export const OK_CHIP_SECS = 3;
/** A new trouble line in the chat at most this often (flapping links log one pair). */
export const TROUBLE_LOG_GAP = 20;

export interface LinkUpdate {
  /** true: a link status, handled here (no announcement) */
  handled: boolean;
  /** the chat line to add for this event, if any */
  chat: { zh: string; en: string } | null;
}

export class LinkStatus {
  state: LinkState = 'ok';
  chip: LinkChip | null = null;
  private okUntil = 0;
  private lastTroubleLog = -Infinity;
  /** a trouble line is in the chat without its "back" line yet */
  private troubleLogged = false;

  push(st: StatusMsg, now: number): LinkUpdate {
    const next = linkStateOf(st);
    if (next === null) return { handled: false, chat: null };
    const prev = this.state;
    this.state = next;
    if (next === 'ok') {
      // nothing was wrong (the first "connected" of a session): no chip, no line
      if (prev === 'ok') return { handled: true, chat: null };
      this.chip = { zh: st.zh, en: st.en, tone: 'ok' };
      this.okUntil = now + OK_CHIP_SECS;
      const log = this.troubleLogged;
      this.troubleLogged = false;
      return { handled: true, chat: log ? { zh: st.zh, en: st.en } : null };
    }
    this.chip = { zh: st.zh, en: st.en, tone: next === 'reconnecting' ? 'bad' : 'warn' };
    if (next === prev) return { handled: true, chat: null };
    // waiting → reconnecting is a real change; a trouble after a quick recovery is flapping
    const log = prev !== 'ok' || now - this.lastTroubleLog >= TROUBLE_LOG_GAP;
    if (!log) return { handled: true, chat: null };
    this.lastTroubleLog = now;
    this.troubleLogged = true;
    return { handled: true, chat: { zh: st.zh, en: st.en } };
  }

  /** Per frame: hides the green chip once its time is up. True when the chip changed. */
  update(now: number): boolean {
    if (this.chip?.tone === 'ok' && now >= this.okUntil) {
      this.chip = null;
      return true;
    }
    return false;
  }
}
