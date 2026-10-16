import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';

// Elpis's own Anthropic sign-out. The switch lives in the Elpis bridge (claudeSubscription/read and /write); the app
// only asks it. Claude Code's login and the ChatGPT account are never involved.
function fixture({ oldBridge = false, signedOut = false } = {}) {
  const state = { signedOut };
  const codex = { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 }, secondary: null };
  const claude = { limitId: 'claude', limitName: 'Claude', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 3 } };
  const socket = new EventEmitter(); socket.sent = [];
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result = {}, error;
    switch (request.method) {
      case 'config/read': result = { config: { model: 'test-model', model_providers: {} }, layers: [] }; break;
      case 'account/read': result = { account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: true }; break;
      case 'account/rateLimits/read': result = { rateLimits: codex, rateLimitsByLimitId: { codex, ...(state.signedOut ? {} : { claude }) } }; break;
      case 'model/list': result = { data: [{ id: 'test-model', model: 'test-model', displayName: 'Test model' }, ...(state.signedOut ? [] : [{ id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)' }])], nextCursor: null }; break;
      case 'claudeSubscription/read':
      case 'claudeSubscription/write':
        if (oldBridge) { error = { code: -32600, message: 'Invalid request: unknown variant `claudeSubscription/read`' }; break; }
        if (request.method.endsWith('write')) state.signedOut = request.params.signedOut;
        result = { signedOut: state.signedOut }; break;
      default: break;
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })));
  };
  socket.close = () => socket.emit('close');
  return { client: new DesktopClient(socket), socket, state };
}
const methods = socket => socket.sent.map(row => row.method).filter(Boolean);

test('providers report whether Elpis is signed out of the Claude subscription, and hide its models and usage then', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    const connected = await f.client.providers();
    assert.equal(connected.claude.state, 'connected'); assert.equal(connected.claude.signedOut, false);
    assert.deepEqual(connected.claude.models, ['Opus (Claude subscription)']);
    f.state.signedOut = true;
    const out = await f.client.providers();
    assert.deepEqual(out.claude, { state: 'notConnected', models: [], usage: [], signedOut: true });
    assert.equal(out.openai.auth.state, 'signedIn', 'the ChatGPT account is unaffected');
    assert.deepEqual(out.openai.usage.map(limit => limit.limitId), ['codex']);
  } finally { f.client.close(); }
});

test('Sign out and Sign in for Anthropic go through the Elpis switch, tell every window, and never touch ChatGPT or Claude Code', async () => {
  const f = fixture(); await f.client.initialize();
  const events = []; f.client.on('event', event => events.push(event));
  try {
    assert.deepEqual(await f.client.signIn({ action: 'anthropicSignOut' }), { anthropicSignedOut: true });
    assert.deepEqual(f.socket.sent.findLast(row => row.method === 'claudeSubscription/write').params, { signedOut: true });
    assert.equal(f.state.signedOut, true);
    assert.deepEqual(events.filter(event => event.type === 'account').length, 1, 'the usage store and model picker are told to reload');
    assert.equal((await f.client.providers()).claude.signedOut, true);

    assert.deepEqual(await f.client.signIn({ action: 'anthropicSignIn' }), { anthropicSignedOut: false });
    assert.deepEqual(f.socket.sent.findLast(row => row.method === 'claudeSubscription/write').params, { signedOut: false });
    assert.equal(events.filter(event => event.type === 'account').length, 2);
    const back = await f.client.providers();
    assert.equal(back.claude.signedOut, false); assert.equal(back.claude.state, 'connected');

    const used = methods(f.socket);
    assert.equal(used.includes('account/logout'), false, 'the ChatGPT sign-out is not called');
    assert.equal(used.includes('account/login/start'), false);
    assert.equal(JSON.stringify(f.socket.sent).includes('.claude'), false, 'nothing refers to Claude Code files');
  } finally { f.client.close(); }
});

test('the ChatGPT sign-in and sign-out actions are unchanged, and an unknown action is refused', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    assert.deepEqual(await f.client.signIn({ action: 'signOut' }), { signedOut: true });
    assert.ok(methods(f.socket).includes('account/logout'));
    assert.equal(methods(f.socket).includes('claudeSubscription/write'), false);
    await assert.rejects(f.client.signIn({ action: 'anthropicLogout' }), /Choose/);
    await assert.rejects(f.client.signIn({ action: 'anthropicSignOut', extra: true }), /Unsupported request fields/);
  } finally { f.client.close(); }
});

test('a bridge without the switch cannot sign out, says so, and the providers still load', async () => {
  const f = fixture({ oldBridge: true }); await f.client.initialize();
  const events = []; f.client.on('event', event => events.push(event));
  try {
    await assert.rejects(f.client.signIn({ action: 'anthropicSignOut' }), error => error.status === 503 && /restart Elpis/i.test(error.message));
    assert.equal(events.some(event => event.type === 'account'), false, 'nothing changed, so nothing reloads');
    const providers = await f.client.providers();
    assert.equal(providers.claude.signedOut, false);
    assert.equal(providers.claude.state, 'connected');
  } finally { f.client.close(); }
});
