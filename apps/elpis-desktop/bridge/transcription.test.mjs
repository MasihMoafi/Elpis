import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import http from 'node:http';
import { transcriptionStatus, createTranscription, normalizeAudio, transcribeMcp, transcribeGemini } from './transcription.mjs';

const server = env => ({ command: 'private-command', env: { SECRET_KEY: 'private-key', ...env } });
const MODEL = 'openai/gpt-4o-mini-transcribe';

test('the chat provider picks the transcriber: ChatGPT sign-in for ChatGPT, the Voice model for OpenRouter', () => {
  const config = server({ WHISPERTYPE_BACKEND: 'local', WHISPERTYPE_CLOUD_MODEL: MODEL });
  assert.deepEqual(transcriptionStatus(config, 'openai'), { available: true, backend: 'codex', label: 'ChatGPT sign-in (cloud)', source: 'provider' });
  assert.deepEqual(transcriptionStatus(config, 'openrouter'), { available: true, backend: 'openrouter', label: `OpenRouter (cloud) · ${MODEL}`, source: 'provider' });
  assert.equal(JSON.stringify(transcriptionStatus(config, 'openai')).includes('private'), false);
});

// Masih (18 Oct): voice "should use whisper medium just like my local setup does", in every chat.
test('WHISPERTYPE_EVERY_CHAT makes the Settings → Voice engine stand for every chat, ChatGPT and OpenRouter ones included', () => {
  for (const provider of ['openai', 'openrouter', 'anthropic'])
    assert.deepEqual(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local', WHISPERTYPE_EVERY_CHAT: '1', WHISPERTYPE_CLOUD_MODEL: MODEL }), provider), { available: true, backend: 'local', label: 'Local WhisperType', source: 'fallback' }, provider);
});

test('providers without a transcription Elpis can reach use the Settings fallback', () => {
  for (const provider of ['anthropic', 'anthropic-credits', 'claude', 'gemini', 'google-gemini', 'lmstudio', 'custom-gateway', undefined, '']) {
    assert.deepEqual(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local' }), provider), { available: true, backend: 'local', label: 'Local WhisperType', source: 'fallback' }, String(provider));
    assert.deepEqual(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'codex' }), provider), { available: true, backend: 'codex', label: 'ChatGPT sign-in (cloud)', source: 'fallback' }, String(provider));
  }
});

test('OpenRouter needs its model from Settings → Voice, whether the chat or the fallback asks for it', () => {
  const reason = /Settings → Voice/;
  const bare = server({ WHISPERTYPE_BACKEND: 'local' });
  assert.match(transcriptionStatus(bare, 'openrouter').reason, reason);
  assert.equal(transcriptionStatus(bare, 'openrouter').available, false);
  assert.match(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'openrouter' }), 'anthropic').reason, reason);
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'openrouter', WHISPERTYPE_CLOUD_MODEL: MODEL }), 'anthropic').available, true);
  assert.equal(transcriptionStatus(bare, 'openai').available, true);
});

test('the fallback is never paid by default: ChatGPT sign-in while Elpis is signed in to ChatGPT, otherwise Local', () => {
  const unset = server({});
  assert.deepEqual(transcriptionStatus(unset, 'anthropic', { chatgpt: true }), { available: true, backend: 'codex', label: 'ChatGPT sign-in (cloud)', source: 'fallback' });
  assert.deepEqual(transcriptionStatus(unset, 'claude', { chatgpt: false }), { available: true, backend: 'local', label: 'Local WhisperType', source: 'fallback' });
  assert.equal(transcriptionStatus(unset, undefined).backend, 'local', 'nothing known about the account');
  // An explicit choice always stands, OpenRouter included.
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local' }), 'anthropic', { chatgpt: true }).backend, 'local');
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'openrouter', WHISPERTYPE_CLOUD_MODEL: MODEL }), 'anthropic', { chatgpt: true }).backend, 'openrouter');
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'codex' }), 'anthropic', { chatgpt: false }).backend, 'codex');
});

