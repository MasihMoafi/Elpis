import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createDevServers } from './dev-servers.mjs';
import { EventEmitter } from 'node:events';
import { startDesktopServer } from './server.mjs';

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function project(t, scripts = { dev: 'node server.cjs' }) {
  const root = await fs.mkdtemp('/tmp/elpis-dev-server-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  await fs.writeFile(path.join(root, 'server.cjs'), `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log('child='+child.pid);require('node:http').createServer((q,s)=>s.end('server proof')).listen(process.env.PORT,'127.0.0.1',()=>console.log('server ready'));`);
  const manager = createDevServers(); t.after(() => manager.close());
  return { root, manager };
}
const gone = async pid => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return !stat || stat.split(' ')[2] === 'Z';
};

test('package detection is read-only; launch configurations are preferred and preserve argv', async t => {
  const { root, manager } = await project(t);
  assert.deepEqual((await manager.detect(root)).candidates.map(c => c.command), ['npm run dev']);
  await assert.rejects(fs.stat(path.join(root, '.elpis/launch.json')));
  await fs.mkdir(path.join(root, '.elpis'));
  await fs.writeFile(path.join(root, '.elpis/launch.json'), JSON.stringify({ version: '0.0.1', configurations: [{ name: 'site', runtimeExecutable: 'node', runtimeArgs: ['server.cjs', 'argument with spaces'], port: 43197 }] }));
  const { candidates } = await manager.detect(root);
  assert.equal(candidates[0].name, 'site'); assert.match(candidates[0].command, /'argument with spaces'/);
});

test('start runs a real server; logs and status survive; stop kills its descendants only', async t => {
  const { root, manager } = await project(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  const [first, duplicate] = await Promise.all([manager.start(root, 'dev'), manager.start(root, 'dev')]);
  const [server] = first.servers; assert.equal(duplicate.servers[0].pid, server.pid, 'concurrent starts share one process');
  assert.equal(server.status, 'running'); assert.equal(await (await fetch(server.url)).text(), 'server proof');
  assert.match(server.logs, /server ready/);
  const child = Number(server.logs.match(/child=(\d+)/)[1]);
  assert.equal((await manager.start(root, 'dev')).servers[0].pid, server.pid, 'duplicate starts reuse the owned process');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.elpis/launch.json'), 'utf8')).configurations[0].name, 'dev');
  const stopped = await manager.stop(root, 'dev');
  assert.equal(stopped.servers[0].status, 'stopped');
  await assert.rejects(fetch(server.url));
  assert.ok(await gone(child), 'server descendant exited'); assert.equal(await gone(unrelated.pid), false);
  await manager.stop(root, 'dev'); assert.equal(await gone(unrelated.pid), false, 'repeated stop does not reuse a retired process group');
  const restarted = (await manager.start(root, 'dev')).servers[0]; assert.equal(restarted.status, 'running'); assert.notEqual(restarted.pid, server.pid);
  await manager.stop(root, 'dev');
  await assert.rejects(manager.stop(root, 'someone-else'), /not started/i);
});

test('a framework may print its own loopback URL; logs are bounded and launch arguments stay literal', async t => {
  const { root, manager } = await project(t, {});
  await fs.writeFile(path.join(root, 'server.cjs'), `console.log('x'.repeat(80000));const s=require('node:http').createServer((q,r)=>r.end(process.argv[2]));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port+'/'));`);
  await fs.mkdir(path.join(root, '.elpis'));
  const literal = "spaces ' quotes $(touch SHOULD_NOT_EXIST)";
  await fs.writeFile(path.join(root, '.elpis/launch.json'), JSON.stringify({ configurations: [{ name: 'site', runtimeExecutable: 'node', runtimeArgs: ['server.cjs', literal], port: await availablePort() }] }));
  const { servers: [server] } = await manager.start(root, 'site');
  assert.equal(await (await fetch(server.url)).text(), literal);
  assert.ok(server.logs.length <= 65536); assert.match(server.logs, /http:\/\/127\.0\.0\.1:/);
  await assert.rejects(fs.stat(path.join(root, 'SHOULD_NOT_EXIST')));
});

test('two different starts preserve both launch configurations and stop independently', async t => {
  const { root, manager } = await project(t, { dev: 'node server.cjs', serve: 'node server.cjs' });
  await Promise.all([manager.start(root, 'dev'), manager.start(root, 'serve')]);
  const launch = JSON.parse(await fs.readFile(path.join(root, '.elpis/launch.json'), 'utf8'));
  assert.deepEqual(launch.configurations.map(c => c.name).sort(), ['dev', 'serve']);
  const { servers } = await manager.stop(root, 'dev');
  const other = servers.find(s => s.name === 'serve');
  assert.equal(other.status, 'running'); assert.equal(await (await fetch(other.url)).text(), 'server proof');
});

test('invalid launch files, unknown names, absent scripts and failed commands never report running', async t => {
  const { root, manager } = await project(t, {});
  assert.deepEqual((await manager.detect(root)).candidates, []);
  await assert.rejects(manager.start(root, 'untrusted command'), /not found/i);
  await fs.mkdir(path.join(root, '.elpis'));
  await fs.writeFile(path.join(root, '.elpis/launch.json'), '{bad');
  await assert.rejects(manager.detect(root), /launch.json/i);
  await fs.writeFile(path.join(root, '.elpis/launch.json'), JSON.stringify({ configurations: [{ name: 'broken', runtimeExecutable: 'elpis-no-such-executable-123', runtimeArgs: [], port: await availablePort() }] }));
  await assert.rejects(manager.start(root, 'broken'), /failed|exited/i);
  assert.equal((await manager.status(root)).servers[0].status, 'failed');
});

test('an occupied configured port is refused; closing the manager kills servers', async t => {
  const { root, manager } = await project(t);
  const http = await import('node:http'); const other = http.createServer((q,s) => s.end('other'));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve)); t.after(() => other.close());
  await fs.mkdir(path.join(root, '.elpis'));
  await fs.writeFile(path.join(root, '.elpis/launch.json'), JSON.stringify({ configurations: [{ name: 'busy', runtimeExecutable: 'node', runtimeArgs: ['server.cjs'], port: other.address().port }] }));
  await assert.rejects(manager.start(root, 'busy'), /already in use/i);
  assert.equal(await (await fetch(`http://127.0.0.1:${other.address().port}`)).text(), 'other');
  const { servers } = await manager.start(root, 'dev'); await manager.close();
  await assert.rejects(fetch(servers.find(s => s.name === 'dev').url));
});

