#!/usr/bin/env node
// Reload production dashboard assets on each HTTP request, without compiling Rust.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function invalidArguments() {
  console.error('Usage: node tools/dashboard-preview/server.mjs (--fixture FILE | --live http://127.0.0.1:PORT/data.json) [--port 43124]');
  process.exit(2);
}
let values;
try {
  const parsed = parseArgs({ options: { fixture: { type: 'string' }, live: { type: 'string' }, port: { type: 'string' } }, tokens: true });
  const names = parsed.tokens.map(token => token.name);
  if (new Set(names).size !== names.length) invalidArguments();
  values = parsed.values;
} catch { invalidArguments(); }
const { fixture, live } = values;
const port = Number(values.port ?? 43124);
if (Boolean(fixture) === Boolean(live) || !Number.isInteger(port) || port < 1 || port > 65535) invalidArguments();
if (live) {
  const url = new URL(live);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/data.json' || url.username || url.password) {
    throw new Error('Live data must be an explicit local Elpis dashboard /data.json URL.');
  }
}
const assets = new URL('../../codex-rs/tui/src/dashboard_assets/', import.meta.url);
const previewStartedAt = Date.now();
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
]);

createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const hosts = request.headersDistinct.host ?? [];
  if (hosts.length !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(hosts[0].toLowerCase())) {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/data.json') {
      let data;
      if (fixture) {
        data = JSON.parse(await readFile(fixture, 'utf8'));
        // Shift only fixture wall clocks, retaining elapsed offsets and all token figures.
        const originalGeneratedAt = data.state?.generated_at;
        data.heartbeat_at = Date.now();
        if (data.state) {
          data.state.generated_at = data.heartbeat_at;
          const current = data.state.activity?.current;
          if (Number.isFinite(current?.started_at) && Number.isFinite(originalGeneratedAt)) {
            current.started_at += previewStartedAt - originalGeneratedAt;
          }
        }
      } else {
        const upstream = await fetch(live, { redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (!upstream.ok) throw new Error('Local dashboard is unavailable');
        data = await upstream.json();
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      return;
    }
    const asset = routes.get(path);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    let body = await readFile(new URL(asset[0], assets), 'utf8');
    if (asset[0] === 'index.html') {
      const label = fixture ? 'Illustrative fixture · dashboard development preview' : 'Local live data · dashboard development preview';
      body = body.replace(/<body([^>]*)>/, `<body$1><p class="badge badge-warning">${label}</p>`);
    }
    response.writeHead(200, { 'Content-Type': asset[1] }).end(body);
  } catch {
    response.writeHead(503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ state: null, heartbeat_at: null }));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Dashboard preview: http://127.0.0.1:${port} (${fixture ? 'illustrative fixture' : 'local live data'})`);
  console.log(`Assets: ${fileURLToPath(assets)} — refresh after edits; no Rust rebuild.`);
});