test('Google Gemini chats use the Gemini API with the key Elpis holds, even without WhisperType', () => {
  const key = 'AIza-private-key';
  const status = transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local' }), 'google-gemini', { geminiKey: key });
  assert.deepEqual(status, { available: true, backend: 'gemini', label: 'Gemini API (cloud) · gemini-flash-latest', source: 'provider' });
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal(transcriptionStatus(null, 'google-gemini', { geminiKey: key }).backend, 'gemini');
  assert.equal(transcriptionStatus({ ...server({}), enabled: false }, 'google-gemini', { geminiKey: key }).backend, 'gemini');
  // No key: the chat has no transcriber of its own, so the fallback speaks.
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local' }), 'google-gemini', {}).source, 'fallback');
  // Antigravity's id is "gemini" in the app; Elpis holds no Antigravity credential, so it never borrows the API key.
  assert.equal(transcriptionStatus(server({ WHISPERTYPE_BACKEND: 'local' }), 'gemini', { geminiKey: key }).backend, 'local');
});

test('a missing, disabled or remote WhisperType server is unavailable for every provider', () => {
  const config = server({ WHISPERTYPE_BACKEND: 'codex', WHISPERTYPE_CLOUD_MODEL: MODEL });
  for (const provider of ['openai', 'openrouter', 'anthropic', undefined]) {
    for (const def of [null, { ...config, enabled: false }, { url: 'https://mcp.example' }]) assert.equal(transcriptionStatus(def, provider).available, false);
  }
});

test('an unsupported fallback engine stops only the providers that need the fallback', () => {
  const config = server({ WHISPERTYPE_BACKEND: 'invalid' });
  assert.equal(transcriptionStatus(config, 'anthropic').available, false);
  assert.equal(transcriptionStatus(config, undefined).available, false);
  assert.equal(transcriptionStatus(config, 'openai').available, true);
});

async function call(handle, mime, audio = Buffer.from('clip'), { provider, backend = 'local' } = {}) {
  const request = Readable.from([audio]); request.method = 'POST'; request.url = `/api/tools/transcription${provider === undefined ? '' : `?provider=${encodeURIComponent(provider)}`}`;
  request.headers = { 'content-type': mime, 'x-elpis-transcription-backend': backend };
  const response = new PassThrough();
  let result;
  await handle(request, response, (_res, status, value) => { result = { status, value }; });
  return result;
}

async function status(handle, provider) {
  const request = new Readable({ read() { this.push(null); } }); request.method = 'GET'; request.headers = {};
  request.url = `/api/tools/transcription${provider === undefined ? '' : `?provider=${encodeURIComponent(provider)}`}`;
  let result;
  await handle(request, new PassThrough(), (_res, code, value) => { result = { code, value }; });
  return result;
}

test('audio route enforces type/size, never accepts command overrides, and returns transcript only', async () => {
  const seen = [];
  const handle = createTranscription({ definition: async () => ({ command: 'configured-server', env: { WHISPERTYPE_BACKEND: 'local' } }), normalize: async audio => audio,
    transcribe: async (config, audio) => { seen.push([config.command, audio.toString()]); return 'متن گفتار'; } });
  assert.deepEqual(await call(handle, 'audio/webm;codecs=opus'), { status: 200, value: { text: 'متن گفتار' } });
  assert.deepEqual(seen, [['configured-server', 'clip']]);
  await assert.rejects(call(handle, 'application/json', Buffer.from('{"command":"wrong"}')), /audio/i);
  await assert.rejects(call(handle, 'audio/webm', Buffer.alloc(8 * 1024 * 1024 + 1)), /large/i);
  assert.equal(seen.length, 1);
  const changed = createTranscription({ definition: async () => ({ command: 'server', env: { WHISPERTYPE_BACKEND: 'codex' } }),
    normalize: async () => { throw Error('Must not process audio after an unseen provider change'); } });
  await assert.rejects(call(changed, 'audio/wav'), /provider changed/i);
});

