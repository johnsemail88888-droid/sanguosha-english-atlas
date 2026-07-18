import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalServer } from './local-server.mjs'
const current=dirname(fileURLToPath(import.meta.url));const root=app.isPackaged?app.getAppPath():dirname(current)
const external=new Set(['www.sanguosha.cn','sanguosha.cn','github.com']);let local;let win
function allowed(raw){try{const u=new URL(raw);return u.protocol==='https:'&&external.has(u.hostname)}catch{return false}}
async function create(){if(!local)local=await startLocalServer(root);session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));session.defaultSession.setPermissionCheckHandler(()=>false)
  win=new BrowserWindow({width:1440,height:920,minWidth:880,minHeight:640,center:true,show:false,title:'三国杀英文图鉴',titleBarStyle:'hiddenInset',backgroundColor:'#0d1114',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}})
  win.webContents.setWindowOpenHandler(({url})=>{if(allowed(url))void shell.openExternal(url);return{action:'deny'}})
  win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin===local.origin)return;e.preventDefault();if(allowed(url))void shell.openExternal(url)})
  win.once('ready-to-show',()=>win?.show());win.on('closed',()=>{win=undefined});await win.loadURL(local.origin)
}
app.setName('三国杀英文图鉴');app.setAppUserModelId('com.johnjiang.sanguoshaenglishatlas')
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'三国杀英文图鉴',submenu:[{role:'about',label:'关于三国杀英文图鉴'},{type:'separator'},{role:'quit',label:'退出'}]},{label:'编辑',submenu:[{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},{label:'显示',submenu:[{role:'reload',label:'重新载入'},{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'},{role:'togglefullscreen',label:'全屏'}]},{label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'缩放'}]}]))
app.whenReady().then(create);app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)void create()});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});app.on('before-quit',()=>local?.server.close())
