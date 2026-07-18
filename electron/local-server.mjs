import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'}
export async function startLocalServer(root){
  const dist=resolve(root,'dist')
  const server=createServer(async(req,res)=>{try{const url=new URL(req.url||'/','http://127.0.0.1');let rel=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';let file=resolve(dist,rel);if(file!==dist&&!file.startsWith(`${dist}${sep}`)){res.writeHead(403);res.end();return}try{if(!(await stat(file)).isFile())throw 0}catch{if(!extname(rel))file=resolve(dist,'index.html');else{res.writeHead(404);res.end('Not found');return}}const body=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(body)}catch(e){res.writeHead(500);res.end(String(e))}})
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)})
  const address=server.address();if(!address||typeof address==='string')throw new Error('无法启动本地服务')
  return {server,origin:`http://127.0.0.1:${address.port}`}
}
