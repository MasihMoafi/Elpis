// Real packaged desktop, its bridge and installed engine; isolated profile, local fixtures, no inference.
// ELPIS_TEST_APP=/absolute/package node --test tests/project-subagents.runtime.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { connectAppServer } from '../../../tools/elpis-claude/app-server-connection.mjs';

const require = createRequire(import.meta.url), { seedChats } = require('./seed-chats.cjs');
const run = promisify(execFile);
const verify = fileURLToPath(new URL('../../../.agents/skills/verify-elpis-desktop/elpis-verify', import.meta.url));

test('project provider helpers stay under their parent, with search and restart preserving placement', {
  skip: !process.env.ELPIS_TEST_APP, timeout: 180000,
}, async t => {
  let started;
  try { started = await run(verify, ['start', process.env.ELPIS_TEST_APP], { timeout: 150000 }); }
  catch (error) {
    const failedRun = error.stdout?.match(/run (\d+):/)?.[1];
    if (failedRun) await run(verify, ['stop'], { env: { ...process.env, ELPIS_VERIFY_RUN: failedRun }, timeout: 30000 });
    throw error;
  }
  const pin = started.stdout.match(/ELPIS_VERIFY_RUN=(\d+)/)?.[1];
  assert.ok(pin, started.stdout);
  const env = { ...process.env, ELPIS_VERIFY_RUN: pin };
  const home = started.stdout.match(/^home (.+)$/m)?.[1];
  const evidence = started.stdout.match(/^evidence (.+)$/m)?.[1];
  assert.ok(home); assert.ok(evidence);
  const command = async (...args) => (await run(verify, args, { env, timeout: 90000 })).stdout.trim();
  t.after(async () => { await command('stop'); });
  t.diagnostic(`package ${process.env.ELPIS_TEST_APP}; evidence ${evidence}`);
  const drive = (...args) => command('drive', ...args);
  const evaluate = async expression => JSON.parse(await drive('eval', expression));
  const appHome = path.join(home, 'elpis'), cwd = path.join(home, 'work/demo');
  const ids = seedChats(appHome, [
    { key: 'parent', name: 'Project owner', text: 'Own this project', minutesAgo: 30, cwd },
    { key: 'ordinary', name: 'Independent chat', text: 'My own chat in the same folder', minutesAgo: 20, cwd },
    { key: 'helper', name: 'Gemini OCR helper', text: 'Read one page', minutesAgo: 10, cwd },
    { key: 'grandchild', name: 'Nested OCR helper', text: 'Check a field', minutesAgo: 5, cwd },
  ]);
  // Provider chats have only native metadata; their messages and explicit parents live in the provider registry.
  // This forces the fallback listing that originally leaked the helpers into Recents.
  for (const file of await fs.readdir(path.join(appHome, 'sessions'), { recursive: true })) {
    if (![ids.helper, ids.grandchild].some(id => file.endsWith(`${id}.jsonl`))) continue;
    const absolute = path.join(appHome, 'sessions', file), rows = (await fs.readFile(absolute, 'utf8')).trim().split('\n');
    const header = JSON.parse(rows[0]); delete header.payload.thread_source;
    await fs.writeFile(absolute, JSON.stringify(header) + '\n');
  }
  const registryFile = path.join(appHome, 'elpis-claude/sessions.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8').catch(() => '{}'));
  registry._delegations = { [ids.helper]: { parentThreadId: ids.parent, model: 'agy/gemini' }, [ids.grandchild]: { parentThreadId: ids.helper, model: 'agy/gemini' } };
  for (const id of [ids.helper, ids.grandchild]) registry[id] = { model: 'agy/gemini', turns: [{ id: `turn-${id}`, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Read this image' }] }] }] };
  await fs.mkdir(path.dirname(registryFile), { recursive: true });
  await fs.writeFile(registryFile + '.pending', JSON.stringify(registry)); await fs.rename(registryFile + '.pending', registryFile);
  const runtime = path.join(home, 'run/elpis-bridge');
  const [key] = await fs.readdir(runtime);
  const connection = connectAppServer({ url: `ws+unix://${path.join(runtime, key, 'bridge.sock')}:/` });
  try {
    await connection.ready;
    for (const id of Object.values(ids)) await connection.call('thread/read', { threadId: id, includeTurns: false });
  } finally { connection.close(); }
  const storage = {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'project', name: 'Legal project', cwd }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ [ids.parent]: 'project' }),
  };
  await evaluate(`(async () => { for (const [key, value] of Object.entries(${JSON.stringify(storage)})) await window.elpisDesktop.storage.saveItem(key, value); return true; })()`);
  await command('restart'); await command('doctor');
  const row = id => `.thread-row[data-thread-id="${id}"]`;
  const project = 'aside.sidebar section[aria-label="Projects"]';
  const recents = 'aside.sidebar section[aria-label="Recents"]';
  await drive('wait', '--css', `${project} ${row(ids.parent)}`);
  await drive('shot', 'project-subagents-folded.png');
  assert.equal(await drive('count', '--css', `aside.sidebar ${row(ids.helper)}`), '0', 'a folded project helper never leaks into Recents');
  assert.equal(await drive('count', '--css', `${recents} ${row(ids.ordinary)}`), '1', 'same folder does not absorb an independent chat');
  await drive('click', '--role', 'button', '--name', 'Expand agents in Project owner', '--in', project);
  await drive('wait', '--css', `${project} ${row(ids.helper)}.child`);
  await drive('click', '--role', 'button', '--name', 'Expand agents in Gemini OCR helper', '--in', project);
  await drive('wait', '--css', `${project} ${row(ids.grandchild)}.child`);
  await drive('shot', 'project-subagents-expanded.png');
  for (const id of [ids.helper, ids.grandchild]) assert.equal(await drive('count', '--css', `${recents} ${row(id)}`), '0');
  await drive('click', '--role', 'button', '--name', 'Legal project', '--in', project);
  assert.equal(await drive('count', '--css', `aside.sidebar ${row(ids.helper)}`), '0', 'folding the project hides its descendants');
  await drive('click', '--role', 'button', '--name', 'Legal project', '--in', project);
  await drive('fill', '--role', 'textbox', '--name', 'Search conversations', '--value', 'Gemini OCR helper');
  await drive('wait', '--css', `section[aria-label="Results"] ${row(ids.helper)}`);
  await drive('fill', '--role', 'textbox', '--name', 'Search conversations', '--value', '');
  await command('restart');
  await drive('wait', '--css', `${project} ${row(ids.parent)}`);
  assert.equal(await drive('count', '--css', `aside.sidebar ${row(ids.helper)}`), '0', 'restart folds the family under its project again');
  const saved = JSON.parse(await fs.readFile(path.join(home, 'profile/workspace.json'), 'utf8'));
  assert.equal(JSON.parse(saved['elpis-project-chats-v1'])[ids.parent], 'project');
});
