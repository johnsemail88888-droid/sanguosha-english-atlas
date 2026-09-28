// Desktop shell for 三国杀·枪火乱世.
// Starts the embedded LAN server (static game + WebSocket relay + PeerJS signalling, see
// server/server.mjs) and opens the game from it, so the desktop app can host LAN rooms that
// friends join from their browser at http://<your-LAN-IP>:<port>/.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mirrorFile, portOrder, readJson, writeJson } = require('./state.cjs');
const { createUpdater, feedFromAppUpdateYml } = require('./updater.cjs');

const APP_NAME = '三国杀·枪火乱世';

// Use the graphics card, always: the game is unplayable on Chromium's software
// fallback (SwiftShader), which a blocklisted driver or a laptop's power-saving GPU
// choice would otherwise give it. Must be set before the app is ready.
for (const sw of ['ignore-gpu-blocklist', 'force_high_performance_gpu', 'enable-gpu-rasterization', 'enable-zero-copy']) {
  if (app.commandLine) app.commandLine.appendSwitch(sw);
}
const ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
let server = null;
let win = null;
/** server/lan.mjs (ESM): address ranking shared with the CLI server banner */
let lan = null;

/**
 * http://<ip>:<port>/ for every non-internal IPv4 of this machine, best first
 * (Wi-Fi / Ethernet before VirtualBox / Hyper-V / WSL / Docker / VPN adapters).
 * Recomputed on every call: Wi-Fi changes, VPNs connect while the app is open.
 */
function lanUrls(port) {
  const nets = os.networkInterfaces();
  let ips;
  if (lan) ips = lan.lanAddressesFrom(nets);
  else {
    ips = [];
    for (const list of Object.values(nets)) for (const nic of list || []) if (nic.family === 'IPv4' && !nic.internal) ips.push(nic.address);
  }
  return ips.map((ip) => `http://${ip}:${port}/`);
}

/**
 * The game's origin is http://127.0.0.1:<port>/ and its localStorage (settings, keybinds…)
 * belongs to that origin: the port that worked last time is tried first, so the settings
 * stay where they are; if another port must be used, the preload restores them from the
 * mirror in userData (state.cjs, PLATFORM-7).
 */
