// deploy/home-host.sh + install.sh — the access key and the 5-minute auto-update, sourced with
// SGWL_LIB=1 and run in bash: the key is made once (URL-safe, ≥ 24 characters), kept in host.env
// (600), put into the LaunchAgent (600) / an EnvironmentFile (600), printed as the share link;
// rotate-key; the auto-update's decisions (busy → nothing; GitHub's head vs the build here; CI
// passed / running / failed / no run; rate limits; failed builds; the restart that had to wait),
// each reason to skip logged at most once an hour; the lock; Tailscale key expiry.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/home-host.sh');
const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/install.sh');
const TMP = mkdtempSync(path.join(tmpdir(), 'sgwl-ops-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function run(script: string, code: string, env: Record<string, string> = {}): { out: string; err: string; status: number | null } {
  const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; source "$1"; ${code}`, 'sh', script], {
    cwd: TMP,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: TMP, SGWL_LIB: '1', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { out: r.stdout.trim(), err: r.stderr.trim(), status: r.status };
}
const sh = (code: string, env: Record<string, string> = {}) => run(SCRIPT, code, env);
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const mode = (f: string): number => statSync(f).mode & 0o777;

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const readPlist = (xml: string): Record<string, unknown> => {
  const f = path.join(TMP, `p${Math.random().toString(36).slice(2)}.plist`);
  writeFileSync(f, xml);
  const r = spawnSync('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', f], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as Record<string, unknown>;
};

describe('the access key', () => {
  it('gen_relay_key: 32 URL-safe characters, different every time (openssl, else node)', () => {
    const keys = sh('for i in 1 2 3; do gen_relay_key; done').out.split('\n');
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(new Set(keys).size).toBe(3);
    // no openssl on PATH: node makes it
    const bin = path.join(TMP, 'no-openssl');
    mkdirSync(bin, { recursive: true });
    for (const tool of ['node', 'tr', 'head', 'bash', 'sed', 'dirname', 'cat', 'mktemp', 'grep', 'uname']) {
      const at = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (at && !existsSync(path.join(bin, tool))) spawnSync('ln', ['-s', at, path.join(bin, tool)]);
    }
    expect(sh('gen_relay_key', { PATH: bin }).out).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(sh('valid_relay_key abc').status).not.toBe(0);
    expect(sh('valid_relay_key "has space in it and long enough"').status).not.toBe(0);
    expect(sh(`valid_relay_key ${'A'.repeat(24)}`).status).toBe(0);
  });

  it('made once on the first install, kept in host.env (600) after that; SGWL_RELAY_KEY sets it or turns it off', () => {
    const dir = mkdtempSync(path.join(TMP, 'key-'));
    const env = { SGWL_DIR: dir };
    const first = sh('load_key_setting; DOMAIN=mac.tail1.ts.net; save_state; echo "KEY=$RELAY_KEY"', env);
    expect(first.status).toBe(0);
    expect(first.out).toContain('made an access key');
    const key = /KEY=([A-Za-z0-9_-]+)/.exec(first.out)![1];
    expect(key).toHaveLength(32);
    const state = path.join(dir, 'host.env');
    expect(readFileSync(state, 'utf8')).toContain(`RELAY_KEY=${key}\n`);
    expect(mode(state)).toBe(0o600);
    // the next run keeps it (and says nothing about a new key)
    const again = sh('load_key_setting; echo "KEY=$RELAY_KEY"', env);
    expect(again.out).toBe(`KEY=${key}`);
    expect(sh('load_state; echo "$RELAY_KEY"', env).out).toBe(key);
    // SGWL_RELAY_KEY: a key of your own, or off (remembered by save_state)
    const own = 'my-own-key_0123456789abcdefXYZ';
    expect(sh('load_key_setting; echo "$RELAY_KEY"', { ...env, SGWL_RELAY_KEY: own }).out).toBe(own);
    const off = sh('load_key_setting; DOMAIN=m; save_state; echo "$RELAY_KEY"', { ...env, SGWL_RELAY_KEY: 'off' });
    expect(off.out).toBe('off');
    expect(off.err).toContain('access key off');
    expect(sh('load_key_setting; echo "$RELAY_KEY"', env).out).toBe('off'); // (remembered)
    expect(sh('load_key_setting', { ...env, SGWL_RELAY_KEY: 'short' }).status).not.toBe(0);
  });

  it('goes into the LaunchAgent (written 600) and, on Linux, an EnvironmentFile (600) — never into the unit', () => {
    const key = 'Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj';
    const xml = sh(`launchd_plist com.sanguo-warlords.server /usr/local/bin/node /Users/x/w 8787 /Users/x/server.log "" ${key}`).out;
    expect(xml).toMatch(new RegExp(`<key>RELAY_KEY</key>\\n\\t\\t<string>${key}</string>`));
    if (python) {
      expect(readPlist(xml).EnvironmentVariables).toEqual({
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '8787',
        NO_PEER: '1',
        MAX_ROOMS: '4',
        HOST_GRACE_MS: '120000',
        RELAY_KEY: key,
      });
    }
    expect(sh('launchd_plist l /n /d 8787 /log "" off').out).not.toContain('RELAY_KEY');
    // install_service writes the plist under umask 077
    const text = readFileSync(SCRIPT, 'utf8');
    const svc = text.slice(text.indexOf('install_service() {'), text.indexOf('# ── checks'));
    expect(svc).toMatch(/umask 077\n\s+launchd_plist .*"\$RELAY_KEY"/);
    expect(svc).toContain('write_key_env "$SERVER_ENV" "$RELAY_KEY"');
    const envFile = path.join(TMP, 'server.env');
    expect(sh(`write_key_env ${q(envFile)} ${key}`).status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain(`\nRELAY_KEY=${key}\n`);
    expect(mode(envFile)).toBe(0o600);
    expect(sh(`write_key_env ${q(envFile)} off`).status).toBe(0);
    expect(existsSync(envFile)).toBe(false);
  });

  it('the summary prints the SHARE LINK https://<domain>/?k=<key> — and the two old lines', () => {
    const key = 'Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj';
    expect(sh(`share_url mac.tail1.ts.net ${key}`).out).toBe(`https://mac.tail1.ts.net/?k=${key}`);
    expect(sh('share_url mac.tail1.ts.net off').out).toBe('https://mac.tail1.ts.net/');
    const box = sh(`DOMAIN=mac.tail1.ts.net; RELAY_KEY=${key}; print_summary`).out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(box).toContain(`分享链接 SHARE LINK:  https://mac.tail1.ts.net/?k=${key}`);
    expect(box).toContain('游戏网址 Game:   https://mac.tail1.ts.net/');
    expect(box).toContain('中继地址 Relay:  wss://mac.tail1.ts.net/ws');
    expect(box).toContain('把这两行发给 Claude');
    const open = sh('DOMAIN=mac.tail1.ts.net; RELAY_KEY=off; print_summary').out;
    expect(open).not.toContain('SHARE LINK');
    expect(open).toContain('access key: off');
    // status prints it too; the checks carry the key
    const text = readFileSync(SCRIPT, 'utf8');
    const status = text.slice(text.indexOf('cmd_status() {'), text.indexOf('auto_restart() {'));
    expect(status).toContain('RELAY_KEY=$(saved_relay_key)');
    expect(status).toContain('print_summary');
    expect(text).toMatch(/check\.mjs" "\$url" \$\{key\[@\]\+"\$\{key\[@\]\}"\}/);
    expect(text).toContain('key=("--key=$RELAY_KEY")');
  });

  it('rotate-key: a new key saved, the service rewritten with it, the new link printed', () => {
    const dir = mkdtempSync(path.join(TMP, 'rot-'));
    writeFileSync(path.join(dir, 'host.env'), 'DOMAIN=mac.tail1.ts.net\nRELAY_KEY=Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj\n');
    const r = sh(
      'node_path_setup() { :; }; server_stats() { echo "{}"; }; install_service() { echo "service with $RELAY_KEY"; }; ' +
        'cmd_rotate_key; echo "saved $(saved_relay_key)"',
      { SGWL_DIR: dir },
    );
    expect(r.status).toBe(0);
    const key = /saved ([A-Za-z0-9_-]+)/.exec(r.out)![1];
    expect(key).not.toBe('Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj');
    expect(r.out).toContain(`service with ${key}`);
    expect(r.out).toContain(`https://mac.tail1.ts.net/?k=${key}`);
    expect(r.err).toContain('old share links stop working');
    expect(mode(path.join(dir, 'host.env'))).toBe(0o600);
  });
});

