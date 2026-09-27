// deploy/install.sh — the one-command official server installer. The script is
// sourced with SGWL_LIB=1 (functions only, nothing is installed) and its pure parts
// are run in bash: IP → sslip.io name, IP checks, the Caddyfile (written into a temp
// dir), the systemd unit, the two lines the player sends back. Plus `bash -n` and,
// when the machine has it, shellcheck.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  });

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
  });

  it('the one-liners in the header point at this file', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('curl -fsSL https://raw.githubusercontent.com/johnsemail88888-droid/sanguosha-english-atlas/main/warlords/deploy/install.sh | sudo bash');
    expect(text).toContain('https://cdn.jsdelivr.net/gh/johnsemail88888-droid/sanguosha-english-atlas@main/warlords/deploy/install.sh');
    expect(text).toContain('把这两行发给 Claude');
  });
});