test('HTTP preview routes require the private session, validate input and close owned servers', async t => {
  const { root } = await project(t);
  const client = Object.assign(new EventEmitter(), { connected: true, pendingApprovals: [], close() {} });
  const app = await startDesktopServer({ client, staticDir: root, trashFile: path.join(root, 'trash.json') }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin;
  assert.equal((await fetch(`${origin}/api/dev-servers?cwd=${encodeURIComponent(root)}`)).status, 401);
  const auth = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
  const headers = { Cookie: auth.headers.get('set-cookie').split(';')[0], Origin: origin, 'Content-Type': 'application/json' };
  const post = (action, body) => fetch(`${origin}/api/dev-servers/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('start', { cwd: root, name: 'dev', command: 'echo untrusted' })).status, 400);
  assert.equal((await fetch(`${origin}/api/dev-servers?cwd=${encodeURIComponent(root)}&cwd=other`, { headers })).status, 400);
  const cross = await fetch(`${origin}/api/dev-servers/start`, { method: 'POST', headers: { ...headers, Origin: 'http://other.invalid' }, body: JSON.stringify({ cwd: root, name: 'dev' }) });
  assert.equal(cross.status, 403);
  assert.equal((await post('detect', { cwd: root })).status, 200);
  const started = await post('start', { cwd: root, name: 'dev' }); assert.equal(started.status, 200);
  const { servers: [server] } = await started.json();
  assert.equal(await (await fetch(server.url)).text(), 'server proof');
  await app.close(); await assert.rejects(fetch(server.url));
});

test('an HTML file opens over a private local address that serves only its folder, with its CSS and images', async t => {
  const root = await fs.mkdtemp('/tmp/elpis-html-preview-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'report/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'report/index.html'), '<link rel="stylesheet" href="assets/site.css"><h1>Report</h1>');
  await fs.writeFile(path.join(root, 'report/assets/site.css'), 'h1{color:red}');
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
  const manager = createDevServers(); t.after(() => manager.close());
  const { url } = await manager.page(root, 'report/index.html');
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/index\.html$/);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /Report/);
  const css = await fetch(new URL('assets/site.css', url)); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal((await fetch(new URL('../secret.txt', url))).status, 404, 'nothing above the page folder');
  assert.equal((await fetch(new URL(url).origin + '/index.html')).status, 404, 'nothing without the private prefix');
  assert.equal((await fetch(url.replace(/\/[0-9a-f]{32}\//, '/' + '0'.repeat(32) + '/'))).status, 404, 'a guessed prefix finds nothing');
  await assert.rejects(manager.page(root, '../etc/passwd'), /project/i);
  await assert.rejects(manager.page(root, 'secret.txt'), /HTML/);
  await manager.close(); await assert.rejects(fetch(url));
});