describe('Tailscale key expiry', () => {
  it('reads Self.KeyExpiry; none when expiry is disabled', () => {
    const on = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'm.ts.net.', KeyExpiry: '2027-03-01T10:00:00Z' } });
    expect(sh(`ts_key_expiry <<<${q(on)}`).out).toBe('2027-03-01T10:00:00Z');
    expect(sh(`ts_key_expiry <<<${q(JSON.stringify({ Self: { DNSName: 'm.ts.net.' } }))}`).out).toBe('');
    expect(sh(`ts_key_expiry <<<${q(JSON.stringify({ Self: { KeyExpiry: '0001-01-01T00:00:00Z' } }))}`).out).toBe('');
    expect(sh('ts_key_expiry <<<"nope"').out).toBe('');
    // install / update and status warn
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text.slice(text.indexOf('ensure_tailscale() {'), text.indexOf('enable_funnel() {'))).toContain('warn_key_expiry');
    expect(text.slice(text.indexOf('cmd_status() {'), text.indexOf('auto_restart() {'))).toContain('warn_key_expiry');
    const bin = path.join(TMP, 'ts-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho '${on}'\n`);
    chmodSync(path.join(bin, 'tailscale'), 0o755);
    const w = sh(`TS=${q(path.join(bin, 'tailscale'))}; warn_key_expiry`);
    expect(w.err).toContain('2027-03-01');
    expect(w.err).toContain('Disable key expiry');
  });
});

