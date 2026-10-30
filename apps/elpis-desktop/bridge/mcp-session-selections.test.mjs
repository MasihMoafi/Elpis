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

test('only a missing record means legacy; malformed, unreadable, or invalid records fail closed', async t => {
  const file = await temp(t), selections = new McpSessionSelections(file);
  assert.equal(selections.get('legacy'), undefined);

  await fs.mkdir(file, { recursive: true });
  await fs.writeFile(path.join(file, 'corrupt.json'), '{');
  assert.throws(() => selections.get('corrupt'), /Unreadable per-thread MCP selection/);
  await fs.writeFile(path.join(file, 'invalid.json'), JSON.stringify({ version: 1, threadId: 'invalid', servers: ['bad.name'] }));
  assert.throws(() => selections.get('invalid'), /Invalid per-thread MCP selection record/);
  await fs.mkdir(path.join(file, 'unreadable.json'));
  assert.throws(() => selections.get('unreadable'), error => error.code === 'EISDIR');
  assert.throws(() => selections.get('../escape'), /Invalid MCP thread ID/);
});

test('the per-thread store rejects invalid names and deletes only the requested thread', async t => {
  const file = await temp(t), selections = new McpSessionSelections(file);
  await selections.set('thread-a', ['rag']); await selections.set('thread-b', ['remote']);
  await assert.rejects(selections.set('thread-a', ['not.valid']), /Invalid per-thread MCP server names/);
  await assert.rejects(selections.set('../escape', ['rag']), /Invalid per-thread MCP server names/);
  await selections.delete('thread-a');
  const restarted = new McpSessionSelections(file);
  assert.equal(restarted.get('thread-a'), undefined, 'only an absent record means legacy');
  assert.deepEqual(restarted.get('thread-b'), ['remote']);
});

test('the session store checks its write and rename path before a thread starts', async t => {
  const file = await temp(t), selections = new McpSessionSelections(file);
  await selections.assertWritable();
  await fs.rm(file, { recursive: true });
  await fs.writeFile(file, 'blocks the store directory');
  await assert.rejects(selections.assertWritable());
});
