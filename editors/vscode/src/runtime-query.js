'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { AppServer } = require('./rpc');
const { connectAccount, refreshAccount } = require('./account-source');
const expandHome = value => value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
// A bare name is found on PATH, then in ~/.local/bin, where the Elpis installer puts `elpis`.
// A name that is not found stays unchanged, so the launch reports the missing binary.
function resolveExecutable(value = 'elpis') {
  const name = expandHome(value || 'elpis');
  if (name.includes('/')) return path.resolve(name);
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')]) {
    const file = dir && path.join(dir, name);
    try { if (file && fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  }
  return name;
}
// The executable and home that a VS Code `elpis` configuration selects.
function configuredRuntime(config) {
  return { executable: resolveExecutable(config.get('executable', 'elpis')), home: config.get('home', '') };
}
// An empty home lets the elpis binary choose its own home (ELPIS_HOME, else its default).
function runtimeEnv(options = {}) {
  return { ...process.env, ...options.env, ...(options.home ? { ELPIS_HOME: path.resolve(expandHome(options.home)) } : {}) };
}
function runtimeTransport(options = {}) {
  return options.transport || { args: ['app-server'], env: runtimeEnv(options) };
}
async function withRuntime(root, options, query) {
  const rpc = new AppServer(options.executable, root, runtimeTransport(options));
  try {
    rpc.on('request', request => { void refreshAccount(rpc, request, options); });
    await rpc.request('initialize', {clientInfo:{name:'elpis_editor',version:require('../package.json').version},capabilities:{experimentalApi:true}}, 15000);
    rpc.send({method:'initialized'});
    await connectAccount(rpc, options);
    return await query(rpc);
  } finally { rpc.dispose(); }
}
const homes = new Map();
// The binary reports the home it uses, so the extension never keeps a second copy of its default.
function resolveHome(options = {}) {
  if (options.home) return Promise.resolve(path.resolve(expandHome(options.home)));
  if (!homes.has(options.executable)) {
    const rpc = new AppServer(options.executable, os.homedir(), runtimeTransport(options));
    const home = rpc.request('initialize', {clientInfo:{name:'elpis_editor',version:require('../package.json').version},capabilities:{experimentalApi:true}}, 15000)
      .then(result => result.codexHome)
      .finally(() => rpc.dispose());
    home.catch(() => homes.delete(options.executable));
    homes.set(options.executable, home);
  }
  return homes.get(options.executable);
}
module.exports = { withRuntime, resolveHome, resolveExecutable, configuredRuntime, runtimeEnv, runtimeTransport };
