// Desktop shell for 三国杀·枪火乱世.
// Starts the embedded LAN server (static game + WebSocket relay + PeerJS signalling, see
// server/server.mjs) and opens the game from it, so the desktop app can host LAN rooms that
// friends join from their browser at http://<your-LAN-IP>:<port>/.
const { app, BrowserWindow, Menu, clipboard, dialog, session, shell } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_NAME = '三国杀·枪火乱世';
const PORTS = [8787, 8788, 8789, 18787, 0];
let server = null;
let win = null;

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(`http://${nic.address}:${port}/`);
    }
  }
  return out;
}

async function startEmbeddedServer() {
  const root = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
  const mod = await import(pathToFileURL(path.join(root, 'server', 'server.mjs')).href);
  const distDir = path.join(root, 'dist');
  let lastErr;
  for (const port of PORTS) {
    try {
      return await mod.startServer({ port, distDir, quiet: true });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function createWindow() {
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
    backgroundColor: '#140f0b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // the host keeps simulating while unfocused
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

function showLan() {
  const port = server ? server.port : 8787;
  const urls = lanUrls(port);
  const text = urls.length ? urls.join('\n') : '(未检测到局域网地址 / no LAN address found)';
  if (urls[0]) clipboard.writeText(urls[0]);
  void dialog.showMessageBox({
    type: 'info',
    title: '局域网联机 / LAN play',
    message: '同一局域网的朋友用浏览器打开以下地址即可加入（第一个地址已复制到剪贴板）：\nFriends on the same network can open:',
    detail: `${text}\n\n在游戏里选择「联机 → 服务器模式」创建房间，把房间码发给朋友。\nIn game choose Online → Server mode, create a room and share the code.`,
  });
}

app.setName(APP_NAME);
app.setAppUserModelId('com.sanguo.warlords');
Menu.setApplicationMenu(
  Menu.buildFromTemplate([
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