test('the route answers for the chat provider and records with exactly that transcriber', async () => {
  const backends = [];
  const handle = createTranscription({ definition: async () => ({ command: 'server', env: { WHISPERTYPE_BACKEND: 'local', WHISPERTYPE_CLOUD_MODEL: MODEL } }), normalize: async audio => audio,
    transcribe: async (_config, _audio, _signal, backend) => { backends.push(backend); return 'text'; } });
  assert.deepEqual((await status(handle, 'openai')).value, { available: true, backend: 'codex', label: 'ChatGPT sign-in (cloud)', source: 'provider' });
  assert.deepEqual((await status(handle, 'anthropic')).value, { available: true, backend: 'local', label: 'Local WhisperType', source: 'fallback' });
  assert.equal((await status(handle)).value.backend, 'local');
  assert.equal((await status(handle, 'x'.repeat(200))).value.backend, 'local'); // an unusable provider name is just another unknown provider
  assert.deepEqual(await call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'openai', backend: 'codex' }), { status: 200, value: { text: 'text' } });
  await call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'openrouter', backend: 'openrouter' });
  await call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'claude', backend: 'local' });
  assert.deepEqual(backends, ['codex', 'openrouter', 'local']);
  await assert.rejects(call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'openai', backend: 'local' }), /provider changed/i); // the page's route is stale
  assert.deepEqual(backends, ['codex', 'openrouter', 'local']);
  const unavailable = createTranscription({ definition: async () => ({ command: 'server', env: { WHISPERTYPE_BACKEND: 'local' } }), normalize: async audio => audio, transcribe: async () => 'never' });
  await assert.rejects(call(unavailable, 'audio/ogg', Buffer.from('clip'), { provider: 'openrouter', backend: 'openrouter' }), /Settings → Voice/);
});

test('the route reads the private environment: the Gemini key reaches only the Gemini call and the Elpis home only the codex call', async () => {
  const seen = []; const key = 'AIza-private-key', home = '/home/person/.elpis-test';
  const handle = createTranscription({ definition: async () => server({ WHISPERTYPE_BACKEND: 'local' }), environment: async () => ({ chatgpt: true, home, geminiKey: key }), normalize: async audio => audio,
    transcribe: async (_config, _audio, _signal, backend, elpisHome) => { seen.push(['mcp', backend, elpisHome]); return 'from mcp'; },
    gemini: async (geminiKey, audio) => { seen.push(['gemini', geminiKey === key, audio.toString()]); return 'from gemini'; } });
  assert.deepEqual((await status(handle, 'google-gemini')).value, { available: true, backend: 'gemini', label: 'Gemini API (cloud) · gemini-flash-latest', source: 'provider' });
  assert.deepEqual(await call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'google-gemini', backend: 'gemini' }), { status: 200, value: { text: 'from gemini' } });
  assert.deepEqual(await call(handle, 'audio/ogg', Buffer.from('clip'), { provider: 'openai', backend: 'codex' }), { status: 200, value: { text: 'from mcp' } });
  assert.deepEqual(seen, [['gemini', true, 'clip'], ['mcp', 'codex', home]]);
  // A broken environment read never blocks dictation: the fallback is just Local.
  const broken = createTranscription({ definition: async () => server({}), environment: async () => { throw Error('engine unavailable'); } });
  assert.equal((await status(broken, 'anthropic')).value.backend, 'local');
});

test('dictation serializes work and cancellation reaches the owned request', async () => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const handle = createTranscription({ definition: async () => ({ command: 'server', env: { WHISPERTYPE_BACKEND: 'local' } }), normalize: async audio => audio,
    transcribe: async (_def, _audio, signal) => { started(signal); return await new Promise(resolve => { finish = resolve; }); } });
  const request = Readable.from([Buffer.from('clip')]); request.method = 'POST'; request.headers = { 'content-type': 'audio/ogg', 'x-elpis-transcription-backend': 'local' };
  const response = new PassThrough();
  const pending = handle(request, response, () => {});
  const signal = await ready;
  await assert.rejects(call(handle, 'audio/ogg'), /already/i);
  response.emit('close'); assert.equal(signal.aborted, true);
  finish('late response'); await pending;
});

test('normalization rejects invalid audio rather than forwarding it to a provider', async () => {
  await assert.rejects(normalizeAudio(Buffer.from('not audio'), 'audio/webm', new AbortController().signal), /recording/i);
});

