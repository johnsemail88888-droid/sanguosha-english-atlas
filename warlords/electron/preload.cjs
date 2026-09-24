// Exposes desktop-only info (LAN addresses of the embedded server) to the game UI.
const { contextBridge } = require('electron');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

let lanUrls = [];
try {
  lanUrls = JSON.parse(decodeURIComponent(arg('sgwl-lan')) || '[]');
} catch {
  lanUrls = [];
}

contextBridge.exposeInMainWorld('sgwlDesktop', {
  isDesktop: true,
  lanUrls,
  port: Number(arg('sgwl-port') || 8787),
});
