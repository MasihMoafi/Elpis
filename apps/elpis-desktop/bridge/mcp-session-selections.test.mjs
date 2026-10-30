import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpSessionSelections } from '../../../tools/elpis-claude/mcp-session-selections.mjs';

async function temp(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-session-selections-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return path.join(home, 'desktop-mcp-selections');
}

test('per-thread server names survive a DesktopClient recreation and contain no definitions or credentials', async t => {
  const file = await temp(t);
  const before = new McpSessionSelections(file);
  await Promise.all([before.set('thread-a', ['rag', 'remote']), before.set('thread-b', [])]);
  const saved = await fs.readFile(path.join(file, 'thread-a.json'), 'utf8');
  assert.doesNotMatch(saved, /command|url|secret|token/i);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(file, 'thread-a.json'))).mode & 0o777, 0o600);
  const afterRestart = new McpSessionSelections(file);
  assert.deepEqual(afterRestart.get('thread-a'), ['rag', 'remote']);
  assert.deepEqual(afterRestart.get('thread-b'), []);
  assert.equal(afterRestart.get('old-thread'), undefined);
});

test('the per-thread store rejects invalid names and deletes only the requested thread', async t => {
  const file = await temp(t), selections = new McpSessionSelections(file);
  await selections.set('thread-a', ['rag']); await selections.set('thread-b', ['remote']);
  await assert.rejects(selections.set('thread-a', ['not.valid']), /Invalid per-thread MCP server names/);
  await assert.rejects(selections.set('../escape', ['rag']), /Invalid per-thread MCP server names/);
  assert.equal(selections.get('../escape'), undefined);
  await selections.delete('thread-a');
  const restarted = new McpSessionSelections(file);
  assert.equal(restarted.get('thread-a'), undefined);
  assert.deepEqual(restarted.get('thread-b'), ['remote']);
});
