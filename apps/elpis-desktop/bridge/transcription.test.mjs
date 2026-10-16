import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { transcriptionStatus, createTranscription, normalizeAudio, transcribeMcp } from './transcription.mjs';

test('dictation exposes only availability and the actual WhisperType route', () => {
  const config = { command: 'private-command', env: { WHISPERTYPE_BACKEND: 'codex', SECRET_KEY: 'private-key' } };
  assert.deepEqual(transcriptionStatus(config), { available: true, backend: 'codex', label: 'ChatGPT sign-in (cloud)' });
  assert.equal(JSON.stringify(transcriptionStatus(config)).includes('private'), false);
  for (const def of [null, { ...config, enabled: false }, { url: 'https://mcp.example' }, { ...config, env: { WHISPERTYPE_BACKEND: 'invalid' } }]) assert.equal(transcriptionStatus(def).available, false);
});

async function call(handle, mime, audio = Buffer.from('clip')) {
  const request = Readable.from([audio]); request.headers = { 'content-type': mime, 'x-elpis-transcription-backend': 'local' }; request.method = 'POST';
  const response = new PassThrough();
  let result;
  await handle(request, response, (_res, status, value) => { result = { status, value }; });
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
