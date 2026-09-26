// Desktop shell for 三国杀·枪火乱世.
// Starts the embedded LAN server (static game + WebSocket relay + PeerJS signalling, see
// server/server.mjs) and opens the game from it, so the desktop app can host LAN rooms that
// friends join from their browser at http://<your-LAN-IP>:<port>/.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mirrorFile, portOrder, readJson, writeJson } = require('./state.cjs');

const APP_NAME = '三国杀·枪火乱世';
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
      additionalArguments: [`--sgwl-port=${port}`, `--sgwl-lan=${encodeURIComponent(JSON.stringify(lanUrls(port)))}`],
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win && win.show());
  win.on('closed', () => {
    win = null;
  });
  await win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);
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
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      // copy / paste (room codes, chat) — macOS routes ⌘C / ⌘V through the menu
      { role: 'editMenu', label: '编辑' },
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
}
