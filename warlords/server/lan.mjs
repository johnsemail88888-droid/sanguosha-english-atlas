// LAN address ranking for the self-host server banner and the desktop app's
// "LAN play" list (electron/main.cjs). A PC usually has several IPv4 adapters:
// the Wi-Fi / Ethernet one friends can reach, plus virtual / host-only ones
// (VirtualBox 192.168.56.1, Hyper-V / WSL vEthernet 172.x, Docker bridges,
// VPN tunnels) that nobody else can. The first address is what gets shown
// first and copied, so it must be the real one.

/** Adapter names of virtual / host-only / tunnel interfaces (pushed to the end, never dropped). */
export const VIRTUAL_ADAPTER = /VirtualBox|vboxnet|vEthernet|WSL|Hyper-V|VMware|vmnet|docker|br-|virbr|veth|utun|Loopback|ZeroTier|Tailscale/i;
/** Typical physical Wi-Fi / Ethernet adapter names (Windows, macOS, Linux; also 以太网 / 无线). */
const PHYSICAL_ADAPTER = /Wi-?Fi|WLAN|Wireless|Ethernet|以太网|无线|^en\d|^eth\d|^wl|^enp|^eno|^ens/i;

/** Rough usefulness of an IPv4 address for other players on the same network. */
function addressScore(ip) {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return -100;
  const [a, b, c] = p;
  if (a === 127) return -90; // loopback: this machine only
  if (a === 169 && b === 254) return -60; // link-local (no DHCP): nobody can reach it
  if (a === 192 && b === 168) return c === 56 ? -40 : 40; // 192.168.56.x: VirtualBox host-only default
  if (a === 10) return 30;
  if (a === 172 && b >= 16 && b <= 31) return 5; // often Docker / WSL / Hyper-V NAT
  if (a === 100 && b >= 64 && b <= 127) return -10; // carrier-grade NAT / Tailscale
  return 10; // public / other private ranges
}

/**
 * Rank IPv4 addresses, best first. Accepts plain addresses or `{ name, address }`
 * entries (the adapter name helps: Wi-Fi / Ethernet up, virtual adapters last).
 * Stable for equal scores. Duplicates are removed.
 * @param {ReadonlyArray<string | { name?: string, address: string }>} entries
 * @returns {string[]}
 */
export function rankLanAddresses(entries) {
  const seen = new Set();
  const scored = [];
  entries.forEach((e, i) => {
    const address = typeof e === 'string' ? e : e?.address;
    const name = typeof e === 'string' ? '' : e?.name ?? '';
    if (typeof address !== 'string' || seen.has(address)) return;
    seen.add(address);
    let score = addressScore(address);
    if (name && VIRTUAL_ADAPTER.test(name)) score -= 100;
    else if (name && PHYSICAL_ADAPTER.test(name)) score += 15;
    scored.push({ address, score, i });
  });
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  return scored.map((s) => s.address);
}

/**
 * Non-internal IPv4 addresses of this machine, best first.
 * @param {Record<string, Array<{ address: string, family: string | number, internal: boolean }> | undefined>} interfaces os.networkInterfaces()
 * @returns {string[]}
 */
export function lanAddressesFrom(interfaces) {
  const entries = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const ni of list ?? []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) entries.push({ name, address: ni.address });
    }
  }
  return rankLanAddresses(entries);
}

/** true for a bind address that only this machine can reach */
export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host ?? '');
}
