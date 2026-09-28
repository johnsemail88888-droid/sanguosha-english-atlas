// electron/updater.cjs: how each kind of install gets a new build — the setup build and the
// AppImage through electron-updater (background download, install on quit, 重启并更新), the
// portable exe / the Mac app / an unpacked Linux folder through their own check of latest*.yml and
// a 下载 offer — never during a match, silent when offline, nothing in a dev run.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// electron-updater's cancellation (main.cjs hands the updater a factory for these)
const { CancellationToken } = require('builder-util-runtime') as typeof import('builder-util-runtime');
type CancellationToken = InstanceType<typeof CancellationToken>;
const ROOT = path.resolve(__dirname, '../../..');
type Kind = 'nsis' | 'appimage' | 'portable' | 'mac' | 'linux' | 'none';
interface State {
  kind: Kind;
  auto: boolean;
  current: string;
  build: number | null;
  status: string;
  version?: string;
  percent?: number;
  url?: string;
  setupUrl?: string;
}
interface Updater {
  state(): State;
  onChange(cb: (s: State) => void): () => void;
  start(): void;
  check(): Promise<void>;
  download(which?: 'setup'): void;
  restart(): void;
  setPlaying(on: boolean): void;
}
const U = require(path.join(ROOT, 'electron/updater.cjs')) as {
  REPO: string;
  FEED_URL: string;
  RELEASES_URL: string;
  FIRST_CHECK_MS: number;
  CHECK_EVERY_MS: number;
  updateKind(o: { platform: string; env?: Record<string, string>; isPackaged: boolean }): Kind;
  feedFile(kind: Kind): string;
  feedFromAppUpdateYml(text: unknown): string | null;
  compareVersions(a: string, b: string): number;
  isNewer(a: string, b: string): boolean;
  buildOf(v: string): number | null;
  releaseTag(v: string): string | null;
  parseFeed(text: unknown): { version: string; files: string[] } | null;
  portableName(v: string): string;
  setupName(v: string): string;
  dmgName(v: string, arch: string): string;
  downloadTarget(o: { kind: Kind; version: string; files?: string[]; arch?: string }): { url: string; setupUrl?: string };
  createUpdater(deps: Record<string, unknown>): Updater;
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG_URL = `https://github.com/${U.REPO}/releases/download`;

// what electron-builder 26 writes (a real latest-linux.yml; the Mac one lists both dmgs)
const LINUX_YML = `version: 0.1.43
files:
  - url: SanguoWarlords-0.1.43-Linux.AppImage
    sha512: tNCKI4ugxEF9h25AbA3JenrQzfifYzjL6Ud0aMWmRwfNbBiJqxaQmiWUuYS3S04CKdxzCxWdVi5YvBnIo4ya3Q==
    size: 156500515
    blockMapSize: 164407
path: SanguoWarlords-0.1.43-Linux.AppImage
sha512: tNCKI4ugxEF9h25AbA3JenrQzfifYzjL6Ud0aMWmRwfNbBiJqxaQmiWUuYS3S04CKdxzCxWdVi5YvBnIo4ya3Q==
releaseDate: '2026-09-28T05:00:25.368Z'
`;
const MAC_YML = `version: '0.1.43'
files:
  - url: SanguoWarlords-0.1.43-macOS-x64.dmg
    sha512: aaa
    size: 1
  - url: SanguoWarlords-0.1.43-macOS-arm64.dmg
    sha512: bbb
    size: 2
path: SanguoWarlords-0.1.43-macOS-x64.dmg
sha512: aaa
releaseDate: '2026-09-28T05:00:25.368Z'
`;
const WIN_YML = `version: 0.1.43
files:
  - url: SanguoWarlords-0.1.43-Windows-setup.exe
    sha512: ccc
    size: 3
path: SanguoWarlords-0.1.43-Windows-setup.exe
sha512: ccc
releaseDate: '2026-09-28T05:00:25.368Z'
`;

describe('which update path an install takes', () => {
  it('setup build / AppImage: automatic; portable / Mac / unpacked Linux: offered; dev run: none', () => {
    expect(U.updateKind({ platform: 'win32', env: {}, isPackaged: true })).toBe('nsis');
    expect(U.updateKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Games' }, isPackaged: true })).toBe('portable');
    expect(U.updateKind({ platform: 'darwin', env: {}, isPackaged: true })).toBe('mac');
    expect(U.updateKind({ platform: 'linux', env: { APPIMAGE: '/home/a/SanguoWarlords.AppImage' }, isPackaged: true })).toBe('appimage');
    expect(U.updateKind({ platform: 'linux', env: {}, isPackaged: true })).toBe('linux');
    for (const platform of ['win32', 'darwin', 'linux']) expect(U.updateKind({ platform, env: { APPIMAGE: '/x', PORTABLE_EXECUTABLE_DIR: 'C:\\' }, isPackaged: false })).toBe('none');
    expect(U.updateKind({ platform: 'freebsd', isPackaged: true })).toBe('none');
    expect(U.feedFile('nsis')).toBe('latest.yml');
    expect(U.feedFile('portable')).toBe('latest.yml');
    expect(U.feedFile('mac')).toBe('latest-mac.yml');
    expect(U.feedFile('appimage')).toBe('latest-linux.yml');
    expect(U.feedFile('linux')).toBe('latest-linux.yml');
  });

  it('the feed is package.json build.publish (generic, releases/latest/download) — electron-builder puts it in app-update.yml', () => {
    expect(pkg.build.publish).toEqual([{ provider: 'generic', url: U.FEED_URL, useMultipleRangeRequest: false }]);
    expect(U.FEED_URL).toBe('https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest/download');
    // what electron-builder wrote into resources/app-update.yml (npx electron-builder --linux dir)
    const yml = 'provider: generic\nurl: https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest/download\nupdaterCacheDirName: sanguo-warlords-updater\n';
    expect(U.feedFromAppUpdateYml(yml)).toBe(U.FEED_URL);
    expect(U.feedFromAppUpdateYml("provider: generic\nurl: 'http://127.0.0.1:8899/feed/'\n")).toBe('http://127.0.0.1:8899/feed');
    expect(U.feedFromAppUpdateYml('provider: github\nowner: x\n')).toBeNull();
    expect(U.feedFromAppUpdateYml(undefined)).toBeNull();
    // electron-updater needs the dependency packaged: a production dependency, pinned
    expect(pkg.dependencies['electron-updater']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('differential updates ask GitHub for one byte range per request (it answers a multi-range request 501)', () => {
    // electron-updater's own reading of the config electron-builder copies into app-update.yml:
    // with several ranges per request every "download only the changed blocks" attempt failed on
    // github.com (501 Unsupported client range) and fell back to the whole installer / AppImage
    const factory = require('electron-updater/out/providerFactory') as {
      createClient(cfg: unknown, updater: unknown, opts: unknown): { constructor: { name: string }; isUseMultipleRangeRequest: boolean };
    };
    const client = factory.createClient(pkg.build.publish[0], {}, { isUseMultipleRangeRequest: true, platform: 'win32', executor: {} });
    expect(client.constructor.name).toBe('GenericProvider');
    expect(client.isUseMultipleRangeRequest).toBe(false);
    // (without the flag it would be multi-range)
    expect(factory.createClient({ provider: 'generic', url: U.FEED_URL }, {}, { platform: 'win32', executor: {} }).isUseMultipleRangeRequest).toBe(true);
  });

  it('the asset names the updater builds are package.json’s artifactName patterns', () => {
    const fill = (pattern: string, arch = ''): string => pattern.replace('${version}', '0.1.43').replace('${arch}', arch);
    expect(U.portableName('0.1.43')).toBe(fill(pkg.build.portable.artifactName));
    expect(U.setupName('0.1.43')).toBe(fill(pkg.build.nsis.artifactName));
    expect(U.dmgName('0.1.43', 'arm64')).toBe(fill(pkg.build.dmg.artifactName, 'arm64'));
    expect(U.dmgName('0.1.43', 'x64')).toBe(fill(pkg.build.dmg.artifactName, 'x64'));
  });
});

describe('versions', () => {
  it('compares major.minor.patch numerically (0.1.10 > 0.1.9); junk never counts as newer', () => {
    expect(U.compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(U.compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(U.compareVersions('0.1.9', '0.1.9')).toBe(0);
    expect(U.compareVersions('v1.0.0', '0.9.99')).toBe(1);
    expect(U.compareVersions('0.2.0', '0.1.999')).toBe(1);
    expect(U.isNewer('0.1.43', '0.1.0')).toBe(true); // the first auto-updating build vs every older install
    expect(U.isNewer('0.1.42', '0.1.43')).toBe(false);
    expect(U.isNewer('0.1.43', '0.1.43')).toBe(false);
    expect(U.isNewer('garbage', '0.1.0')).toBe(false);
    expect(U.isNewer('', '0.1.0')).toBe(false);
  });

  it('build number and release tag of a CI version (0.1.<run> ↔ warlords-build-<run>)', () => {
    expect(U.buildOf('0.1.43')).toBe(43);
    expect(U.releaseTag('0.1.43')).toBe('warlords-build-43');
    expect(U.buildOf('0.1.0')).toBeNull(); // a local build: no release
    expect(U.releaseTag('0.1.0')).toBeNull();
    expect(U.buildOf('x')).toBeNull();
  });

  it('reads electron-builder’s latest*.yml (quoted or not, one or two files)', () => {
    expect(U.parseFeed(LINUX_YML)).toEqual({ version: '0.1.43', files: ['SanguoWarlords-0.1.43-Linux.AppImage'] });
    expect(U.parseFeed(MAC_YML)).toEqual({ version: '0.1.43', files: ['SanguoWarlords-0.1.43-macOS-x64.dmg', 'SanguoWarlords-0.1.43-macOS-arm64.dmg'] });
    expect(U.parseFeed(WIN_YML)?.files).toEqual(['SanguoWarlords-0.1.43-Windows-setup.exe']);
    expect(U.parseFeed('<html>rate limited</html>')).toBeNull();
    expect(U.parseFeed('version: latest\n')).toBeNull();
    expect(U.parseFeed(undefined)).toBeNull();
  });
});

describe('what 下载 opens (manual updates)', () => {
  it('portable: the new portable exe of that exact release, and the setup build as the way out', () => {
    expect(U.downloadTarget({ kind: 'portable', version: '0.1.43', files: ['SanguoWarlords-0.1.43-Windows-setup.exe'] })).toEqual({
      url: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-Windows-portable.exe`,
      setupUrl: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-Windows-setup.exe`,
    });
  });

  it('Mac: the dmg for this chip (arm64 / x64) from the feed’s own file list', () => {
    const files = U.parseFeed(MAC_YML)!.files;
    expect(U.downloadTarget({ kind: 'mac', version: '0.1.43', files, arch: 'arm64' })).toEqual({ url: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-macOS-arm64.dmg` });
    expect(U.downloadTarget({ kind: 'mac', version: '0.1.43', files, arch: 'x64' })).toEqual({ url: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-macOS-x64.dmg` });
    // a feed without the file list: the artifact name pattern
    expect(U.downloadTarget({ kind: 'mac', version: '0.1.43', files: [], arch: 'arm64' }).url).toBe(`${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-macOS-arm64.dmg`);
  });

  it('anything unsure: the releases page', () => {
    expect(U.downloadTarget({ kind: 'linux', version: '0.1.43' })).toEqual({ url: U.RELEASES_URL });
    expect(U.downloadTarget({ kind: 'mac', version: '0.1.43', arch: 'ia32' })).toEqual({ url: U.RELEASES_URL });
    expect(U.downloadTarget({ kind: 'portable', version: '0.1.0' })).toEqual({ url: U.RELEASES_URL });
    expect(U.RELEASES_URL).toBe('https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest');
  });
});

// ── the updater of one app run ───────────────────────────────────────────────

interface Harness {
  u: Updater;
  states: State[];
  opened: string[];
  fetched: string[];
  timers: { ms: number; fn: () => void; every: boolean }[];
  au: FakeAutoUpdater;
  logs: string[];
}

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: unknown = null;
  checks = 0;
  downloads = 0;
  installs: [boolean, boolean][] = [];
  /** what the next check finds: a version, or an Error (offline) */
  next: string | Error = '0.1.43';
  checkForUpdates(): Promise<unknown> {
    this.checks++;
    const n = this.next;
    if (n instanceof Error) {
      this.emit('error', n);
      return Promise.reject(n);
    }
    if (n === 'none') this.emit('update-not-available', { version: '0.1.42' });
    else this.emit('update-available', { version: n });
    return Promise.resolve({ updateInfo: { version: n } });
  }
  /** hold: a download stays on its way until finish() (or its token is cancelled, like electron-updater's) */
  hold = false;
  tokens: CancellationToken[] = [];
  finish: (() => void) | null = null;
  downloadUpdate(token?: CancellationToken): Promise<unknown> {
    this.downloads++;
    if (token) this.tokens.push(token);
    if (!this.hold || !token) return Promise.resolve([]);
    return token.createPromise<unknown>((resolve) => {
      this.finish = () => {
        this.emit('update-downloaded', { version: this.next });
        resolve([]);
      };
    });
  }
  quitAndInstall(silent: boolean, runAfter: boolean): void {
    this.installs.push([silent, runAfter]);
  }
}

/** let promise callbacks (a cancelled download winding down) run */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(o: { platform: string; env?: Record<string, string>; version?: string; packaged?: boolean; arch?: string; feed?: Record<string, string | Error> }): Harness {
  const states: State[] = [];
  const opened: string[] = [];
  const fetched: string[] = [];
  const timers: Harness['timers'] = [];
  const logs: string[] = [];
  const au = new FakeAutoUpdater();
  const u = U.createUpdater({
    app: { isPackaged: o.packaged ?? true, getVersion: () => o.version ?? '0.1.42' },
    platform: o.platform,
    arch: o.arch ?? 'x64',
    env: o.env ?? {},
    log: { info: (...a: unknown[]) => logs.push(a.join(' ')), warn: (...a: unknown[]) => logs.push(a.join(' ')) },
    openExternal: (url: string) => void opened.push(url),
    fetchText: async (url: string) => {
      fetched.push(url);
      const file = url.slice(url.lastIndexOf('/') + 1);
      const r = o.feed?.[file];
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('HTTP 404');
      return r;
    },
    loadAutoUpdater: () => au,
    newCancellationToken: () => new CancellationToken(),
    setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms, every: false }),
    setInterval: (fn: () => void, ms: number) => void timers.push({ fn, ms, every: true }),
    now: () => 1_000,
  });
  u.onChange((s) => states.push(s));
  return { u, states, opened, fetched, timers, au, logs };
}

describe('automatic updates (setup build, AppImage)', () => {
  it('checks 10 s after the window shows and every 4 h; downloads in the background; ready → 重启并更新 installs silently and reopens', async () => {
    const h = harness({ platform: 'win32' });
    expect(h.u.state()).toEqual({ kind: 'nsis', auto: true, current: '0.1.42', build: 42, status: 'idle' });
    h.u.start();
    h.u.start(); // once per run
    expect(h.timers.map((t) => [t.ms, t.every])).toEqual([
      [U.FIRST_CHECK_MS, false],
      [U.CHECK_EVERY_MS, true],
    ]);
    expect(U.FIRST_CHECK_MS).toBe(10_000);
    expect(U.CHECK_EVERY_MS).toBe(4 * 60 * 60 * 1000);
    // electron-updater: our own download (never autoDownload: a match must not share its bandwidth), install on quit
    await h.u.check();
    expect(h.au.autoDownload).toBe(false);
    expect(h.au.autoInstallOnAppQuit).toBe(true);
    expect(h.au.allowPrerelease).toBe(false);
    expect(h.au.allowDowngrade).toBe(false);
    expect(h.au.checks).toBe(1);
    expect(h.au.downloads).toBe(1);
    h.au.emit('download-progress', { percent: 37.8 });
    expect(h.u.state()).toMatchObject({ status: 'downloading', version: '0.1.43', percent: 37 });
    h.au.emit('update-downloaded', { version: '0.1.43' });
    expect(h.u.state()).toMatchObject({ status: 'ready', version: '0.1.43' });
    // ready: no more checks this run (it installs on quit)
    await h.u.check();
    expect(h.au.checks).toBe(1);
    h.u.restart();
    expect(h.au.installs).toEqual([[true, true]]);
    // (the second 'downloading' is the progress: 0 % → 37 %)
    expect(h.states.map((s) => s.status)).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready']);
  });

  it('nothing new: up to date; offline / GitHub down: silent (the state says error, one log line, nothing thrown)', async () => {
    const h = harness({ platform: 'linux', env: { APPIMAGE: '/a/b.AppImage' } });
    h.au.next = 'none';
    await h.u.check();
    expect(h.u.state()).toMatchObject({ kind: 'appimage', status: 'latest' });
    h.au.next = new Error('net::ERR_INTERNET_DISCONNECTED');
    await expect(h.u.check()).resolves.toBeUndefined();
    expect(h.u.state().status).toBe('error');
    expect(h.logs.filter((l) => l.includes('ERR_INTERNET_DISCONNECTED'))).toHaveLength(1);
    // a later check recovers
    h.au.next = '0.1.43';
    await h.u.check();
    expect(h.u.state()).toMatchObject({ status: 'downloading', version: '0.1.43' });
  });

  it('never during a match: the check, the download and the restart wait for its end', async () => {
    const h = harness({ platform: 'win32' });
    h.u.setPlaying(true);
    await h.u.check();
    expect(h.au.checks).toBe(0);
    h.u.setPlaying(false); // the due check runs now
    await Promise.resolve();
    expect(h.au.checks).toBe(1);
    expect(h.au.downloads).toBe(1);
    // found while playing: the download waits
    const g = harness({ platform: 'win32' });
    await g.u.check();
    g.au.emit('update-downloaded', { version: '0.1.43' });
    g.u.setPlaying(true);
    g.u.restart();
    expect(g.au.installs).toEqual([]);
    g.u.setPlaying(false);
    g.u.restart();
    expect(g.au.installs).toHaveLength(1);
    const k = harness({ platform: 'win32' });
    k.u.setPlaying(false);
    // the check starts on the title screen, the match starts before the answer: the download it
    // started stops, and starts again at the match's end
    const p = k.u.check();
    k.u.setPlaying(true);
    await p;
    await flush();
    expect(k.au.downloads).toBe(1);
    expect(k.au.tokens[0].cancelled).toBe(true);
    expect(k.u.state().status).toBe('available');
    k.u.setPlaying(false);
    expect(k.au.downloads).toBe(2);
    const m = harness({ platform: 'win32' });
    m.au.checkForUpdates = function (this: FakeAutoUpdater) {
      this.checks++;
      m.u.setPlaying(true); // hero select opened while GitHub answered
      this.emit('update-available', { version: '0.1.43' });
      return Promise.resolve({});
    };
    await m.u.check();
    expect(m.au.downloads).toBe(0);
    expect(m.u.state().status).toBe('available');
    m.u.setPlaying(false);
    expect(m.au.downloads).toBe(1);
  });

  it('a download on its way stops when a match starts (its bandwidth) and starts again at the end — not an error', async () => {
    const h = harness({ platform: 'win32' });
    h.au.hold = true;
    await h.u.check();
    h.au.emit('download-progress', { percent: 20 });
    expect(h.u.state()).toMatchObject({ status: 'downloading', percent: 20 });
    h.u.setPlaying(true); // hero select
    expect(h.au.tokens[0].cancelled).toBe(true);
    expect(h.u.state()).toMatchObject({ status: 'available', version: '0.1.43', percent: 0 });
    h.au.emit('download-progress', { percent: 21 }); // a late event of the stopped download
    await flush();
    expect(h.u.state().status).toBe('available');
    expect(h.logs.filter((l) => /failed/.test(l))).toEqual([]);
    // a check during the match waits too
    await h.u.check();
    expect(h.au.checks).toBe(1);
    expect(h.au.downloads).toBe(1);
    h.u.setPlaying(false); // back on the title screen
    expect(h.au.downloads).toBe(2);
    expect(h.u.state().status).toBe('downloading');
    h.au.finish!();
    await flush();
    expect(h.u.state()).toMatchObject({ status: 'ready', version: '0.1.43' });
    // a match now: nothing to stop (it installs on quit)
    h.u.setPlaying(true);
    expect(h.u.state().status).toBe('ready');
    expect(h.au.tokens[1].cancelled).toBe(false);
  });

  it('a match that ends before the stopped download has wound down: it starts again once it has', async () => {
    const h = harness({ platform: 'linux', env: { APPIMAGE: '/a/b.AppImage' } });
    h.au.hold = true;
    await h.u.check();
    h.u.setPlaying(true);
    h.u.setPlaying(false); // (the cancellation has not settled yet: electron-updater would hand back the dying download)
    expect(h.au.downloads).toBe(1);
    await flush();
    expect(h.au.downloads).toBe(2);
    expect(h.au.tokens[1].cancelled).toBe(false);
    expect(h.u.state().status).toBe('downloading');
  });

  it('restart does nothing unless an update is downloaded', async () => {
    const h = harness({ platform: 'win32' });
    h.u.restart();
    await h.u.check();
    h.u.restart(); // still downloading
    expect(h.au.installs).toEqual([]);
  });
});

describe('offered updates (portable exe, Mac, unpacked Linux)', () => {
  it('portable: reads latest.yml, offers the new portable exe (and the setup build); 下载 opens it in the browser', async () => {
    const h = harness({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Games' }, feed: { 'latest.yml': WIN_YML } });
    await h.u.check();
    expect(h.fetched).toEqual([`${U.FEED_URL}/latest.yml`]);
    expect(h.u.state()).toMatchObject({
      kind: 'portable',
      auto: false,
      status: 'available',
      version: '0.1.43',
      url: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-Windows-portable.exe`,
      setupUrl: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-Windows-setup.exe`,
    });
    h.u.download();
    h.u.download('setup');
    expect(h.opened).toEqual([h.u.state().url, h.u.state().setupUrl]);
    // electron-updater is never loaded for a portable exe
    expect(h.au.checks).toBe(0);
    h.u.restart();
    expect(h.au.installs).toEqual([]);
  });

  it('Mac: latest-mac.yml, the dmg for this chip', async () => {
    const h = harness({ platform: 'darwin', arch: 'arm64', feed: { 'latest-mac.yml': MAC_YML } });
    await h.u.check();
    expect(h.fetched).toEqual([`${U.FEED_URL}/latest-mac.yml`]);
    expect(h.u.state()).toMatchObject({ kind: 'mac', status: 'available', url: `${TAG_URL}/warlords-build-43/SanguoWarlords-0.1.43-macOS-arm64.dmg` });
    expect(h.au.checks).toBe(0); // Squirrel.Mac cannot apply an update to an ad-hoc signed app
  });

  it('up to date, rate-limited, offline, a broken feed: silent — and an offer already made stays', async () => {
    const same = harness({ platform: 'darwin', version: '0.1.43', feed: { 'latest-mac.yml': MAC_YML } });
    await same.u.check();
    expect(same.u.state().status).toBe('latest');
    const newer = harness({ platform: 'darwin', version: '0.1.44', feed: { 'latest-mac.yml': MAC_YML } });
    await newer.u.check();
    expect(newer.u.state().status).toBe('latest'); // never a downgrade
    const feeds: Record<string, string | Error>[] = [{ 'latest-mac.yml': new Error('HTTP 403 (rate limited)') }, { 'latest-mac.yml': '<html>' }, {}];
    for (const feed of feeds) {
      const h = harness({ platform: 'darwin', feed });
      await expect(h.u.check()).resolves.toBeUndefined();
      expect(h.u.state().status).toBe('error');
    }
    const flaky: Record<string, string | Error> = { 'latest-mac.yml': MAC_YML };
    const h = harness({ platform: 'darwin', arch: 'x64', feed: flaky });
    await h.u.check();
    flaky['latest-mac.yml'] = new Error('offline');
    await h.u.check();
    expect(h.u.state()).toMatchObject({ status: 'available', version: '0.1.43' });
  });

  it('a feed of its own build (app-update.yml) is the one it reads', async () => {
    const h = harness({ platform: 'linux', feed: { 'latest-linux.yml': LINUX_YML } });
    const custom = U.createUpdater({
      app: { isPackaged: true, getVersion: () => '0.1.5' },
      platform: 'linux',
      env: {},
      feedUrl: 'http://127.0.0.1:8899/feed/',
      fetchText: async (url: string) => {
        h.fetched.push(url);
        return LINUX_YML;
      },
      openExternal: () => undefined,
      loadAutoUpdater: () => h.au,
      log: { info: () => undefined, warn: () => undefined },
    });
    await custom.check();
    expect(h.fetched).toEqual(['http://127.0.0.1:8899/feed/latest-linux.yml']);
    expect(custom.state()).toMatchObject({ kind: 'linux', status: 'available', url: U.RELEASES_URL });
  });
});

describe('the Mac CI smoke run (warlords-mac.yml: SGWL_DESKTOP_SMOKE)', () => {
  it('never starts update checks (no GitHub request, no update offered to the CI build)', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8');
    const starts = main.split('\n').filter((l) => /getUpdater\(\)\.start\(\)/.test(l));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatch(/if \(!\(Number\(process\.env\.SGWL_DESKTOP_SMOKE\) > 0\)\) getUpdater\(\)\.start\(\);/);
    expect(fs.readFileSync(path.resolve(ROOT, '../.github/workflows/warlords-mac.yml'), 'utf8')).toMatch(/SGWL_DESKTOP_SMOKE/);
  });
});

describe('a dev run (npm run electron)', () => {
  it('never checks, never starts timers, ignores every action', async () => {
    const h = harness({ platform: 'win32', packaged: false, version: '0.1.0', feed: { 'latest.yml': WIN_YML } });
    h.u.start();
    await h.u.check();
    h.u.download();
    h.u.restart();
    h.u.setPlaying(false);
    expect(h.timers).toEqual([]);
    expect(h.fetched).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.au.checks).toBe(0);
    expect(h.u.state()).toEqual({ kind: 'none', auto: false, current: '0.1.0', build: null, status: 'idle' });
  });
});