test('compressed upload size cannot bypass the two-minute decoded audio limit', async () => {
  const audio = Buffer.alloc(44 + 121 * 32000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  await assert.rejects(normalizeAudio(audio, 'audio/wav', new AbortController().signal), /two minutes/i);
});

// A real child process checks the MCP handshake and fixed tool arguments without a network call.
const fakeMcp = `let text=''; process.stdin.on('data',chunk=>{text+=chunk;let n;while((n=text.indexOf('\\n'))>=0){const m=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'sample',version:'1'}}}));if(m.id===2){const a=m.params.arguments;const ok=m.params.name==='transcribe_audio'&&a.refine_prompt===false&&a.backend==='local'&&a.audio_base64==='Y2xpcA==';console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({success:ok,text:'Speech inserted into draft'})}]}}));}}});`;
test('MCP transcription initializes, calls only transcribe_audio and closes its child', async () => {
  const config = { command: process.execPath, args: ['-e', fakeMcp], env: { WHISPERTYPE_BACKEND: 'local' } };
  assert.equal(await transcribeMcp(config, Buffer.from('clip'), new AbortController().signal), 'Speech inserted into draft');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(transcribeMcp(config, Buffer.from('clip'), cancelled.signal), /cancel/i);
});
test('MCP transcription asks WhisperType for the route chosen for this chat, not the configured fallback', async () => {
  const config = { command: process.execPath, args: ['-e', fakeMcp], env: { WHISPERTYPE_BACKEND: 'codex' } };
  assert.equal(await transcribeMcp(config, Buffer.from('clip'), new AbortController().signal, 'local'), 'Speech inserted into draft');
  await assert.rejects(transcribeMcp(config, Buffer.from('clip'), new AbortController().signal), /could not transcribe/i); // the fake accepts only backend "local"
});

// The fake WhisperType returns the CODEX_HOME it was started with, so the test sees which ChatGPT sign-in it would read.
const fakeHome = `let t='';process.stdin.on('data',c=>{t+=c;let n;while((n=t.indexOf('\\n'))>=0){const m=JSON.parse(t.slice(0,n));t=t.slice(n+1);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'s',version:'1'}}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({success:true,text:String(process.env.CODEX_HOME)})}]}}));}});`;
test('the codex route reads the Elpis home ChatGPT sign-in; an explicit CODEX_HOME in the server env still wins', async () => {
  const run = (env, route, home) => transcribeMcp({ command: process.execPath, args: ['-e', fakeHome], env }, Buffer.from('clip'), new AbortController().signal, route, home);
  assert.equal(await run({ WHISPERTYPE_BACKEND: 'local' }, 'codex', '/elpis/home'), '/elpis/home');
  assert.equal(await run({ WHISPERTYPE_BACKEND: 'local', CODEX_HOME: '/chosen/home' }, 'codex', '/elpis/home'), '/chosen/home');
  assert.notEqual(await run({ WHISPERTYPE_BACKEND: 'local' }, 'local', '/elpis/home'), '/elpis/home', 'other routes never get the Elpis home');
  assert.equal(await run({ WHISPERTYPE_BACKEND: 'local' }, 'codex', null), String(process.env.CODEX_HOME), 'no known Elpis home leaves the environment alone');
});

// A local HTTP server stands in for Google: no call ever leaves this machine.
async function googleMock(reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const out = reply(requests.length);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) }); res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, api: `http://127.0.0.1:${server.address().port}/v1beta`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
const spoken = text => ({ body: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] } });

test('Gemini transcription sends the documented generateContent request with the key in the header only', async () => {
  const google = await googleMock(() => spoken('  Hello from the recording.\n'));
  try {
    const wav = Buffer.from('RIFF....WAVEfmt fake-wav-bytes');
    const text = await transcribeGemini('AIza-private-key', wav, new AbortController().signal, { api: google.api });
    assert.equal(text, 'Hello from the recording.');
    const [request] = google.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1beta/models/gemini-flash-latest:generateContent');
    assert.equal(request.headers['x-goog-api-key'], 'AIza-private-key');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.url.includes('AIza'), false, 'the key never goes in the URL');
    assert.deepEqual(Object.keys(request.body).sort(), ['contents', 'generationConfig']);
    const [turn] = request.body.contents;
    assert.equal(turn.role, 'user');
    assert.deepEqual(turn.parts[1], { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } });
    assert.match(turn.parts[0].text, /Transcribe .*verbatim.*transcript only/i);
    assert.deepEqual(request.body.generationConfig, { temperature: 0 });
  } finally { await google.close(); }
});

