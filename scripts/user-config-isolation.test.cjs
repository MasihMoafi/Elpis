'use strict';
// Exercise the installed engine's config loader with distinct Codex and Elpis homes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'provide the engine binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-config-isolation-'));
const home = path.join(root, 'home');
const elpisHome = path.join(home, '.elpis-next');
const codexHome = path.join(home, '.codex');
const project = path.join(home, 'project');
for (const directory of [elpisHome, codexHome, path.join(project, '.codex')]) {
  fs.mkdirSync(directory, { recursive: true });
}
const foreignConfig = 'model="codex-user-sentinel"\n[otel]\nexporter="none"\n';
fs.writeFileSync(path.join(codexHome, 'config.toml'), foreignConfig);
fs.writeFileSync(path.join(elpisHome, 'config.toml'), `model="gpt-5.5"\n[projects.${JSON.stringify(home)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
fs.writeFileSync(path.join(project, '.codex/config.toml'), 'model="gpt-6.1-sol"\n[otel]\nexporter="none"\n');

let nextProbe = 0;
async function probe(cwd) {
  const probeId = ++nextProbe;
  const child = spawn(binary, ['app-server'], {
    cwd,
    env: { ...process.env, HOME: home, ELPIS_HOME: elpisHome, CODEX_HOME: codexHome, CODEX_AUTH_HOME: elpisHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [], pending = new Map();
  let nextId = 0, stderr = '';
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { for (const { reject } of pending.values()) reject(error); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  function request(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timeout: ${method}; ${stderr}`)), 10000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    await request('initialize', { clientInfo: { name: 'elpis_config_isolation_test', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const config = await request('config/read', { cwd, includeLayers: true });
    return { config, messages };
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
    lines.close();
    fs.writeFileSync(path.join(root, `probe-${probeId}-${path.basename(cwd)}.json`), JSON.stringify({ messages, stderr }, null, 2));
  }
}

(async () => {
  const atHome = await probe(home);
  assert.equal(atHome.config.config.model, 'gpt-5.5', 'Codex user settings must not override Elpis');
  assert(!JSON.stringify(atHome.config.layers).includes(codexHome), 'Codex user home must not become a project layer');
  assert(!atHome.messages.some(m => m.method === 'configWarning' && JSON.stringify(m).includes(codexHome)), 'no project warning for Codex user config');
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), foreignConfig, 'Codex settings must remain untouched');
  console.log('PASS separate Codex user settings do not load or warn in Elpis');
  const inProject = await probe(project);
  assert.equal(inProject.config.config.model, 'gpt-6.1-sol', 'real project settings still apply');
  assert(JSON.stringify(inProject.config.layers).includes(path.join(project, '.codex')), 'real project layer must remain');
  assert(inProject.messages.some(m => m.method === 'configWarning' && JSON.stringify(m).includes('otel')), 'unsafe project keys must still warn');
  console.log('PASS real project config applies and project restrictions still warn');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'broken = [');
  const malformed = await probe(home);
  assert.equal(malformed.config.config.model, 'gpt-5.5', 'unrelated malformed Codex config must not break Elpis');
  console.log('PASS malformed Codex config cannot block Elpis startup');
  const activeConfig = path.join(elpisHome, 'config.toml');
  fs.writeFileSync(activeConfig, fs.readFileSync(activeConfig, 'utf8').replace(
    `[projects.${JSON.stringify(home)}]\ntrust_level="trusted"`,
    `[projects.${JSON.stringify(home)}]\ntrust_level="untrusted"`));
  const untrusted = await probe(home);
  assert.equal(untrusted.config.config.model, 'gpt-5.5');
  assert(!JSON.stringify(untrusted.config.layers).includes(codexHome));
  console.log('PASS user-home isolation also holds before directory trust');
  fs.renameSync(path.join(project, '.codex'), path.join(project, 'saved-project-config'));
  fs.symlinkSync(codexHome, path.join(project, '.codex'), 'dir');
  const linked = await probe(project);
  assert.equal(linked.config.config.model, 'gpt-5.5');
  assert(!JSON.stringify(linked.config.layers).includes(path.join(project, '.codex')));
  console.log('PASS a project symlink cannot reclassify Codex user config');
  console.log(`Evidence: ${root}`);
})().catch(error => { console.error(error); console.error(`Evidence: ${root}`); process.exitCode = 1; });
