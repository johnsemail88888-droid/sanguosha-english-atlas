// deploy/install.sh — the one-command official server installer. The script is
// sourced with SGWL_LIB=1 (functions only, nothing is installed) and its pure parts
// are run in bash: IP → sslip.io name, IP checks, the Caddyfile (written into a temp
// dir), the systemd unit, the two lines the player sends back. Plus `bash -n` and,
// when the machine has it, shellcheck.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/install.sh');
const TMP = mkdtempSync(path.join(tmpdir(), 'sgwl-install-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Run `code` in bash with the installer's functions loaded. */
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

describe('deploy/install.sh', () => {
  it('parses (bash -n)', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!shellcheck)('is shellcheck-clean', () => {
    const r = spawnSync('shellcheck', ['-x', SCRIPT], { encoding: 'utf8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  }, 60_000); // shellcheck -x follows install.sh: seconds on a busy machine

  it('sourced with SGWL_LIB=1 runs nothing (no root check, no output)', () => {
    const r = sh('echo loaded');
    expect(r.status).toBe(0);
    expect(r.out).toBe('loaded');
    expect(r.err).toBe('');
  });

  it('turns the public IPv4 into its sslip.io name', () => {
    expect(sh('sslip_host 47.242.10.3').out).toBe('47-242-10-3.sslip.io');
    expect(sh('sslip_host 8.8.8.8').out).toBe('8-8-8-8.sslip.io');
    expect(ok('sslip_host 1.2.3')).toBe(false);
    expect(ok('sslip_host 300.1.1.1')).toBe(false);
    expect(ok('valid_domain "$(sslip_host 47.242.10.3)"')).toBe(true);
  });

  it('accepts only public IPv4 addresses from the IP-echo services', () => {
    for (const ip of ['47.242.10.3', '8.8.8.8', '101.32.1.1', '172.32.0.1', '100.128.0.1']) expect(ok(`is_public_ipv4 ${ip}`), ip).toBe(true);
    for (const ip of ['10.0.0.5', '192.168.1.2', '172.16.0.1', '172.31.255.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', 'abc', '1.2.3.4.5', '256.1.1.1'])
      expect(ok(`is_public_ipv4 ${ip}`), ip).toBe(false);
  });

  it('finds the IP in an IP-echo answer (plain or the Chinese myip.ipip.net sentence)', () => {
    expect(sh('extract_ipv4 "47.242.10.3"').out).toBe('47.242.10.3');
    expect(sh('extract_ipv4 "当前 IP：47.242.10.3  来自于：中国 香港 阿里云"').out).toBe('47.242.10.3');
    expect(sh('extract_ipv4 "<html>nope</html>"').out).toBe('');
  });

  it('validates a DOMAIN override', () => {
    expect(ok('valid_domain game.example.com')).toBe(true);
    expect(ok('valid_domain localhost')).toBe(false);
    expect(ok('valid_domain "evil.com { }"')).toBe(false);
    expect(ok('valid_domain "a..b"')).toBe(false);
  });

  it('prints the game URL and the relay URL for the domain', () => {
    expect(sh('game_url 47-242-10-3.sslip.io; relay_url 47-242-10-3.sslip.io').out.split('\n')).toEqual([
      'https://47-242-10-3.sslip.io/',
      'wss://47-242-10-3.sslip.io/ws',
    ]);
  });

  it('writes a Caddyfile: HTTPS for the domain, /ws and /peerjs proxied as WebSockets, the rest compressed', () => {
    const file = path.join(TMP, 'caddy', 'Caddyfile');
    const first = sh(`write_caddyfile "${file}" 47-242-10-3.sslip.io 8787 && echo changed`);
    expect(first.out).toBe('changed');
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^47-242-10-3\.sslip\.io \{$/m);
    expect(text).toContain('@sockets path /ws /ws/* /peerjs /peerjs/*');
    expect(text.match(/reverse_proxy 127\.0\.0\.1:8787/g)).toHaveLength(2);
    expect(text).toContain('encode zstd gzip');
    // braces balance (Caddy refuses anything else)
    expect(text.split('{').length).toBe(text.split('}').length);
    // idempotent: the same config is not rewritten (Caddy is not reloaded for nothing)
    expect(sh(`write_caddyfile "${file}" 47-242-10-3.sslip.io 8787 && echo changed || echo same`).out).toBe('same');
    expect(sh(`write_caddyfile "${file}" game.example.com 8787 && echo changed || echo same`).out).toBe('changed');
    expect(readFileSync(file, 'utf8')).toMatch(/^game\.example\.com \{$/m);
  });

  const caddy = spawnSync('caddy', ['version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!caddy)('Caddy accepts the Caddyfile (caddy validate)', () => {
    const file = path.join(TMP, 'validate', 'Caddyfile');
    expect(sh(`write_caddyfile "${file}" 47-242-10-3.sslip.io 8787`).status).toBe(0);
    const r = spawnSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], { cwd: TMP, encoding: 'utf8', env: { ...process.env, HOME: TMP, XDG_DATA_HOME: TMP, XDG_CONFIG_HOME: TMP } });
    expect(`${r.stdout}${r.stderr}`).toContain('Valid configuration');
    expect(r.status).toBe(0);
    // no formatting complaints either (tabs, as `caddy fmt` writes it)
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/not formatted/i);
  });

  it('writes the sgwl systemd unit: server.mjs on 127.0.0.1:<port>, restarted on failure', () => {
    const unit = sh('systemd_unit /usr/bin/node /opt/sgwl/src/warlords 8787 sgwl').out;
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/sgwl/src/warlords/server/server.mjs');
    expect(unit).toContain('WorkingDirectory=/opt/sgwl/src/warlords');
    expect(unit).toContain('Environment=HOST=127.0.0.1');
    expect(unit).toContain('Environment=PORT=8787');
    expect(unit).toContain('User=sgwl');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).not.toContain('HEADLESS');
    // SGWL_HEADLESS=0: no server-hosted matches
    const off = sh('systemd_unit /usr/bin/node /opt/sgwl/src/warlords 8787 sgwl install.sh 0').out;
    expect(off).toMatch(/^Environment=PORT=8787\nEnvironment=HEADLESS=0\nExecStart=/m);
    expect(sh('systemd_unit /usr/bin/node /opt/sgwl/src/warlords 8787 sgwl install.sh 1').out).not.toContain('HEADLESS');
  });

  it('the access key: an EnvironmentFile for the unit (not the unit itself), kept in the state file (600), a share link', () => {
    const unit = sh('systemd_unit /usr/bin/node /opt/sgwl/src/warlords 8787 sgwl install.sh "" /etc/sgwl-key.env').out;
    expect(unit).toMatch(/^Environment=PORT=8787\nEnvironmentFile=-\/etc\/sgwl-key.env\nExecStart=/m);
    const both = sh('systemd_unit /usr/bin/node /w 8787 sgwl install.sh 0 /k.env A=1 B=two').out;
    expect(both).toMatch(/^Environment=PORT=8787\nEnvironment=HEADLESS=0\nEnvironment=A=1\nEnvironment=B=two\nEnvironmentFile=-\/k.env\nExecStart=/m);
    // install / update: made once, then kept
    const state = path.join(TMP, 'key-state.env');
    const first = sh('load_state; ensure_relay_key; DOMAIN=a.example.com; save_state; echo "$RELAY_KEY"', { SGWL_STATE: state });
    expect(first.out.split('\n').pop()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const key = first.out.split('\n').pop()!;
    expect(readFileSync(state, 'utf8')).toContain(`RELAY_KEY=${key}\n`);
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(sh('load_state; ensure_relay_key; echo "$RELAY_KEY"', { SGWL_STATE: state }).out).toBe(key);
    expect(sh('load_state; ensure_relay_key; echo "$RELAY_KEY"', { SGWL_STATE: state, SGWL_RELAY_KEY: 'off' }).out.split('\n').pop()).toBe('off');
    const box = sh(`DOMAIN=a.example.com; RELAY_KEY=${key}; print_summary`).out;
    expect(box).toContain(`https://a.example.com/?k=${key}`);
    expect(box).toContain('把这两行发给 Claude');
    expect(readFileSync(SCRIPT, 'utf8')).toContain('rotate-key) cmd_rotate_key ;;');
  });

  it('remembers SGWL_HEADLESS in the state file (the environment wins)', () => {
    const state = path.join(TMP, 'sgwl.env');
    writeFileSync(state, '# written by warlords/deploy/install.sh\nDOMAIN=game.example.com\nSGWL_HEADLESS=0\n');
    expect(sh('load_state; echo "$DOMAIN|$HEADLESS_SETTING"', { SGWL_STATE: state }).out).toBe('game.example.com|0');
    expect(sh('load_state; echo "$HEADLESS_SETTING"', { SGWL_STATE: state, SGWL_HEADLESS: '1' }).out).toBe('1');
    const saved = path.join(TMP, 'saved.env');
    expect(sh('DOMAIN=a.example.com; save_state', { SGWL_STATE: saved, SGWL_HEADLESS: '0' }).status).toBe(0);
    expect(readFileSync(saved, 'utf8')).toContain('SGWL_HEADLESS=0\n');
  });

  describe('build_headless (the server-hosted match worker; optional)', () => {
    // a stand-in `npm`: `npm run -s build:headless` writes dist-headless/room-worker.mjs when STUB_BUILD=ok
    const bin = path.join(TMP, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'npm'),
      '#!/bin/sh\n[ "$*" = "run -s build:headless" ] || exit 9\n[ "$STUB_BUILD" = ok ] || exit 1\nmkdir -p dist-headless && echo "export {}" > dist-headless/room-worker.mjs\n',
    );
    chmodSync(path.join(bin, 'npm'), 0o755);
    const app = (scripts: Record<string, string>): string => {
      const dir = mkdtempSync(path.join(TMP, 'app-'));
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }, null, 2));
      mkdirSync(path.join(dir, 'dist-headless'));
      writeFileSync(path.join(dir, 'dist-headless', 'room-worker.mjs'), '// the previous version');
      return dir;
    };
    const run = (dir: string, env: Record<string, string>) => sh(`cd "${dir}" && build_headless`, { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...env });
    const worker = (dir: string): string | null => (existsSync(path.join(dir, 'dist-headless', 'room-worker.mjs')) ? readFileSync(path.join(dir, 'dist-headless', 'room-worker.mjs'), 'utf8').trim() : null);

    it('builds dist-headless/room-worker.mjs', () => {
      const dir = app({ build: 'x', 'build:headless': 'vite build -c vite.headless.config.ts' });
      const r = run(dir, { STUB_BUILD: 'ok' });
      expect(r.status).toBe(0);
      expect(worker(dir)).toBe('export {}');
    });

    it('a failed build warns, removes the stale bundle and carries on (relay-only)', () => {
      const dir = app({ 'build:headless': 'vite build -c vite.headless.config.ts' });
      const r = run(dir, { STUB_BUILD: 'fail' });
      expect(r.status).toBe(0);
      expect(r.err).toContain('server-hosted matches did not build');
      expect(worker(dir)).toBeNull();
    });

    it('a version without the script: nothing to build, no stale bundle left', () => {
      const dir = app({ build: 'x' });
      const r = run(dir, { STUB_BUILD: 'ok' });
      expect(r.status).toBe(0);
      expect(worker(dir)).toBeNull();
    });

    it('build_game runs it after the page build, then stamps the commit (the build is complete)', () => {
      const src = readFileSync(SCRIPT, 'utf8');
      const body = src.slice(src.indexOf('build_game() {'), src.indexOf('\n}\n', src.indexOf('build_game() {')));
      expect(body.trim().split('\n').slice(-2).map((l) => l.trim())).toEqual(['build_headless', 'stamp_build']);
    });
  });

  it('the one-liners in the header point at this file', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/install.sh | sudo bash');
    expect(text).toContain('https://cdn.jsdelivr.net/gh/johnsemail88888-droid/sanguosha-english-atlas@main/warlords/deploy/install.sh');
    expect(text).toContain('把这两行发给 Claude');
  });
});
