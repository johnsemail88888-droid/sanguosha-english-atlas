// 邀请朋友一起玩 (title screen): one click creates a room in the default
// connection mode, copies its invite link and lands the host in the lobby with
// the link shown big. The clipboard write has to start inside that click (Safari
// and Firefox only allow it during the user's gesture), long before the room
// exists: it is given a promise of the link (ClipboardItem), which the room
// fulfils. Where that is not supported the link is copied once it is known, and
// when the clipboard refuses altogether the lobby selects the link for 长按 /
// Ctrl+C.
import { copyText } from './dom';
import type { OsId } from './perfcheck';
import { t, tx } from './i18n';

/** What the lobby shows about the link the title's button made (null: no such link — a normal 创建房间). */
export interface InviteNotice {
  /** the invite link (null: the room is still being created) */
  link: string | null;
  /** it is on the clipboard (null: not known yet) */
  copied: boolean | null;
}

/** A link that arrives later (the room's), settled exactly once. */
export interface PendingLink {
  readonly link: Promise<string>;
  /** the room exists (its link) or never will (null: failed / cancelled) */
  settle(link: string | null): void;
}

export function pendingLink(): PendingLink {
  let done = false;
  let res: (s: string) => void = () => undefined;
  let rej: (e: unknown) => void = () => undefined;
  const link = new Promise<string>((a, b) => {
    res = a;
    rej = b;
  });
  // nobody may be listening when the room fails
  link.catch(() => undefined);
  return {
    link,
    settle(l) {
      if (done) return;
      done = true;
      if (l) res(l);
      else rej(new Error('no room'));
    },
  };
}

/** The clipboard bits copyWhenReady() uses (tests pass fakes). */
export interface ClipEnv {
  /** navigator.clipboard where the page may use it (secure context), else null */
  clipboard: { write?(items: unknown[]): Promise<void> } | null;
  ClipboardItem: (new (items: Record<string, Promise<Blob>>) => unknown) | null;
  /** copy a known text (dom.copyText: writeText, then the execCommand fallback) */
  copy(text: string): Promise<boolean>;
}

function clipEnv(): ClipEnv {
  const g = globalThis as { navigator?: Navigator; isSecureContext?: boolean; ClipboardItem?: ClipEnv['ClipboardItem'] };
  const clip = g.isSecureContext && g.navigator?.clipboard ? (g.navigator.clipboard as unknown as ClipEnv['clipboard']) : null;
  return { clipboard: clip, ClipboardItem: typeof g.ClipboardItem === 'function' ? g.ClipboardItem : null, copy: copyText };
}

/**
 * Put `link` on the clipboard as soon as it resolves. Call it synchronously from
 * the click handler: the write is requested right away (still inside the user's
 * gesture) with the link as a pending ClipboardItem; without ClipboardItem — or
 * when the browser refuses a pending one — the link is copied once known. false:
 * the link never came (no room) or no way of copying worked.
 */
export async function copyWhenReady(link: Promise<string>, env: ClipEnv = clipEnv()): Promise<boolean> {
  if (env.clipboard?.write && env.ClipboardItem) {
    try {
      const blob = link.then((s) => new Blob([s], { type: 'text/plain' }));
      blob.catch(() => undefined);
      await env.clipboard.write([new env.ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      /* not supported / not allowed: copy the text once it is known */
    }
  }
  let text: string;
  try {
    text = await link;
  } catch {
    return false;
  }
  try {
    return await env.copy(text);
  } catch {
    return false;
  }
}

/**
 * The system share sheet is offered (navigator.share) on phones, tablets and
 * Macs — where it is the usual way to send a link (WeChat, Messages, AirDrop…).
 * Windows / Linux browsers that have it get the plain copy button only.
 */
export function canNativeShare(nav: { share?: unknown; canShare?: (d: { url: string }) => boolean } | undefined, os: OsId, url = 'https://example.com/'): boolean {
  if (!nav || typeof nav.share !== 'function') return false;
  if (os !== 'ios' && os !== 'android' && os !== 'mac' && os !== 'chromeos') return false;
  try {
    return typeof nav.canShare === 'function' ? nav.canShare({ url }) : true;
  } catch {
    return false;
  }
}

/** The shortcut that copies a selected text here: ⌘C on a Mac, 长按 on touch, else Ctrl+C. */
export function copyKeys(os: OsId, touch: boolean): string {
  if (os === 'mac') return '⌘C';
  if (touch || os === 'ios' || os === 'android') return tx('长按', 'long-press');
  return 'Ctrl+C';
}

/**
 * The line under the lobby's invite link: copied (by the title's button or 复制),
 * copying failed (the link is selected: 长按 / Ctrl+C), or not copied yet.
 */
export function inviteStatus(copied: boolean | null, os: OsId, touch: boolean): { kind: 'copied' | 'manual' | 'idle'; text: string } {
  if (copied === true) return { kind: 'copied', text: tx('✓ 已复制，发给朋友，点开就能进房间', '✓ Copied — send it to your friends: opening it takes them into this room') };
  if (copied === false) {
    const keys = copyKeys(os, touch);
    return {
      kind: 'manual',
      text: touch || os === 'ios' || os === 'android'
        ? tx('没能自动复制：长按上面的链接，选「拷贝」后发给朋友', "Couldn't copy by itself: long-press the link above, choose Copy and send it to your friends")
        : tx(`没能自动复制：链接已选中，按 ${keys} 复制后发给朋友`, `Couldn't copy by itself: the link is selected — press ${keys} and send it to your friends`),
    };
  }
  return { kind: 'idle', text: t('lobby.inviteHint') };
}
