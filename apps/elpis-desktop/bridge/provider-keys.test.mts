import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProviderKeys, saveProviderKey } from './provider-keys.mts';

// The gateway reads built-in provider keys (OpenRouter, Anthropic, Gemini) from this file; Models & accounts saves,
// replaces and clears them here (7 Nov: a key saved in config.toml never reached OpenRouter).
test('a provider key is saved privately, replaced and cleared without touching the others', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-keys-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700);
  saveProviderKey(home, 'openrouter', 'sk-or-first');
  saveProviderKey(home, 'anthropic', 'sk-ant-kept');
  saveProviderKey(home, 'openrouter', 'sk-or-second');
  assert.deepEqual(loadProviderKeys(home), { openrouter: 'sk-or-second', anthropic: 'sk-ant-kept' });
  const file = fs.readdirSync(home).find(name => !name.startsWith('.'))!;
  assert.equal(fs.statSync(path.join(home, file)).mode & 0o077, 0, 'readable by its owner alone');
  saveProviderKey(home, 'openrouter', null);
  assert.deepEqual(loadProviderKeys(home), { anthropic: 'sk-ant-kept' });
  assert.throws(() => saveProviderKey(home, 'openrouter', ''), /API key must be/);
});
