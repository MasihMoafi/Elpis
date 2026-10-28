// context-agent.mjs with the real ACP adapter and Agent SDK, and a `claude` that records how it
// was started: every session start loads only the MCP servers it is given, and a worker that
// ends, or an adapter that shuts down, leaves no process behind.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';

const AGENT = fileURLToPath(new URL('../context-agent.mjs', import.meta.url));
// Started as a session's worker with FAKE_TREE, it starts sleeps the way MCP servers hang below
// Claude Code: a child, a grandchild, and one that outlives SIGTERM and writes when it came.
// Then it exits or stays.
const FAKE_CLAUDE = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/argv.log"
[ -n "$FAKE_TREE" ] || exit 1
case "$*" in *--input-format*) ;; *) exit 1 ;; esac
sleep 300 & child=$!
sh -c 'sleep 300 & echo $! > "$0/grandchild"; wait' "$dir" & parent=$!
sh -c 'trap "date +%s%3N > $0/term" TERM; : > "$0/trapped"; while :; do sleep 0.1 & wait $!; done' "$dir" & survivor=$!
until [ -s "$dir/grandchild" ] && [ -e "$dir/trapped" ]; do sleep 0.02; done
echo "$$ $(cut -d' ' -f5 /proc/$$/stat) $child $parent $(cat "$dir/grandchild") $survivor" > "$dir/tree"
[ "$FAKE_TREE" = stay ] && wait
exit 1
`;

// A process's state and group, or null once it is gone (a zombie is gone).
function stat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state, , pgrp] = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return state === 'Z' ? null : { pgrp: Number(pgrp) };
  } catch { return null; }
}
const members = pgid => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name) && stat(name)?.pgrp === pgid);

async function startAgent(t, env = {}) {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-worker-'));
  const claude = path.join(root, 'claude'), home = path.join(root, 'home');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  fs.mkdirSync(home);
  const child = spawn(process.execPath, [AGENT], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CODE_EXECUTABLE: claude, ...env } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const replies = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method) replies.get(msg.id)?.(msg);
  });
  const call = (method, params) => new Promise(resolve => {
    const id = nextId++;
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    // A failed run must not leave its sleeps either.
    const [worker, pgid, ...pids] = fs.existsSync(path.join(root, 'tree')) ? fs.readFileSync(path.join(root, 'tree'), 'utf8').trim().split(' ').map(Number) : [];
    for (const pid of [worker, ...pids, ...(worker > 0 && pgid === worker ? [-worker] : [])]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    removeTestTempDir(root);
  });
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.ok(init.result, `initialize: ${JSON.stringify(init.error)} ${stderr}`);
  return { root, child, call, stderr: () => stderr };
}

async function readTree(root) {
  const file = path.join(root, 'tree');
  for (const deadline = Date.now() + 15000; !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').endsWith('\n'); await pause(20)) {
    if (Date.now() > deadline) throw new Error('the fake worker never started its tree');
  }
  const [worker, pgid, ...pids] = fs.readFileSync(file, 'utf8').trim().split(' ').map(Number);
  return { root, worker, pgid, pids, survivor: pids.at(-1) };
}

// Every process of the tree gets SIGTERM; the one that outlives it is killed 2 s later; none remains.
async function assertEnded({ root, worker, pgid, pids, survivor }) {
  assert.equal(pgid, worker, 'the worker leads its own process group');
  let survivorGone = null;
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await pause(25)) {
    if (stat(survivor)) continue;
    survivorGone ??= Date.now();
    if (!members(pgid).length && !pids.some(stat)) break;
  }
  assert.deepEqual(members(pgid), [], 'no process is left in the worker group');
  assert.deepEqual(pids.filter(stat), [], 'no process of the tree is left');
  const term = Number(fs.readFileSync(path.join(root, 'term'), 'utf8'));
  assert.ok(survivorGone - term >= 1500, `the SIGTERM survivor lived ${survivorGone - term} ms after SIGTERM: SIGKILL waits 2 s`);
}

test('every session start loads only the MCP servers it is given', { timeout: 60000 }, async t => {
  for (const [label, env, strict] of [['by default', {}, true], ['with ELPIS_WORKER_USER_MCP=1', { ELPIS_WORKER_USER_MCP: '1' }, false]]) {
    const agent = await startAgent(t, env);
    const mcpServers = [{ name: 'elpis-agents', command: process.execPath, args: ['elpis-agents-mcp.mjs'], env: [] }];
    const _meta = { claudeCode: { options: { disallowedTools: ['Task'] } } };
    await agent.call('session/new', { cwd: agent.root, mcpServers, _meta });
    await agent.call('session/load', { sessionId: randomUUID(), cwd: agent.root, mcpServers, _meta });
    const runs = fs.readFileSync(path.join(agent.root, 'argv.log'), 'utf8').trim().split('\n').filter(argv => argv.includes('--input-format stream-json'));
    assert.equal(runs.length, 2, `${label}: session/new and session/load each start Claude Code\n${agent.stderr()}`);
    for (const argv of runs) {
      assert.equal(argv.split(' ').includes('--strict-mcp-config'), strict, `${label}: strict MCP config ${strict ? 'on' : 'off'}`);
      assert.match(argv, /--mcp-config \S*"elpis-agents"/, `${label}: the servers Elpis passes still arrive`);
      assert.match(argv, /--disallowedTools \S*Task/, `${label}: the caller's own options still arrive`);
    }
  }
});

test('a worker that exits takes every process below it along', { timeout: 60000 }, async t => {
  const agent = await startAgent(t, { FAKE_TREE: 'exit' });
  const reply = agent.call('session/new', { cwd: agent.root, mcpServers: [] });
  await assertEnded(await readTree(agent.root));
  assert.ok((await reply).error, 'the session reports its worker ended');
  assert.equal(agent.child.exitCode, null, 'the adapter keeps serving');
});

test('an adapter that shuts down ends its workers and every process below them', { timeout: 60000 }, async t => {
  const agent = await startAgent(t, { FAKE_TREE: 'stay' });
  void agent.call('session/new', { cwd: agent.root, mcpServers: [] }); // the worker never answers
  const tree = await readTree(agent.root);
  const exited = once(agent.child, 'exit');
  agent.child.kill('SIGTERM'); // as the bridge stops an adapter
  await assertEnded(tree);
  assert.deepEqual(await exited, [0, null], 'the adapter exits once its workers are gone');
});
