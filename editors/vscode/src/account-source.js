'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
async function accountTokens(options) {
  const home = options.codexLoginHome || path.join(os.homedir(), '.codex');
  let auth;
  try { auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')); }
  catch { throw new Error('Codex login is unavailable. Sign in with Codex, then reconnect Elpis.'); }
  if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('Sign in to a ChatGPT account with Codex, then reconnect Elpis.');
  return { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id };
}
async function connectAccount(rpc, options) {
  if (options.accountSource !== 'codex' || options.env?.OPENAI_API_KEY) return;
  await rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...await accountTokens(options) });
}
async function refreshAccount(rpc, request, options) {
  if (request.method !== 'account/chatgptAuthTokens/refresh' || options.accountSource !== 'codex') return false;
  try {
    const tokens = await accountTokens(options);
    if (request.params?.previousAccountId && request.params.previousAccountId !== tokens.chatgptAccountId) throw new Error('Codex account changed. Reconnect Elpis.');
    rpc.respond(request.id, tokens);
  } catch (error) {
    rpc.send({ id: request.id, error: { code: -32000, message: error.message } });
  }
  return true;
}
module.exports = { connectAccount, refreshAccount };