describe('auto-update: pure decisions', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  it('update_decision: current / restart (a restart that had to wait) / check', () => {
    expect(sh(`update_decision ${A} ${A} ${A}`).out).toBe('current');
    expect(sh(`update_decision ${A} ${A} ${B}`).out).toBe('restart');
    expect(sh(`update_decision ${A} ${A} ""`).out).toBe('restart'); // (an older server that says no build)
    expect(sh(`update_decision ${A} ${B} ${B}`).out).toBe('check');
    expect(sh(`update_decision ${A} "" ""`).out).toBe('check');
  });

  it('ci_verdict: one passed run is enough; running → pending; all failed → failure; none; bad JSON', () => {
    const runs = (...r: Record<string, unknown>[]) => q(JSON.stringify({ total_count: r.length, workflow_runs: r }));
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'completed', conclusion: 'success' })} ${A}`).out).toBe('success');
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'completed', conclusion: 'failure' }, { head_sha: A, status: 'completed', conclusion: 'success' })} ${A}`).out).toBe('success'); // (a re-run passed)
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'in_progress', conclusion: null })} ${A}`).out).toBe('pending');
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'queued', conclusion: null })} ${A}`).out).toBe('pending');
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'completed', conclusion: 'failure' })} ${A}`).out).toBe('failure');
    expect(sh(`ci_verdict ${runs({ head_sha: A, status: 'completed', conclusion: 'cancelled' })} ${A}`).out).toBe('failure');
    expect(sh(`ci_verdict ${runs()} ${A}`).out).toBe('none');
    expect(sh(`ci_verdict ${runs({ head_sha: B, status: 'completed', conclusion: 'success' })} ${A}`).out).toBe('none'); // (another commit's)
    expect(sh(`ci_verdict ${q('{"message":"API rate limit exceeded"}')} ${A}`).out).toBe('unknown');
    expect(sh(`latest_green_sha ${runs({ head_sha: B, status: 'completed', conclusion: 'success' })}`).out).toBe(B);
    expect(sh(`latest_green_sha ${runs()}`).out).toBe('');
    expect(sh(`stat_sha ${q(JSON.stringify({ app: 'sanguo-warlords', rooms: 0, build: { compat: 'abc', sha: A }, uptime: 5 }))}`).out).toBe(A);
    expect(sh(`stat_sha ${q(JSON.stringify({ app: 'sanguo-warlords', build: { compat: null, sha: null } }))}`).out).toBe('');
  });

  it('github_api: the JSON on 200, status 2 on a rate limit (403 / 429), 1 when offline', () => {
    const bin = path.join(TMP, 'curl-bin');
    mkdirSync(bin, { recursive: true });
    // a stand-in curl: CODE is the HTTP status it answers, OFFLINE fails like a missing network
    writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\n[ -n "$OFFLINE" ] && exit 6\nprintf \'{"total_count":0}\\n%s\' "$CODE"\n');
    chmodSync(path.join(bin, 'curl'), 0o755);
    const env = (e: Record<string, string>) => ({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...e });
    expect(sh('github_api https://api.github.com/x', env({ CODE: '200' }))).toMatchObject({ status: 0, out: '{"total_count":0}' });
    expect(sh('github_api https://api.github.com/x', env({ CODE: '403' })).status).toBe(2);
    expect(sh('github_api https://api.github.com/x', env({ CODE: '429' })).status).toBe(2);
    expect(sh('github_api https://api.github.com/x', env({ CODE: '500' })).status).toBe(1);
    expect(sh('github_api https://api.github.com/x', env({ OFFLINE: '1' })).status).toBe(1);
    expect(sh('ci_runs_url "head_sha=abc&event=push"').out).toBe(
      'https://api.github.com/repos/johnsemail88888-droid/sanguosha-english-atlas/actions/workflows/warlords-ci.yml/runs?head_sha=abc&event=push',
    );
  });
});

describe('auto-update: a run every 5 minutes', () => {
  const HEAD = '1'.repeat(40);
  const OLD = '0'.repeat(40);
  const IDLE = JSON.stringify({ app: 'sanguo-warlords', rooms: 0, players: 0, headlessRooms: 0, headlessHumans: 0, headlessPlaying: 0, build: { sha: OLD } });
  const BUSY = JSON.stringify({ app: 'sanguo-warlords', rooms: 1, players: 3, build: { sha: OLD } });
  const runsOf = (status: string, conclusion: string | null, sha = HEAD) => JSON.stringify({ workflow_runs: [{ head_sha: sha, status, conclusion }] });

  /** A fresh install dir: host.env, the build on disk (.sgwl-sha = OLD). */
  function home(): string {
    const dir = mkdtempSync(path.join(TMP, 'au-'));
    writeFileSync(path.join(dir, 'host.env'), 'DOMAIN=mac.tail1.ts.net\nRELAY_KEY=Zm9vYmFyLWtleS0xMjM0NTY3ODkwYWJj\n');
    mkdirSync(path.join(dir, 'src', 'warlords'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'warlords', '.sgwl-sha'), `${OLD}\n`);
    return dir;
  }

  /**
   * One run of cmd_auto_update with the world stubbed: STATS (/sgwl.json), HEAD (GitHub's head;
   * empty = unreachable), RUNS (CI runs of the head; RUNS_RC 2 = rate limited), GREEN (the newest
   * passed run); fetch / build / restart only write to CALLS. BUILD_FAIL=1: the build dies.
   */
  function autoUpdate(dir: string, env: Record<string, string>): { out: string; err: string; status: number | null; calls: string[] } {
    const calls = path.join(dir, 'calls');
    const stubs = [
      'node_path_setup() { :; }',
      'rotate_logs() { :; }',
      'refresh_bin() { :; }',
      'scripts_changed() { return 1; }',
      'server_stats() { printf "%s" "${STATS:-}"; }',
      'remote_head_sha() { [[ -n ${HEAD:-} ]] && echo "$HEAD"; }',
      'github_api() { case $1 in *head_sha=*) [[ ${RUNS_RC:-0} == 0 ]] || return "$RUNS_RC"; printf "%s\\n" "${RUNS:-}";; *status=success*) printf "%s\\n" "${GREEN:-$NO_RUNS}";; esac; }',
      'fetch_source() { echo "fetch ${FETCH_REF}" >>"$CALLS"; FETCHED_SHA=$FETCH_REF; }',
      'build_game() { echo "build" >>"$CALLS"; [[ ${BUILD_FAIL:-0} == 0 ]] || exit 1; echo "$FETCHED_SHA" >"$APP_DIR/.sgwl-sha"; }',
      'service_kick() { echo "kick" >>"$CALLS"; }',
    ].join('; ');
    const r = sh(`${stubs}; cmd_auto_update`, { SGWL_DIR: dir, CALLS: calls, NO_RUNS: '{"workflow_runs":[]}', ...env });
    const lines = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
    rmSync(calls, { force: true });
    return { ...r, calls: lines };
  }

  it('nobody playing, GitHub has a commit its CI passed: fetch exactly it, build, restart', () => {
    const dir = home();
    const r = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success'), SGWL_NOW: '1000000' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([`fetch ${HEAD}`, 'build', 'kick']);
    expect(r.out).toContain('sgwl home-host.sh auto-update'); // (a heading: it did something)
    expect(r.out).toContain(`updating to ${HEAD.slice(0, 12)}`);
    // the next round: the build is the head and the server runs it → silent
    const quiet = autoUpdate(dir, { STATS: IDLE.replace(OLD, HEAD), HEAD, RUNS: runsOf('completed', 'success') });
    expect(quiet).toMatchObject({ status: 0, out: '', calls: [] });
  });

  it('someone playing: nothing at all (one log line an hour)', () => {
    const dir = home();
    const r1 = autoUpdate(dir, { STATS: BUSY, HEAD, RUNS: runsOf('completed', 'success'), SGWL_NOW: '1000000' });
    expect(r1.calls).toEqual([]);
    expect(r1.out).toContain('a game is on');
    const r2 = autoUpdate(dir, { STATS: BUSY, HEAD, SGWL_NOW: '1000300' }); // 5 minutes later
    expect(r2.out).toBe('');
    const r3 = autoUpdate(dir, { STATS: BUSY, HEAD, SGWL_NOW: `${1000000 + 3600}` }); // an hour later
    expect(r3.out).toContain('a game is on');
    // a server-hosted match under way whose player is reconnecting counts as playing
    const playing = JSON.stringify({ rooms: 1, players: 1, headlessRooms: 1, headlessHumans: 0, headlessPlaying: 1 });
    expect(autoUpdate(home(), { STATS: playing, HEAD, RUNS: runsOf('completed', 'success') }).calls).toEqual([]);
  });

  it('CI still running / failed / GitHub rate-limited / offline / server down: skip the round, say why once an hour', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ RUNS: runsOf('in_progress', null) }, /still running/],
      [{ RUNS: runsOf('completed', 'failure') }, /CI failed for 111111111111/],
      [{ RUNS_RC: '2' }, /rate limit/],
      [{ RUNS_RC: '1' }, /could not ask GitHub/],
      [{ HEAD: '' }, /GitHub unreachable/],
      [{ STATS: '' }, /does not answer/],
    ];
    for (const [e, why] of cases) {
      const dir = home();
      const r = autoUpdate(dir, { STATS: IDLE, HEAD, SGWL_NOW: '2000000', ...e });
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.out).toMatch(why);
      expect(autoUpdate(dir, { STATS: IDLE, HEAD, SGWL_NOW: '2000600', ...e }).out).toBe('');
    }
  });

  it('no CI run for the head (it touched nothing CI watches): the newest commit CI passed, if it is not built already', () => {
    const GREEN = '2'.repeat(40);
    const none = JSON.stringify({ workflow_runs: [] });
    const r = autoUpdate(home(), { STATS: IDLE, HEAD, RUNS: none, GREEN: runsOf('completed', 'success', GREEN) });
    expect(r.calls).toEqual([`fetch ${GREEN}`, 'build', 'kick']);
    const same = autoUpdate(home(), { STATS: IDLE, HEAD, RUNS: none, GREEN: runsOf('completed', 'success', OLD) });
    expect(same.calls).toEqual([]);
    expect(same.out).toMatch(/newest CI passed/);
  });

  it('a build that fails is not retried for an hour', () => {
    const dir = home();
    const r = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success'), BUILD_FAIL: '1', SGWL_NOW: '3000000' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([`fetch ${HEAD}`, 'build']);
    const soon = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success'), SGWL_NOW: '3000300' });
    expect(soon.calls).toEqual([]);
    expect(soon.out).toMatch(/failed within the hour/);
    const later = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success'), SGWL_NOW: `${3000300 + 3600}` });
    expect(later.calls).toEqual([`fetch ${HEAD}`, 'build', 'kick']);
  });

  it('built, but someone started playing meanwhile: no restart then — the next idle round restarts, once', () => {
    const dir = home();
    // the stats change between the first look and the re-check after the build
    const flip = path.join(dir, 'flip');
    const r = sh(
      [
        'node_path_setup() { :; }; rotate_logs() { :; }; refresh_bin() { :; }; scripts_changed() { return 1; }',
        `server_stats() { if [[ -f ${q(flip)} ]]; then printf '%s' ${q(BUSY)}; else printf '%s' ${q(IDLE)}; fi; }`,
        `remote_head_sha() { echo ${HEAD}; }`,
        `github_api() { printf '%s\\n' ${q(runsOf('completed', 'success'))}; }`,
        'fetch_source() { FETCHED_SHA=$FETCH_REF; }',
        `build_game() { echo "$FETCHED_SHA" >"$APP_DIR/.sgwl-sha"; touch ${q(flip)}; }`,
        'service_kick() { echo KICK; }',
        'cmd_auto_update',
      ].join('; '),
      { SGWL_DIR: dir },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('the restart waits');
    expect(r.out).not.toContain('KICK');
    // later, nobody plays: the server still runs OLD, the disk has HEAD → restart
    const later = autoUpdate(dir, { STATS: IDLE, HEAD });
    expect(later.calls).toEqual(['kick']);
    expect(later.out).toContain('restarting into the build waiting on disk');
    // a server that keeps saying OLD is not restarted every 5 minutes
    const again = autoUpdate(dir, { STATS: IDLE, HEAD });
    expect(again.calls).toEqual([]);
  });

  it('another install / update holds the lock: skip; a lock whose process is gone is taken over', () => {
    const dir = home();
    const sleeper = spawnSync('bash', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim();
    try {
      mkdirSync(path.join(dir, '.update.lock'));
      writeFileSync(path.join(dir, '.update.lock', 'pid'), `${sleeper}\n`);
      const r = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success') });
      expect(r.calls).toEqual([]);
      expect(r.out).toMatch(/another install or update is running/);
    } finally {
      process.kill(Number(sleeper));
    }
    writeFileSync(path.join(dir, '.update.lock', 'pid'), '999999\n'); // (no such process)
    const r2 = autoUpdate(dir, { STATS: IDLE, HEAD, RUNS: runsOf('completed', 'success') });
    expect(r2.calls).toEqual([`fetch ${HEAD}`, 'build', 'kick']);
    // released afterwards (main's EXIT trap; here by hand)
    expect(sh('acquire_lock 0 && echo held; release_lock; [[ -d $LOCK_DIR ]] || echo released', { SGWL_DIR: dir }).out).toBe('held\nreleased');
  });

  it('install / update wait for the lock; the hand-over keeps it (same process)', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const install = text.slice(text.indexOf('cmd_install() {'), text.indexOf('cmd_status() {'));
    expect(install).toMatch(/acquire_lock 2700/);
    expect(install).toContain('FETCH_REF=$(remote_head_sha || true)');
    expect(text).toContain('trap release_lock EXIT');
    expect(text).toContain('SGWL_TARGET_SHA=$FETCHED_SHA SGWL_REEXEC=1 exec bash');
    const dir = home();
    mkdirSync(path.join(dir, '.update.lock'));
    writeFileSync(path.join(dir, '.update.lock', 'pid'), 'SELF');
    expect(sh(`sed -i "s/SELF/$$/" ${q(path.join(dir, '.update.lock', 'pid'))}; acquire_lock 0 && echo mine`, { SGWL_DIR: dir }).out).toBe('mine');
  });
});

describe('install.sh: shared build steps', () => {
  const ish = (code: string, env: Record<string, string> = {}) => run(INSTALL, code, env);

  it('a source tarball pinned to a commit keeps the build being served until the new one replaces it', () => {
    const root = mkdtempSync(path.join(TMP, 'tar-'));
    const repo = path.join(root, 'repo', 'sanguosha-english-atlas-x', 'warlords');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), '{"name":"new"}');
    const tgz = path.join(root, 'src.tgz');
    spawnSync('tar', ['-czf', tgz, '-C', path.join(root, 'repo'), 'sanguosha-english-atlas-x']);
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // a stand-in curl: records the URL, "downloads" the tarball to -o
    writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nout=''; url=''\nwhile [ $# -gt 0 ]; do case $1 in -o) out=$2; shift;; http*) url=$1;; esac; shift; done\necho "$url" >>"${root}/urls"\ncp ${q(tgz)} "$out"\n`);
    chmodSync(path.join(bin, 'curl'), 0o755);
    const inst = path.join(root, 'inst');
    const app = path.join(inst, 'src', 'warlords');
    mkdirSync(path.join(app, 'dist'), { recursive: true });
    mkdirSync(path.join(app, 'node_modules', 'vite'), { recursive: true });
    writeFileSync(path.join(app, 'dist', 'index.html'), 'live');
    writeFileSync(path.join(app, '.sgwl-sha'), `${'0'.repeat(40)}\n`);
    writeFileSync(path.join(app, 'package.json'), '{"name":"old"}');
    const sha = 'c'.repeat(40);
    const r = ish(`INSTALL_DIR=${q(inst)}; SRC_DIR=${q(path.join(inst, 'src'))}; APP_DIR=${q(app)}; FETCH_REF=${sha}; git_ok() { return 1; }; fetch_source; echo "FETCHED=$FETCHED_SHA"`, {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`FETCHED=${sha}`);
    expect(readFileSync(path.join(root, 'urls'), 'utf8').trim()).toBe(`https://codeload.github.com/johnsemail88888-droid/sanguosha-english-atlas/tar.gz/${sha}`);
    expect(readFileSync(path.join(app, 'package.json'), 'utf8')).toBe('{"name":"new"}');
    expect(readFileSync(path.join(app, 'dist', 'index.html'), 'utf8')).toBe('live');
    expect(existsSync(path.join(app, 'node_modules', 'vite'))).toBe(true);
    expect(readFileSync(path.join(app, '.sgwl-sha'), 'utf8').trim()).toBe('0'.repeat(40));
  });

  it('build_game: keeps the previous bundles, precompresses, bakes VITE_ASSET_CDN, stamps the commit last', () => {
    const src = readFileSync(INSTALL, 'utf8');
    const body = src.slice(src.indexOf('build_game() {'), src.indexOf('\n}\n', src.indexOf('build_game() {')));
    expect(body).toContain('VITE_ASSET_CDN=$ASSET_CDN');
    expect(body).toContain('node scripts/keep-old-assets.mjs dist dist.new --days=3');
    expect(body).toContain('node scripts/precompress.mjs dist.new');
    expect(body.indexOf('keep-old-assets')).toBeLessThan(body.indexOf('mv dist.new dist'));
    expect(body.indexOf('precompress')).toBeLessThan(body.indexOf('mv dist.new dist'));
    expect(ish(`asset_cdn_base ${'d'.repeat(40)}`).out).toBe(`https://cdn.jsdelivr.net/gh/johnsemail88888-droid/sanguosha-english-atlas@${'d'.repeat(40)}/warlords/public/`);
    expect(ish('asset_cdn_base main').status).not.toBe(0);
    // no commit known / turned off: no CDN
    expect(ish('FETCHED_SHA=""; resolve_asset_cdn; echo "[$ASSET_CDN]"').out).toBe('[]');
    expect(ish(`FETCHED_SHA=${'d'.repeat(40)}; resolve_asset_cdn; echo "[$ASSET_CDN]"`, { SGWL_ASSET_CDN: 'off' }).out).toBe('[]');
    const dir = mkdtempSync(path.join(TMP, 'stamp-'));
    expect(ish(`cd ${q(dir)}; FETCHED_SHA=${'e'.repeat(40)}; stamp_build; cat .sgwl-sha`).out).toBe('e'.repeat(40));
    expect(ish(`cd ${q(dir)}; FETCHED_SHA=""; stamp_build; [[ -f .sgwl-sha ]] || echo gone`).out).toBe('gone');
  });
});
