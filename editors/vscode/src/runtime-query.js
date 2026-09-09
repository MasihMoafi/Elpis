'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { AppServer } = require('./rpc');
const { connectAccount, refreshAccount } = require('./account-source');
function runtimeHome(options = {}) { return path.resolve(options.home || process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis')); }
async function withRuntime(root, options, query) {
  const home = runtimeHome(options);
  if (!options.transport) await fs.mkdir(home, { recursive: true });
  const rpc = new AppServer(options.executable, root, options.transport || {env:{...process.env, CODEX_HOME:home, ...options.env}});
  try {
    rpc.on('request', request => { void refreshAccount(rpc, request, options); });
    await rpc.request('initialize', {clientInfo:{name:'elpis_editor',version:require('../package.json').version},capabilities:{experimentalApi:true}}, 15000);
    rpc.send({method:'initialized'});
    await connectAccount(rpc, options);
    return await query(rpc);
  } finally { rpc.dispose(); }
}
module.exports = { withRuntime, runtimeHome };
