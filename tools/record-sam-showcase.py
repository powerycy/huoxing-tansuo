# Local-only receiver for sam-showcase.html recordings.
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
out=Path(__file__).resolve().parents[2] / 'output' / 'sam-showcase'
out.mkdir(parents=True, exist_ok=True)
class Handler(BaseHTTPRequestHandler):
 def do_OPTIONS(self):
  self.send_response(204); self.send_header('Access-Control-Allow-Origin','http://127.0.0.1:5176'); self.send_header('Access-Control-Allow-Methods','POST, OPTIONS'); self.send_header('Access-Control-Allow-Headers','content-type'); self.end_headers()
 def do_POST(self):
  n=int(self.headers.get('Content-Length','0'))
  if self.path!='/recording' or n>250_000_000: self.send_error(400); return
  p=out/'sam-porter-v3-showcase.webm'
  with p.open('wb') as f:
   remaining=n
   while remaining:
    chunk=self.rfile.read(min(1048576,remaining))
    if not chunk: break
    f.write(chunk); remaining-=len(chunk)
  self.send_response(200); self.send_header('Access-Control-Allow-Origin','http://127.0.0.1:5176'); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'saved':str(p),'bytes':n}).encode())
HTTPServer(('127.0.0.1',5188),Handler).serve_forever()
