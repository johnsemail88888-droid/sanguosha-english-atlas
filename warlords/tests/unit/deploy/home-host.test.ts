// deploy/home-host.sh — the Mac mini / Linux home server. Sourced with SGWL_LIB=1 (functions
// only, nothing is installed; it loads the neighbouring install.sh the same way) and its pure
// parts are run in bash: OS detection, the Node build pick, `tailscale status --json` and
// `tailscale funnel status --json` parsing, the launchd plists / systemd units, the daily
// update's "anyone playing?" check, log rotation, pmset. Plus `bash -n` and shellcheck when present.
// deploy/check.mjs (the end-to-end check) is covered for its pure parts too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without type declarations
import { endpoints, parseDohAnswer } from '../../../deploy/check.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/home-host.sh');
const TMP = mkdtempSync(path.join(tmpdir(), 'sgwl-home-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function sh(code: string, env: Record<string, string> = {}): { out: string; err: string; status: number | null } {
  const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; source "$1"; ${code}`, 'sh', SCRIPT], {
    cwd: TMP,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: TMP, SGWL_LIB: '1', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { out: r.stdout.trim(), err: r.stderr.trim(), status: r.status };
}
const ok = (code: string): boolean => sh(code).status === 0;

// what `tailscale status --json` prints on a Mac mini (trimmed): the machine's name ends with a dot
const STATUS = JSON.stringify({
  Version: '1.102.4',
  BackendState: 'Running',
  Self: {
    ID: 'n1',
    HostName: 'Mac mini',
    DNSName: 'mac-mini.tail1234.ts.net.',
    CapMap: { https: null, funnel: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null },
  },
  CertDomains: ['mac-mini.tail1234.ts.net'],
  Peer: { 'nodekey:x': { DNSName: 'phone.tail1234.ts.net.' } },
});
const SERVE_ON = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: { 'mac-mini.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } },
  AllowFunnel: { 'mac-mini.tail1234.ts.net:443': true },
});
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

describe('deploy/home-host.sh', () => {
  it('parses (bash -n)', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!shellcheck)('is shellcheck-clean', () => {
    const r = spawnSync('shellcheck', ['-x', SCRIPT], { cwd: path.dirname(SCRIPT), encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('sourced with SGWL_LIB=1 runs nothing and brings install.sh along', () => {
    const r = sh('echo loaded; type -t build_game fetch_source game_url relay_url systemd_unit | sort -u');
    expect(r.status).toBe(0);
    expect(r.out.split('\n')).toEqual(['loaded', 'function']);
    expect(r.err).toBe('');
    // home settings, not the cloud server's /opt/sgwl
    expect(sh('echo "$INSTALL_DIR|$APP_DIR|$APP_PORT"').out).toBe(`${TMP}/sanguo-warlords|${TMP}/sanguo-warlords/src/warlords|8787`);
  });

  it('knows macOS and Linux', () => {
    expect(sh('host_os Darwin').out).toBe('macos');
    expect(sh('host_os Linux').out).toBe('linux');
    expect(ok('host_os MINGW64_NT')).toBe(false);
  });

  it('picks the official Node build for the machine', () => {
    const sums = [
      'aa  node-v22.20.0-darwin-arm64.tar.gz',
      'bb  node-v22.20.0-darwin-arm64.tar.xz',
      'cc  node-v22.20.0-darwin-x64.tar.gz',
      'dd  node-v22.20.0-linux-arm64.tar.xz',
      'ee  node-v22.20.0-linux-x64.tar.xz',
    ].join('\n');
    expect(sh(`node_dist_file ${q(sums)} macos arm64`).out).toBe('node-v22.20.0-darwin-arm64.tar.gz');
    expect(sh(`node_dist_file ${q(sums)} macos x64`).out).toBe('node-v22.20.0-darwin-x64.tar.gz');
    expect(sh(`node_dist_file ${q(sums)} linux arm64`).out).toBe('node-v22.20.0-linux-arm64.tar.xz');
    expect(sh(`node_dist_file ${q(sums)} linux ppc64`).out).toBe('');
  });

  it('reads the machine name and HTTPS / Funnel rights from `tailscale status --json`', () => {
    expect(sh(`ts_status_fields <<<${q(STATUS)}`).out).toBe('Running mac-mini.tail1234.ts.net 1 1');
    // a fresh tailnet: HTTPS certificates and Funnel not granted yet
    const fresh = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'spark.tail9.ts.net.', CapMap: {} }, CertDomains: null });
    expect(sh(`ts_status_fields <<<${q(fresh)}`).out).toBe('Running spark.tail9.ts.net 0 0');
    // older clients list capabilities in an array
    const old = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail9.ts.net.', Capabilities: ['https', 'funnel'] } });
    expect(sh(`ts_status_fields <<<${q(old)}`).out).toBe('Running box.tail9.ts.net 1 1');
    expect(sh(`ts_status_fields <<<${q(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))}`).out).toBe('NeedsLogin - 0 0');
    expect(sh('ts_status_fields <<<"not json"').out).toBe('Unknown - 0 0');
  });

  it('reads what Funnel publishes from `tailscale funnel status --json`', () => {
    expect(sh(`funnel_target ${q(SERVE_ON)} mac-mini.tail1234.ts.net`).out).toBe('http://127.0.0.1:8787');
    expect(ok('funnel_points_here http://127.0.0.1:8787 8787')).toBe(true);
    expect(ok('funnel_points_here http://localhost:8787/ 8787')).toBe(true);
    expect(ok('funnel_points_here http://127.0.0.1:3000 8787')).toBe(false);
    expect(ok('funnel_points_here "" 8787')).toBe(false);
    // served inside the tailnet only (no AllowFunnel) = not public
    const serveOnly = JSON.stringify({ ...JSON.parse(SERVE_ON), AllowFunnel: {} });
    expect(sh(`funnel_target ${q(serveOnly)} mac-mini.tail1234.ts.net`).out).toBe('');
    expect(sh(`funnel_target '{}' mac-mini.tail1234.ts.net`).out).toBe('');
    expect(sh(`funnel_target ${q(SERVE_ON)} other.tail1234.ts.net`).out).toBe('');
  });

  it('the game URL and relay URL for the Funnel name', () => {
    expect(sh('game_url mac-mini.tail1234.ts.net; relay_url mac-mini.tail1234.ts.net').out.split('\n')).toEqual([
      'https://mac-mini.tail1234.ts.net/',
      'wss://mac-mini.tail1234.ts.net/ws',
    ]);
  });

  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
  const readPlist = (xml: string): Record<string, unknown> => {
    const f = path.join(TMP, `p${Math.random().toString(36).slice(2)}.plist`);
    writeFileSync(f, xml);
    const r = spawnSync('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', f], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };

  it('writes the LaunchAgent: caffeinate + node server.mjs on 127.0.0.1, kept alive', () => {
    const xml = sh(`launchd_plist com.sanguo-warlords.server /opt/homebrew/opt/node@22/bin/node "/Users/a&b/sanguo-warlords/src/warlords" 8787 /Users/x/server.log`).out;
    expect(xml).toContain('<string>/usr/bin/caffeinate</string>');
    expect(xml).toContain('<string>/Users/a&amp;b/sanguo-warlords/src/warlords/server/server.mjs</string>');
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    if (!python) return;
    const p = readPlist(xml);
    expect(p.Label).toBe('com.sanguo-warlords.server');
    expect(p.ProgramArguments).toEqual(['/usr/bin/caffeinate', '-is', '/opt/homebrew/opt/node@22/bin/node', '/Users/a&b/sanguo-warlords/src/warlords/server/server.mjs']);
    expect(p.EnvironmentVariables).toEqual({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8787' });
    expect(p.WorkingDirectory).toBe('/Users/a&b/sanguo-warlords/src/warlords');
    expect(p.KeepAlive).toBe(true);
    expect(p.StandardErrorPath).toBe('/Users/x/server.log');
  });

  it('writes the daily-update LaunchAgent (05:07) and the Linux timer', () => {
    const xml = sh('update_plist com.sanguo-warlords.update /Users/x/sanguo-warlords/bin/home-host.sh 5 7 /opt/homebrew/bin:/usr/bin:/bin /Users/x/update.log').out;
    if (python) {
      const p = readPlist(xml);
      expect(p.ProgramArguments).toEqual(['/bin/bash', '/Users/x/sanguo-warlords/bin/home-host.sh', 'auto-update']);
      expect(p.StartCalendarInterval).toEqual({ Hour: 5, Minute: 7 });
      expect(p.EnvironmentVariables).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
    } else expect(xml).toContain('<integer>7</integer>');
    const units = sh('update_units /home/me/sanguo-warlords/bin/home-host.sh me 5 7 /usr/bin:/bin').out.split('\n---\n');
    expect(units).toHaveLength(2);
    expect(units[0]).toContain('ExecStart=/bin/bash /home/me/sanguo-warlords/bin/home-host.sh auto-update');
    expect(units[0]).toContain('User=me');
    expect(units[0]).toContain('Type=oneshot');
    expect(units[1]).toContain('OnCalendar=*-*-* 05:07:00');
    expect(units[1]).toContain('Persistent=true');
  });

  it('writes the Linux game service with install.sh’s unit, as the user', () => {
    const unit = sh('systemd_unit /usr/bin/node /home/me/sanguo-warlords/src/warlords 8787 me home-host.sh').out;
    expect(unit).toContain('written by warlords/deploy/home-host.sh');
    expect(unit).toContain('ExecStart=/usr/bin/node /home/me/sanguo-warlords/src/warlords/server/server.mjs');
    expect(unit).toContain('User=me');
    expect(unit).toContain('Environment=HOST=127.0.0.1');
    expect(unit).toContain('Restart=always');
  });

  it('the daily update waits while anyone plays (/sgwl.json)', () => {
    expect(sh(`stat_field '{"app":"sanguo-warlords","relay":"/ws","peer":"/peerjs","rooms":2,"players":5,"droppedUnreliable":0}' players`).out).toBe('5');
    expect(sh(`stat_field '{"app":"sanguo-warlords","rooms":0,"players":0}' rooms`).out).toBe('0');
    expect(sh(`stat_field '{}' rooms`).out).toBe('0');
    expect(ok(`game_busy '{"rooms":1,"players":0}'`)).toBe(true);
    expect(ok(`game_busy '{"rooms":0,"players":3}'`)).toBe(true);
    expect(ok(`game_busy '{"rooms":0,"players":0,"droppedUnreliable":12}'`)).toBe(false);
  });

  it('rotates a log over the size limit (copy + truncate, one old copy kept)', () => {
    const f = path.join(TMP, 'server.log');
    writeFileSync(f, 'x'.repeat(2000));
    expect(sh(`rotate_log "${f}" 5000`).status).toBe(0);
    expect(statSync(f).size).toBe(2000);
    expect(sh(`rotate_log "${f}" 1000`).status).toBe(0);
    expect(statSync(f).size).toBe(0);
    expect(readFileSync(`${f}.1`, 'utf8')).toHaveLength(2000);
    expect(sh(`rotate_log "${path.join(TMP, 'missing.log')}" 10`).status).toBe(0);
  });

  it('tells whether pmset already keeps the Mac up', () => {
    const on = 'System-wide power settings:\nCurrently in use:\n standby              0\n sleep                0 (sleep prevented by caffeinate)\n autorestart          1\n womp                 1\n';
    const off = 'Currently in use:\n sleep                1\n autorestart          0\n displaysleep         10\n';
    expect(ok(`pmset_ok ${q(on)}`)).toBe(true);
    expect(ok(`pmset_ok ${q(off)}`)).toBe(false);
    expect(sh('echo "$PMSET_CMD"').out).toBe('sudo pmset -a sleep 0 autorestart 1 womp 1');
  });

  it('prints how to get Tailscale when it is missing', () => {
    expect(sh('tailscale_help macos').out).toContain('https://tailscale.com/download/mac');
    expect(sh('tailscale_help macos').out).toContain('brew install --cask tailscale-app');
    expect(sh('tailscale_help linux').out).toContain('curl -fsSL https://tailscale.com/install.sh | sh');
  });

  it('the one-liner in the header points at this file', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain(
      'curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/home-host.sh | bash',
    );
  });
});

describe('deploy/check.mjs', () => {
  it('derives the info and relay endpoints from the game URL', () => {
    expect(endpoints('https://mac-mini.tail1234.ts.net/')).toEqual({
      host: 'mac-mini.tail1234.ts.net',
      info: 'https://mac-mini.tail1234.ts.net/sgwl.json',
      relay: 'wss://mac-mini.tail1234.ts.net/ws',
    });
    expect(endpoints('http://127.0.0.1:8787')).toMatchObject({ info: 'http://127.0.0.1:8787/sgwl.json', relay: 'ws://127.0.0.1:8787/ws' });
    expect(endpoints('ftp://x')).toBeNull();
    expect(endpoints('nope')).toBeNull();
  });

  it('reads IPv4 answers from DNS-over-HTTPS JSON', () => {
    expect(parseDohAnswer({ Status: 0, Answer: [{ type: 5, data: 'x.ts.net.' }, { type: 1, data: '100.20.3.4' }] })).toEqual(['100.20.3.4']);
    expect(parseDohAnswer({ Status: 3 })).toEqual([]);
    expect(parseDohAnswer(null)).toEqual([]);
  });
});
