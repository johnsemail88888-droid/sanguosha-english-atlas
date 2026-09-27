// 邀请朋友一起玩: one click → a room, its link on the clipboard, the lobby says so.
import { describe, expect, it } from 'vitest';
import { canNativeShare, copyKeys, copyWhenReady, inviteStatus, pendingLink, type ClipEnv } from '../../../src/ui/quickInvite';

/** A clipboard that records what lands on it (ClipboardItem with a pending Blob, or a plain copy). */
function fakeEnv(o: { item?: boolean; writeFails?: boolean; copyOk?: boolean } = {}): ClipEnv & { log: string[]; calls: string[] } {
  const log: string[] = [];
  const calls: string[] = [];
  class Item {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  return {
    log,
    calls,
    clipboard: o.item === false ? null : {
      async write(items: unknown[]) {
        calls.push('write');
        if (o.writeFails) throw new Error('NotAllowedError');
        const blob = await (items[0] as Item).items['text/plain'];
        log.push(await blob.text());
      },
    },
    ClipboardItem: o.item === false ? null : (Item as unknown as ClipEnv['ClipboardItem']),
    async copy(text) {
      calls.push('copy');
      if (o.copyOk === false) return false;
      log.push(text);
      return true;
    },
  };
}

describe('pendingLink', () => {
  it('settles once: the room link, or a rejection (no room)', async () => {
    const p = pendingLink();
    p.settle('https://x/?room=AB12');
    p.settle(null);
    await expect(p.link).resolves.toBe('https://x/?room=AB12');
    const q = pendingLink();
    q.settle(null);
    await expect(q.link).rejects.toThrow();
  });
});

describe('copyWhenReady (the clipboard write starts inside the click)', () => {
  it('asks for the write at once with the link still pending, and lands the link when the room exists', async () => {
    const env = fakeEnv();
    const p = pendingLink();
    const done = copyWhenReady(p.link, env);
    // requested synchronously — still inside the user's gesture
    expect(env.calls).toEqual(['write']);
    p.settle('https://x/?room=KX7QD&mode=peer');
    await expect(done).resolves.toBe(true);
    expect(env.log).toEqual(['https://x/?room=KX7QD&mode=peer']);
  });

  it('no ClipboardItem (or a pending one refused): copies the text once it is known', async () => {
    for (const env of [fakeEnv({ item: false }), fakeEnv({ writeFails: true })]) {
      const p = pendingLink();
      const done = copyWhenReady(p.link, env);
      p.settle('https://x/?room=AB12');
      await expect(done).resolves.toBe(true);
      expect(env.log).toEqual(['https://x/?room=AB12']);
      expect(env.calls.at(-1)).toBe('copy');
    }
  });

  it('false when the room never came, or no way of copying worked (the lobby selects the link instead)', async () => {
    const failed = pendingLink();
    const env = fakeEnv();
    const done = copyWhenReady(failed.link, env);
    failed.settle(null);
    await expect(done).resolves.toBe(false);
    expect(env.log).toEqual([]);
    const refused = pendingLink();
    const env2 = fakeEnv({ writeFails: true, copyOk: false });
    const done2 = copyWhenReady(refused.link, env2);
    refused.settle('https://x/?room=AB12');
    await expect(done2).resolves.toBe(false);
  });
});

describe('the lobby line under the link', () => {
  it('copied / manual (长按 · Ctrl+C · ⌘C) / not yet', () => {
    expect(inviteStatus(true, 'windows', false)).toMatchObject({ kind: 'copied', text: expect.stringContaining('已复制，发给朋友，点开就能进房间') });
    expect(inviteStatus(false, 'windows', false)).toMatchObject({ kind: 'manual', text: expect.stringContaining('Ctrl+C') });
    expect(inviteStatus(false, 'mac', false).text).toContain('⌘C');
    expect(inviteStatus(false, 'android', true).text).toContain('长按');
    expect(inviteStatus(null, 'windows', false).kind).toBe('idle');
    expect(copyKeys('mac', false)).toBe('⌘C');
    expect(copyKeys('windows', false)).toBe('Ctrl+C');
    expect(copyKeys('ios', true)).toBe('长按');
  });

  it('the share sheet: phones, tablets and Macs that have navigator.share — not Windows / Linux', () => {
    const share = (): Promise<void> => Promise.resolve();
    expect(canNativeShare({ share }, 'ios')).toBe(true);
    expect(canNativeShare({ share }, 'android')).toBe(true);
    expect(canNativeShare({ share }, 'mac')).toBe(true);
    expect(canNativeShare({ share }, 'windows')).toBe(false);
    expect(canNativeShare({ share }, 'linux')).toBe(false);
    expect(canNativeShare({}, 'mac')).toBe(false);
    expect(canNativeShare(undefined, 'ios')).toBe(false);
    expect(canNativeShare({ share, canShare: () => false }, 'mac')).toBe(false);
  });
});
