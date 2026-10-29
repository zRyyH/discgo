// Phase 1 spike harness (PLAN 10, fase 1). Dependency-free Node 24 server that:
//  - serves viewer.html and livekit-client from desktop/node_modules
//  - mints LiveKit dev tokens (devkey/secret) at /token
//  - collects viewer reports at POST /report and prints them as JSON lines
//  - optionally spawns the engine (--engine <exe>) and bridges its P2P
//    signalling to the viewer: engine stdout -> SSE /p2p/events, POST /p2p/send -> stdin
//
// Usage: node engine/spike/serve.mjs [--port 8090] [--engine target/release/discgo-engine.exe --start '<json>']
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const port = Number(args.port ?? 8090);
const LK_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret-0123456789abcdef0123456789';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function livekitToken(identity, room, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: LK_KEY,
      sub: identity,
      name: identity,
      nbf: now - 10,
      exp: now + 6 * 3600,
      video: { room, roomJoin: true, canPublish: opts.publish ?? true, canSubscribe: opts.subscribe ?? true },
    }),
  );
  const sig = b64url(crypto.createHmac('sha256', LK_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// --- engine bridge (P2P) ---
const sseClients = new Set();
let engine = null;
const pendingToViewer = [];

function toViewer(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  if (sseClients.size === 0) pendingToViewer.push(line);
  for (const res of sseClients) res.write(line);
}

function startEngine() {
  engine = spawn(path.resolve(root, args.engine), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  readline.createInterface({ input: engine.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.event === 'stats') console.log(JSON.stringify({ source: 'engine', ...ev }));
    else console.log(JSON.stringify({ source: 'engine', ...ev }).slice(0, 2000));
    if (ev.event === 'sdp' || ev.event === 'ice') toViewer(ev);
  });
  readline.createInterface({ input: engine.stderr }).on('line', (l) => process.stderr.write(`[engine] ${l}\n`));
  engine.on('exit', (code) => console.log(JSON.stringify({ source: 'engine', event: 'exit', code })));
  engine.stdin.write(JSON.stringify({ cmd: 'probe' }) + '\n');
}

function toEngine(msg) {
  engine?.stdin.write(JSON.stringify(msg) + '\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/viewer.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(here, 'viewer.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/lk.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return fs
      .createReadStream(path.join(root, 'desktop/node_modules/livekit-client/dist/livekit-client.esm.mjs'))
      .pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/token') {
    const identity = url.searchParams.get('identity') ?? 'viewer';
    const room = url.searchParams.get('room') ?? 'spike';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ url: 'ws://127.0.0.1:17880', token: livekitToken(identity, room) }));
  }
  if (req.method === 'GET' && url.pathname === '/p2p/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    sseClients.add(res);
    while (pendingToViewer.length) res.write(pendingToViewer.shift());
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = body ? JSON.parse(body) : {};
    if (url.pathname === '/report') {
      console.log(JSON.stringify({ source: 'viewer', ...msg }));
    } else if (url.pathname === '/p2p/send') {
      toEngine(msg);
    } else if (url.pathname === '/engine') {
      toEngine(msg); // arbitrary engine command (start/stop/update) from the harness
    }
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ source: 'harness', listening: `http://127.0.0.1:${port}` }));
  if (args.engine) startEngine();
});