async function startEmbeddedServer() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'server', 'server.mjs')).href);
  const distDir = path.join(ROOT, 'dist');
  const stateFile = path.join(app.getPath('userData'), 'desktop.json');
  const state = readJson(stateFile) || {};
  let lastErr;
  for (const port of portOrder(state.port)) {
    try {
      const srv = await mod.startServer({ port, distDir, quiet: true });
      if (state.port !== srv.port) {
        try {
          writeJson(stateFile, { ...state, port: srv.port });
        } catch (err) {
          console.warn('[desktop] could not remember the port', err);
        }
      }
      return srv;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** GET `url` as text through Chromium's network stack (the system proxy applies); aborted after `timeoutMs`. */
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const get = net && typeof net.fetch === 'function' ? net.fetch.bind(net) : fetch;
    const res = await get(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** The feed electron-builder wrote into resources/app-update.yml (package.json build.publish); null: the built-in one. */
function appUpdateFeed() {
  try {
    return app.isPackaged ? feedFromAppUpdateYml(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * Desktop updates (electron/updater.cjs): the setup build and the AppImage update themselves
 * (background download, installed on quit, 重启并更新 on the title screen); the portable exe and
 * the Mac app get a 下载 offer. A dev run never checks. Created on first use.
 */
let updater = null;
function getUpdater() {
  if (updater) return updater;
  updater = createUpdater({
    app,
    platform: process.platform,
    // an Intel build running under Rosetta on Apple silicon: offer the arm64 dmg
    arch: process.platform === 'darwin' && app.runningUnderARM64Translation ? 'arm64' : process.arch,
    env: process.env,
    log: console,
    fetchText,
    openExternal: (url) => shell.openExternal(url),
    loadAutoUpdater: () => require('electron-updater').autoUpdater,
    // electron-updater's own copy of builder-util-runtime: a download on its way stops when a match starts
    newCancellationToken: () => {
      const runtime = require(require.resolve('builder-util-runtime', { paths: [path.dirname(require.resolve('electron-updater'))] }));
      return new runtime.CancellationToken();
    },
    feedUrl: appUpdateFeed(),
  });
  updater.onChange((st) => {
    const wc = win && win.webContents;
    if (wc && typeof wc.send === 'function' && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) wc.send('sgwl:update-state', st);
  });
  return updater;
}

/** userData/web-storage.json: the game's localStorage keys, for whichever port the window opens on. */
let storageMirror = null;
const mirror = () => (storageMirror ??= mirrorFile(path.join(app.getPath('userData'), 'web-storage.json')));

/** The window / taskbar icon (Linux shows none without it; Windows / macOS use the packaged one). */
function windowIcon() {
  for (const p of [path.join(ROOT, 'build-res', 'icon.png'), path.join(ROOT, 'dist', 'favicon.png')]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* asar lookup failed: try the next one */
    }
  }
  return undefined;
}

/**
 * Chromium's GPU feature status is only real once the GPU process has started and
 * reported (the first 'gpu-info-update'; Chromium stores the feature status before it
 * notifies). Until then every feature reads 'disabled_software' / 'disabled_off' — on
 * macOS the window used to open before that, and the page took the Mac's Metal GPU for
 * software rendering (极速 tier + the "not using the graphics card" warning).
 */
let gpuReported = false;
const gpuWaiters = [];
app.on('gpu-info-update', () => {
  gpuReported = true;
  for (const done of gpuWaiters.splice(0)) done();
});

/** Resolves true once the GPU process has reported, false after `timeoutMs` without it (no GPU process: the status says why). */
function gpuReady(timeoutMs) {
  if (gpuReported) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    gpuWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * How Chromium runs WebGL here (app.getGPUFeatureStatus(): 'enabled…' = on the GPU;
 * 'software' / 'unavailable_software' / 'disabled…' = not) — ask after gpuReady(). The
 * page gets it (preload: sgwlDesktop.webgl) and warns when it is not hardware, like the
 * web version does for a software renderer.
 */
function webglStatus() {
  try {
    const status = app.getGPUFeatureStatus() || {};
    return String(status.webgl2 || status.webgl || '');
  } catch {
    return '';
  }
}

/** Start-up log: the GPU feature status and the GPUs, once the GPU process has reported. */
async function logGpu() {
  const reported = await gpuReady(15000);
  try {
    console.info(`[desktop] GPU feature status${reported ? '' : ' (the GPU process did not report)'}`, JSON.stringify(app.getGPUFeatureStatus() || {}));
    const info = await app.getGPUInfo('basic');
    const devices = (info && info.gpuDevice) || [];
    console.info('[desktop] GPUs', JSON.stringify(devices.map((d) => ({ vendorId: d.vendorId, deviceId: d.deviceId, active: d.active, driver: d.driverVersion }))));
  } catch (err) {
    console.warn('[desktop] GPU feature status unavailable', err);
  }
}

// renderer (preload): the WebGL feature status, answered once the GPU process has reported
// (the page blocks for at most 3 s; a GPU process that never comes up answers the status as is)
ipcMain.on('sgwl:webgl', (ev) => {
  if (gpuReported) {
    ev.returnValue = webglStatus();
    return;
  }
  void gpuReady(3000).then(() => {
    ev.returnValue = webglStatus();
  });
});

async function createWindow() {
  if (!lan) {
    try {
      lan = await import(pathToFileURL(path.join(ROOT, 'server', 'lan.mjs')).href);
    } catch (err) {
      console.warn('[desktop] LAN address ranking unavailable', err);
    }
  }
  if (!server) server = await startEmbeddedServer();
  const port = server.port;
  void logGpu();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'pointerLock' || permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  });

  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    center: true,
    show: false,
    title: APP_NAME,
    icon: windowIcon(),
    backgroundColor: '#140f0b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // the host keeps simulating while unfocused
      // the initial list; the page asks for a fresh one through sgwlDesktop.getLanUrls()
      additionalArguments: [`--sgwl-port=${port}`, `--sgwl-lan=${encodeURIComponent(JSON.stringify(lanUrls(port)))}`, `--sgwl-version=${app.getVersion()}`],
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (win) win.show();
    // the first update check ~10 s later, then every 4 h (none in a dev run, none in the CI smoke
    // test: it would ask GitHub, and offer a release to the CI build)
    if (!(Number(process.env.SGWL_DESKTOP_SMOKE) > 0)) getUpdater().start();
  });
  win.on('closed', () => {
    win = null;
  });
  // start-up trail for bug reports and the Mac CI (ELECTRON_ENABLE_LOGGING=1 prints it)
  // (logging only: never let it stop the window from loading)
  const wc = win.webContents;
  if (wc && typeof wc.on === 'function') {
    wc.on('did-finish-load', () => console.info('[desktop] page loaded', typeof wc.getURL === 'function' ? wc.getURL() : ''));
    wc.on('did-fail-load', (_e, code, desc, url) => console.warn('[desktop] page failed to load', code, desc, url));
    wc.on('render-process-gone', (_e, d) => console.error('[desktop] renderer gone', JSON.stringify(d)));
  }
  await win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);
  const smoke = Number(process.env.SGWL_DESKTOP_SMOKE);
  if (smoke > 0) setTimeout(() => void smokeReport(), smoke * 1000);
}

/**
 * CI smoke test (.github/workflows/warlords-mac.yml): SGWL_DESKTOP_SMOKE=<seconds>
 * after the page loaded, print what it shows (title screen, WebGL 2, the GPU it
 * draws with) as `[desktop] smoke ok|FAILED {…}` and quit (exit code 0 / 1).
 */
async function smokeReport() {
  let r = null;
  try {
    r = await win.webContents.executeJavaScript(`(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      let renderer = '';
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      const menu = document.querySelector('.sg-menu-btn.primary');
      const bridge = window.sgwlDesktop;
      const chip = document.querySelector('.sg-update-chip:not(.sg-hidden)');
      return { title: document.title, menu: menu ? menu.textContent : null, webgl2: !!gl, renderer, desktop: !!bridge, pageWebgl: bridge ? bridge.webgl : null, updateChip: chip ? chip.textContent : null };
    })()`);
  } catch (err) {
    r = { error: String(err) };
  }
  // the page must know WebGL runs on the GPU (else it drops to 极速 and warns) unless it really is a software renderer
  const software = /swiftshader|llvmpipe|software/i.test((r && r.renderer) || '');
  const ok = !!r && !!r.webgl2 && typeof r.menu === 'string' && /单人练习|Single Player/.test(r.menu) && (software || /^enabled/.test(r.pageWebgl || ''));
  console.info(`[desktop] smoke ${ok ? 'ok' : 'FAILED'}`, JSON.stringify({ ...r, gpu: app.getGPUFeatureStatus(), update: updater ? updater.state() : null }));
  app.exit(ok ? 0 : 1);
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showLan() {
  const port = server ? server.port : 8787;
  const urls = lanUrls(port);
  const text = urls.length ? urls.join('\n') : '(未检测到局域网地址 / no LAN address found)';
  if (urls[0]) clipboard.writeText(urls[0]);
  void dialog.showMessageBox({
    type: 'info',
    title: '局域网联机 / LAN play',
    message: urls[0]
      ? `同一局域网的朋友用浏览器打开以下地址即可加入（第一个地址已复制到剪贴板）：\nFriends on the same network can open (the first one is copied):\n\n${urls[0]}`
      : '未检测到局域网地址，请检查网络连接。\nNo LAN address found — check your network connection.',
    detail: `${text}\n\n在游戏里选择「联机 → 服务器模式」创建房间，把房间码发给朋友。\nIn game choose Online → Server mode, create a room and share the code.`,
  });
}

// renderer (preload): a fresh, ranked LAN address list on demand
ipcMain.on('sgwl:lan-urls', (ev) => {
  ev.returnValue = lanUrls(server ? server.port : 8787);
});

// renderer (preload): the mirrored localStorage keys (PLATFORM-7, see state.cjs)
ipcMain.on('sgwl:storage-load', (ev) => {
  try {
    ev.returnValue = mirror().load();
  } catch (err) {
    console.warn('[desktop] reading the settings mirror failed', err);
    ev.returnValue = null;
  }
});
ipcMain.on('sgwl:storage-save', (ev, items) => {
  try {
    ev.returnValue = mirror().save(items, server ? `http://127.0.0.1:${server.port}` : '');
  } catch (err) {
    console.warn('[desktop] writing the settings mirror failed', err);
    ev.returnValue = 0;
  }
});

// renderer (preload: sgwlDesktop.update): the update state now, the 下载 / 重启并更新 / 检查更新 actions,
// and whether a match is on (checks, downloads and restarts wait for its end)
ipcMain.on('sgwl:update-get', (ev) => {
  ev.returnValue = getUpdater().state();
});
ipcMain.on('sgwl:update-do', (_ev, action, which) => {
  const u = getUpdater();
  if (action === 'restart') u.restart();
  else if (action === 'download') u.download(which === 'setup' ? 'setup' : undefined);
  else if (action === 'check') void u.check();
});
ipcMain.on('sgwl:update-playing', (_ev, on) => getUpdater().setPlaying(!!on));

// one instance: a second launch (double-clicked again) focuses the running window
// instead of starting a second server on the next port
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());

  app.setName(APP_NAME);
  app.setAppUserModelId('com.sanguo.warlords');
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: '游戏',
        submenu: [
          { label: '局域网联机地址…', click: showLan },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
          // No Ctrl shortcuts here: Ctrl is the dodge key, and a menu accelerator fires
          // even when the page handles the key — dodge + R (reload the gun) must not
          // reload the app, dodge + Q (skill) must not quit it.
          { label: '重新载入', accelerator: 'F5', click: (_item, w) => w?.webContents.reload() },
          { label: '开发者工具', accelerator: 'F12', click: (_item, w) => w?.webContents.toggleDevTools() },
          { type: 'separator' },
          isMac ? { role: 'quit', label: '退出' } : { label: '退出', click: () => app.quit() },
        ],
      },
      // copy / paste (room codes, chat): macOS routes ⌘C / ⌘V through the menu;
      // Windows / Linux edit text natively, and Ctrl+Z / X / C / V are dodge + squad orders
      ...(isMac ? [{ role: 'editMenu', label: '编辑' }] : []),
      {
        label: '帮助',
        submenu: [
          {
            label: '项目主页',
            click: () => void shell.openExternal('https://github.com/johnsemail88888-droid/sanguosha-english-atlas/tree/main/warlords'),
          },
        ],
      },
    ]),
  );

  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox(APP_NAME, `启动失败 / failed to start:\n${err && err.stack ? err.stack : err}`);
    app.quit();
  });
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) void createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    if (server) void server.close();
  });
  // the GPU process crashing is how a bad driver shows up (Chromium then falls back to software)
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') console.info('[desktop] child process exited', d.type);
    else console.error('[desktop] child process gone', JSON.stringify(d));
  });
}
