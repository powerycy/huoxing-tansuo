// Local-only capture receiver. Does not modify the game or its normal save.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.RECORD_PORT || 5190);
const mime = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glb':'model/gltf-binary','.woff2':'font/woff2'};
http.createServer((req,res)=>{
  if(req.method==='POST' && req.url==='/__recording') {
    if(req.headers.origin!==`http://127.0.0.1:${port}`){res.writeHead(403).end();return;}
    const dir=path.join(root,'output','recordings');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,`flower-event-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`);
    const out=fs.createWriteStream(file,{flags:'wx'});let size=0;
    req.on('data',b=>{size+=b.length;if(size>256*1024*1024){req.destroy();out.destroy();}});
    out.on('error',()=>res.writeHead(500).end('Capture save failed'));
    req.pipe(out);out.on('finish',()=>{console.log(file);res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({file,size}));});return;
  }
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  let rel;try{rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  const file=path.resolve(root,'.'+(rel==='/'?'/index.html':rel));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':st.size,'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);});
}).listen(port,'127.0.0.1',()=>console.log(`Recording preview: http://127.0.0.1:${port}/tools/record-flower.html`));
