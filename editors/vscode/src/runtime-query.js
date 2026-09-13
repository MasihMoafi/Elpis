'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { AppServer } = require('./rpc');
const { connectAccount, refreshAccount } = require('./account-source');
function runtimeHome(options = {}) { return path.resolve(options.home || process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis')); }
async function runtimeTransport(options = {}) {
  if (options.transport) return options.transport;
  const home = runtimeHome(options);
  await fs.mkdir(home, {recursive:true});
  const env = {...process.env, ...(process.platform==='win32'?options.env:{}), CODEX_HOME:home, ELPIS_HOME:home};
  return process.platform==='win32'?{env}:{args:['--shared'],env};
}
async function withRuntime(root, options, query) {
  const rpc = new AppServer(options.executable, root, await runtimeTransport(options));
  try {
    rpc.on('request', request => { void refreshAccount(rpc, request, options); });
    await rpc.request('initialize', {clientInfo:{name:'elpis_editor',version:require('../package.json').version},capabilities:{experimentalApi:true}}, 15000);
    rpc.send({method:'initialized'});
    await connectAccount(rpc, options);
    return await query(rpc);
  } finally { rpc.dispose(); }
}
module.exports = { withRuntime, runtimeHome, runtimeTransport };
