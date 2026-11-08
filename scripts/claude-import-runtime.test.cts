'use strict';
// E-20261108-IMPORT: use the real native importer, without credentials or inference.
import type { ExternalAgentConfigDetectResponse } from '../codex-rs/app-server-protocol/schema/typescript/v2/ExternalAgentConfigDetectResponse.ts';
import type { ExternalAgentConfigImportResponse } from '../codex-rs/app-server-protocol/schema/typescript/v2/ExternalAgentConfigImportResponse.ts';
import type { ExternalAgentConfigImportHistoriesReadResponse } from '../codex-rs/app-server-protocol/schema/typescript/v2/ExternalAgentConfigImportHistoriesReadResponse.ts';
import type { SessionMigration } from '../codex-rs/app-server-protocol/schema/typescript/v2/SessionMigration.ts';
import type { ThreadReadResponse } from '../codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadResponse.ts';
import type { ThreadForkResponse } from '../codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkResponse.ts';

type Results = {
  initialize: unknown;
  'externalAgentConfig/detect': ExternalAgentConfigDetectResponse;
  'externalAgentConfig/import': ExternalAgentConfigImportResponse;
  'externalAgentConfig/import/readHistories': ExternalAgentConfigImportHistoriesReadResponse;
  'thread/read': ThreadReadResponse;
  'thread/fork': ThreadForkResponse;
};
type Waiter = { resolve(result: unknown): void; reject(error: unknown): void };
type Message = { id?: number; error?: unknown; result?: unknown };

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const readline: typeof import('node:readline') = require('node:readline');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { setTimeout: delay }: typeof import('node:timers/promises') = require('node:timers/promises');

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'provide the engine binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-claude-import-'));
const home = path.join(root, 'home'), elpisHome = path.join(home, '.elpis-next');
const accountId = randomUUID(), unknownId = randomUUID();
const accountHome = path.join(elpisHome, 'elpis-claude/claude-accounts', accountId);
const project = path.join(home, 'project');
for (const directory of [elpisHome, project]) fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(path.join(elpisHome, 'elpis-claude'), { recursive: true });
fs.writeFileSync(path.join(elpisHome, 'elpis-claude/claude-accounts.json'), JSON.stringify({ activeId: accountId, ids: [accountId] }));
fs.writeFileSync(path.join(elpisHome, 'config.toml'), 'model="gpt-5.5"\ncheck_for_update_on_startup=false\n');
function seed(directory: string, title: string) {
  const id = randomUUID(), file = path.join(directory, 'projects/demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = ['user', 'assistant'].map(role => JSON.stringify({
    type: role, sessionId: id, uuid: randomUUID(), cwd: project, timestamp: new Date().toISOString(),
    message: { role, content: role === 'user' ? title : `${title} reply` },
  }));
  fs.writeFileSync(file, records.join('\n') + '\n');
  return file;
}
const managed = seed(accountHome, 'Managed Claude chat');
const unknown = seed(path.join(elpisHome, 'elpis-claude/claude-accounts', unknownId), 'Unregistered account');
const originals = new Map<string, Buffer>([managed, unknown].map(file => [file, fs.readFileSync(file)]));
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ELPIS_HOME: elpisHome, CODEX_HOME: elpisHome, CODEX_AUTH_HOME: elpisHome,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share') };
for (const key of Object.keys(env)) if (/^(CLAUDE_|ANTHROPIC_|OPENAI_|CODEX_API_KEY|ELPIS_CONFIG_DIR)/.test(key)) delete env[key];
const child = spawn(binary, ['app-server'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
let nextId = 0, stderr = '';
const pending = new Map<number, Waiter>();
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('engine exited')); });
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const message: Message = JSON.parse(line), waiter = message.id === undefined ? undefined : pending.get(message.id);
  if (waiter && message.id !== undefined) {
    pending.delete(message.id);
    message.error ? waiter.reject(Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
  }
});
function request<M extends keyof Results>(method: M, params: object = {}): Promise<Results[M]> {
  const id = ++nextId;
  return new Promise<Results[M]>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout: ${method}`)); }, 20000);
    pending.set(id, {
      resolve: result => { clearTimeout(timer); resolve(result as Results[M]); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const detect = async () => (await request('externalAgentConfig/detect', { includeHome: true, source: 'claude' }))
  .items.filter(item => item.itemType === 'SESSIONS').flatMap(item => { assert(item.details); return item.details.sessions; });
async function importSessions(sessions: SessionMigration[]) {
  const { importId } = await request('externalAgentConfig/import', { source: 'claude', migrationItems: [
    { itemType: 'SESSIONS', description: 'Claude Code chats', cwd: null, details: { sessions } },
  ] });
  for (let attempt = 0; attempt < 100; attempt++) {
    const { data } = await request('externalAgentConfig/import/readHistories');
    const done = data.find(item => item.importId === importId);
    if (done) return done;
    await delay(50);
  }
  throw Error('import did not complete');
}
(async () => {
  try {
    await request('initialize', { clientInfo: { name: 'claude_import_regression', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    assert.deepEqual((await detect()).map(session => session.path), [managed], 'find the selected account with no default Claude folder; exclude unregistered accounts');
    console.log('PASS discover registered Claude account without a default Claude folder');
    const normal = seed(path.join(home, '.claude'), 'Default Claude chat');
    originals.set(normal, fs.readFileSync(normal));
    const sessions = await detect();
    assert.deepEqual(sessions.map(session => session.path).sort(), [managed, normal].sort(), 'both Claude homes are available');
    const rejected = await importSessions([{ path: unknown, cwd: project, title: 'Unregistered account' }]);
    assert.equal(rejected.successes.length, 0);
    assert.equal(rejected.failures.length, 1, 'an arbitrary account folder is not an import source');
    const done = await importSessions(sessions);
    assert.equal(done.failures.length, 0, JSON.stringify(done.failures));
    assert.equal(done.successes.length, 2, 'both account and default chats import');
    for (const success of done.successes) {
      assert(success.target && success.title, 'an imported session has a target and title');
      const { thread } = await request('thread/read', { threadId: success.target, includeTurns: true });
      const text = JSON.stringify(thread.turns);
      assert(text.includes(success.title), 'user message is preserved');
      assert(text.includes(`${success.title} reply`), 'assistant message is preserved');
      const fork = await request('thread/fork', { threadId: thread.id });
      assert(fork.thread.id && fork.thread.id !== thread.id, 'imported chat can be forked');
    }
    assert.deepEqual(await detect(), [], 'imported versions are not offered again');
    for (const [file, original] of originals) assert.deepEqual(fs.readFileSync(file), original, 'original transcript is unchanged');
    console.log('PASS import, open and fork full histories from both homes without duplicates or modifying originals');
    console.log('PASS reject an unregistered account transcript');
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
    lines.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (stderr) console.error(stderr); process.exitCode = 1; });
