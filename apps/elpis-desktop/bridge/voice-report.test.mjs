import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordVoiceCall } from './voice.mjs';

// Masih, 23 Oct: the voice "doesn't answer back to me"; each call now leaves one line saying what it heard and sent, with no words in it.
const report = (extra = {}) => ({ seconds: 31.4, listened: true, events: { 'session.started': 1, 'input_transcript.added': 12, 'output_transcript.added': 1 }, inboundBytes: 89295, inboundPackets: 1757, inboundEnergy: 0.03, micEnergy: 1.6, error: '', ...extra });

test('a call report is written as one bounded line, and nothing that is not a number or a short name is accepted', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-voice-report-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.deepEqual(await recordVoiceCall(home, report()), { ok: true });
  const [line] = (await fs.readFile(path.join(home, 'logs', 'voice-calls.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual({ ...JSON.parse(line), at: undefined }, { at: undefined, ...report() });
  for (const bad of [report({ seconds: 'long' }), report({ listened: 'yes' }), report({ events: { 'a b': 1 } }), report({ events: { ok: 'many' } }), report({ events: [] }), { ...report(), words: 'hello' }, report({ inboundBytes: -1 })])
    await assert.rejects(recordVoiceCall(home, bad), /Invalid|not allowed|Unsupported|unknown/i);
  assert.equal(JSON.parse((await fs.readFile(path.join(home, 'logs', 'voice-calls.jsonl'), 'utf8')).trim().split('\n').at(-1)).error, '', 'a refused report leaves nothing behind');
  for (let call = 0; call < 230; call++) await recordVoiceCall(home, report({ seconds: call }));
  const lines = (await fs.readFile(path.join(home, 'logs', 'voice-calls.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 200, 'only the last 200 calls are kept'); assert.equal(JSON.parse(lines.at(-1)).seconds, 229);
  assert.equal(JSON.parse(await recordVoiceCall(home, report({ error: 'x'.repeat(500) })).then(() => fs.readFile(path.join(home, 'logs', 'voice-calls.jsonl'), 'utf8')).then(text => text.trim().split('\n').at(-1))).error.length, 200, 'an error text is cut to 200 characters');
});
