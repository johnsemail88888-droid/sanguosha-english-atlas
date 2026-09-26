// LAN address ranking (server/lan.mjs): used by the server banner and the
// desktop app's LAN list / clipboard copy — the first address must be the one
// friends on the same Wi-Fi can actually reach.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without type declarations
import { isLoopbackHost, lanAddressesFrom, rankLanAddresses } from '../../../server/lan.mjs';
// @ts-expect-error plain .mjs without type declarations
import { startServer } from '../../../server/server.mjs';

type Nic = { address: string; family: string; internal: boolean };
const v4 = (address: string, internal = false): Nic => ({ address, family: 'IPv4', internal });

describe('LAN address ranking', () => {
  it('puts the real Wi-Fi / Ethernet address before host-only and virtual adapters', () => {
    expect(rankLanAddresses(['192.168.56.1', '172.24.160.1', '192.168.1.23'])[0]).toBe('192.168.1.23');
    expect(rankLanAddresses(['192.168.56.1', '172.24.160.1', '192.168.1.23'])).toEqual(['192.168.1.23', '172.24.160.1', '192.168.56.1']);
    expect(rankLanAddresses(['169.254.10.2', '10.0.0.8'])).toEqual(['10.0.0.8', '169.254.10.2']);
    expect(rankLanAddresses(['100.101.1.2', '192.168.0.5'])[0]).toBe('192.168.0.5'); // Tailscale / CGNAT last
  });

  it('uses adapter names: typical Windows / macOS / Linux machines', () => {
    const windows: Record<string, Nic[]> = {
      'VirtualBox Host-Only Network': [v4('192.168.56.1')],
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.24.160.1')],
      'vEthernet (Default Switch)': [v4('192.168.208.1')], // a 192.168 address on a virtual switch
      'WLAN': [v4('192.168.1.23'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    };
    // the Wi-Fi adapter first, every virtual one after it (VirtualBox's host-only network last)
    expect(lanAddressesFrom(windows)).toEqual(['192.168.1.23', '192.168.208.1', '172.24.160.1', '192.168.56.1']);
    expect(lanAddressesFrom(windows)).not.toContain('127.0.0.1');
    const mac: Record<string, Nic[]> = { utun3: [v4('10.8.0.2')], en0: [v4('10.0.1.44')], bridge100: [v4('192.168.64.1')] };
    expect(lanAddressesFrom(mac)[0]).toBe('10.0.1.44');
    expect(lanAddressesFrom(mac).at(-1)).toBe('10.8.0.2'); // VPN tunnel last
    const linux: Record<string, Nic[]> = { docker0: [v4('172.17.0.1')], 'br-3f2a9c': [v4('172.18.0.1')], virbr0: [v4('192.168.122.1')], wlp2s0: [v4('192.168.0.17')] };
    expect(lanAddressesFrom(linux)[0]).toBe('192.168.0.17');
    expect(lanAddressesFrom(linux).slice(1).sort()).toEqual(['172.17.0.1', '172.18.0.1', '192.168.122.1']);
  });

  it('only virtual adapters: still listed (pushed last, never dropped); duplicates removed', () => {
    expect(lanAddressesFrom({ 'vEthernet (WSL)': [v4('172.24.160.1')] })).toEqual(['172.24.160.1']);
    expect(rankLanAddresses(['10.0.0.2', '10.0.0.2'])).toEqual(['10.0.0.2']);
  });

  it('knows loopback binds', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.23')).toBe(false);
  });
});

describe('server banner', () => {
  it('HOST=127.0.0.1: no "LAN" address is advertised, and it says how to enable LAN', async () => {
    const lines: string[] = [];
    const srv = await startServer({ port: 0, host: '127.0.0.1', distDir: '/nonexistent-sgwl-dist', peer: false, log: (m: string) => lines.push(m) });
    try {
      expect(srv.urls).toEqual([`http://localhost:${srv.port}`]);
      const text = lines.join('\n');
      expect(text).not.toMatch(/LAN:\s+http:\/\/127\.0\.0\.1/);
      expect(text).toContain('HOST=0.0.0.0');
      expect(text).toContain('设置 → 网络 → 中转服务器地址');
      expect(text).toContain('Settings → Network → Relay server URL');
    } finally {
      await srv.close();
    }
  });
});
