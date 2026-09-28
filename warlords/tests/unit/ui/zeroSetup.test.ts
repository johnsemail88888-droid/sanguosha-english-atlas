// Zero setup, with the server this build really ships (src/net/official.ts — the owner's Mac mini):
// a fresh desktop / web profile plays online on 官方服务器（推荐） without touching a setting, and an
// invite made in the desktop app opens the official web page, which connects to the same server.
// (The test run itself builds with VITE_OFFICIAL_RELAY='' and never talks to that server.)
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/game/settings';
import { OFFICIAL_SERVER, isOfficialRelay, isOfficialWeb, officialFrom, officialServer, setOfficialServerForTests } from '../../../src/net/official';
import { desktopInfo, resetLanUrlsForTests, shareBase } from '../../../src/ui/desktop';
import { overrideLang, t } from '../../../src/ui/i18n';
import { choiceChosen, choiceOf, choicePatch, defaultChoice, inviteLink, modeChosen, modeOfChoice, parseInvite } from '../../../src/ui/invite';

const WEB = 'https://zhifengmac-mini.tail1ae114.ts.net/';
const RELAY = 'wss://zhifengmac-mini.tail1ae114.ts.net/ws';
const g = globalThis as { sgwlDesktop?: unknown };

afterEach(() => {
  setOfficialServerForTests(undefined);
  delete g.sgwlDesktop;
  resetLanUrlsForTests();
  overrideLang(null);
});

/** What a first launch has: default settings, no pick made, nothing in storage. */
function freshProfile(): { choice: ReturnType<typeof defaultChoice>; net: typeof DEFAULT_SETTINGS.net } {
  const net = structuredClone(DEFAULT_SETTINGS.net);
  const choice = defaultChoice({ mode: net.mode, wsUrl: net.wsUrl, chosen: choiceChosen() });
  return { choice, net: { ...net, ...choicePatch(choice, net, officialServer(), null) } };
}

describe('zero setup with the shipped official server', () => {
  it('the shipped build’s official server is the Mac mini (web page + relay on the same host)', () => {
    expect(officialFrom(OFFICIAL_SERVER)).toEqual({ web: WEB, relay: RELAY });
    // the tests are built without it (vite.config.ts test.env) and never reach it
    expect(officialServer()).toBeNull();
  });

  it('a fresh profile (desktop or web) plays on 官方服务器（推荐） — no setting to touch', () => {
    setOfficialServerForTests(OFFICIAL_SERVER);
    expect(modeChosen()).toBe(false);
    expect(choiceChosen()).toBe(false);
    const p = freshProfile();
    expect(p.choice).toBe('official');
    expect(modeOfChoice(p.choice)).toBe('ws');
    expect(p.net).toMatchObject({ mode: 'ws', wsUrl: RELAY });
    // what the online screen and 设置 → 网络 show for it
    expect(choiceOf(p.net.mode, p.net.wsUrl)).toBe('official');
    overrideLang('zh');
    expect(t('online.official')).toBe('官方服务器（推荐）');
  });

  it('an invite from the desktop app opens the official web page, which joins the same room on the same server', () => {
    setOfficialServerForTests(OFFICIAL_SERVER);
    // the desktop app: page on its embedded server, LAN addresses known
    g.sgwlDesktop = { isDesktop: true, lanUrls: ['http://192.168.1.5:8787/'], port: 8787 };
    expect(desktopInfo()).not.toBeNull();
    const app = { origin: 'http://127.0.0.1:8787', pathname: '/' };
    const p = freshProfile();
    const link = inviteLink('KX7QD', app, { mode: modeOfChoice(p.choice), net: p.net });
    expect(link.startsWith(`${WEB}?room=KX7QD`)).toBe(true);
    const url = new URL(link);
    // the friend's click: the official page …
    expect(isOfficialWeb(url.origin)).toBe(true);
    // … connecting to the same relay, the same room, the same way
    const inv = parseInvite(url.search);
    expect(inv).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: RELAY } });
    expect(isOfficialRelay(inv.net.wsUrl)).toBe(true);
    expect(choiceOf(inv.mode!, inv.net.wsUrl ?? '')).toBe('official');
    // a P2P room made in the app is shared through the official page too (never 127.0.0.1)
    expect(shareBase(app, 'peer')).toBe(WEB);
    expect(link).not.toContain('127.0.0.1');
  });

  it('the web page on GitHub Pages invites to the official page as well', () => {
    setOfficialServerForTests(OFFICIAL_SERVER);
    const pages = { origin: 'https://johnsemail88888-droid.github.io', pathname: '/sanguosha-english-atlas/warlords/' };
    const p = freshProfile();
    expect(inviteLink('KX7QD', pages, { mode: 'ws', net: p.net }).startsWith(`${WEB}?room=KX7QD`)).toBe(true);
  });
});