test('Gemini transcription joins text parts, skips reasoning, and reports every failure without the key', async () => {
  const key = 'AIza-private-key', signal = () => new AbortController().signal;
  const cases = [
    [{ body: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Part one. ' }, { text: 'Part two.' }] } }] } }, undefined, 'Part one. Part two.'],
    [{ body: { candidates: [] } }, /no transcript/i],
    [{ body: { candidates: [{ content: { parts: [{ text: '   ' }] } }] } }, /no transcript/i],
    [{ body: { promptFeedback: { blockReason: 'OTHER' } } }, /no transcript/i],
    [{ status: 403, body: { error: { message: `API key ${key} not valid` } } }, /rejected the API key/i],
    [{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } } }, /rejected the API key/i], // how Google reports a bad key
    [{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'unsupported audio' } } }, /HTTP 400/],
    [{ status: 429, body: { error: { message: 'quota' } } }, /rate/i],
    [{ status: 500, body: 'oops' }, /HTTP 500/],
    [{ body: '{not json' }, /unreadable/i],
    [{ status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' }, body: '' }, /could not be reached|redirect/i],
  ];
  for (const [reply, failure, expected] of cases) {
    const google = await googleMock(() => reply);
    try {
      if (expected) assert.equal(await transcribeGemini(key, Buffer.from('x'), signal(), { api: google.api }), expected);
      else await assert.rejects(transcribeGemini(key, Buffer.from('x'), signal(), { api: google.api }), error => { assert.match(error.message, failure); assert.equal(error.message.includes(key), false); return true; });
    } finally { await google.close(); }
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(transcribeGemini(key, Buffer.from('x'), aborted.signal, { api: 'http://127.0.0.1:1/v1beta' }), /cancel/i);
  await assert.rejects(transcribeGemini(key, Buffer.from('x'), signal(), { api: 'http://127.0.0.1:1/v1beta' }), error => /could not be reached/i.test(error.message) && !error.message.includes(key));
});

test('cancelling mid-request stops the Gemini call', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const google = await googleMock(() => { release(); return spoken('late'); });
  const controller = new AbortController();
  const pending = transcribeGemini('k', Buffer.from('x'), controller.signal, { api: google.api, fetchImpl: (url, init) => { controller.abort(); return fetch(url, init); } });
  await assert.rejects(pending, /cancel/i);
  await google.close(); void held;
});

test('a Google Gemini chat is transcribed end to end against a local Google stand-in, with no WhisperType at all', async () => {
  const google = await googleMock(() => spoken('Dictated through Gemini.'));
  try {
    const handle = createTranscription({ definition: async () => null, environment: async () => ({ chatgpt: false, home: '/unused', geminiKey: 'AIza-private-key' }), normalize: async audio => audio,
      transcribe: async () => { throw Error('WhisperType must not run for a Gemini chat'); }, gemini: (key, audio, signal) => transcribeGemini(key, audio, signal, { api: google.api }) });
    assert.deepEqual(await call(handle, 'audio/ogg', Buffer.from('spoken clip'), { provider: 'google-gemini', backend: 'gemini' }), { status: 200, value: { text: 'Dictated through Gemini.' } });
    assert.equal(google.requests.length, 1);
    assert.equal(google.requests[0].body.contents[0].parts[1].inline_data.data, Buffer.from('spoken clip').toString('base64'));
    assert.equal(google.requests[0].headers['x-goog-api-key'], 'AIza-private-key');
    await assert.rejects(call(handle, 'audio/ogg', Buffer.from('spoken clip'), { provider: 'google-gemini', backend: 'codex' }), /provider changed/i);
    assert.equal(google.requests.length, 1, 'a stale route reaches no provider');
  } finally { await google.close(); }
});
