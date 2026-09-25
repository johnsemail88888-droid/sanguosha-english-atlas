// Exposes desktop-only info (LAN addresses of the embedded server) to the game UI.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

const isUrlList = (v) => Array.isArray(v) && v.every((u) => typeof u === 'string');

let lanUrls = [];
try {
  lanUrls = JSON.parse(decodeURIComponent(arg('sgwl-lan')) || '[]');
} catch {
  lanUrls = [];
}

contextBridge.exposeInMainWorld('sgwlDesktop', {
  isDesktop: true,
  /** LAN URLs when the window opened, best first (see getLanUrls for a fresh list) */
  lanUrls,
  /** http://<ip>:<port>/ of this machine right now, best first (Wi-Fi / Ethernet before virtual adapters) */
  getLanUrls: () => {
    try {
      const fresh = ipcRenderer.sendSync('sgwl:lan-urls');
      return isUrlList(fresh) ? fresh : lanUrls;
    } catch {
      return lanUrls;
    }
  },
  port: Number(arg('sgwl-port') || 8787),
});
