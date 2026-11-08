import type { ServerResponse } from 'node:http';
import type { RpcApi } from './lib/rpc.cts';

type ModelRequest = { model?: string; tools?: unknown[]; input?: unknown; text?: { format?: { strict?: boolean; schema?: { required?: string[] } } } };
type ThreadResult = { thread: { id: string; name: string | null; updatedAt: number } };
type Notification = { method: string; params: { threadId: string } };

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs');
const http: typeof import('node:http') = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AppServer }: RpcApi = require('./lib/rpc.cts');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-title-test-'));
let rpc: InstanceType<RpcApi['AppServer']>;
const pending: { response: ServerResponse; body: ModelRequest }[] = [];
let titleRequests = 0;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw Error(message);
}
function respond(response: ServerResponse, text: string) {
  const item = { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
  ]) response.write('data: ' + JSON.stringify(event) + '\n\n');
  response.end();
}
const server = http.createServer(async (request, response) => {
  if (!(request.url as string).includes('/responses')) { response.end('{}'); return; }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body: ModelRequest = JSON.parse((request.headers['content-encoding'] === 'zstd' ? require('node:zlib').zstdDecompressSync(raw) : raw).toString());
  if (body.text?.format?.schema?.required?.includes('title')) {
    // Naming follows the session's provider, so assert the configured model
    // rather than a hardcoded OpenAI-only slug.
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.tools?.length || 0, 0);
    titleRequests++;
    pending.push({ response, body });
  } else respond(response, 'Acknowledged.');
});
async function turn(threadId: string, text: string) {
  let listener: (event: Notification) => void = () => {};
  const done = new Promise<void>(resolve => {
    listener = m => { if (m.method === 'turn/completed' && m.params.threadId === threadId) resolve(); };
    rpc.on('notification', listener);
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
    await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('naming blocked turn completion')), 8000); })]);
  } finally { clearTimeout(timeout); rpc.removeListener('notification', listener); }
}
const read = async (threadId: string) => ((await rpc.request('thread/read', { threadId, includeTurns: false })) as ThreadResult).thread;
async function start() { return ((await rpc.request('thread/start', { cwd: home, model: 'gpt-5.6-terra', approvalPolicy: 'never', sandbox: 'read-only' })) as ThreadResult).thread.id; }

(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.6-terra"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
  rpc = new AppServer(path.resolve(process.argv[2] || path.resolve(__dirname, '../codex-rs/target/local-release/codex-app-server')), home, { env: { ...process.env, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home } });
  rpc.on('disconnect', () => {});
  await rpc.request('initialize', { clientInfo: { name: 'session_title_test', version: '1' }, capabilities: { experimentalApi: true } });
  rpc.send({ method: 'initialized' });

  const first = await start();
  await turn(first, 'Hi'); await delay(200); assert.equal(titleRequests, 0);
  await turn(first, 'Fix terminal scrolling while the agent responds.');
  await until(() => pending.length === 1, 'no automatic title request');
  const titleRequest = pending[0]; assert(titleRequest);
  assert(JSON.stringify(titleRequest.body.input).includes('Fix terminal scrolling'));
  const before = await read(first);
  const titleResponse = pending.shift(); assert(titleResponse);
  respond(titleResponse.response, JSON.stringify({ title: 'Repair terminal scrolling' }));
  await until(async () => (await read(first)).name === 'Repair terminal scrolling', 'generated title not discoverable');
  assert.equal((await read(first)).updatedAt, before.updatedAt, 'naming changed recency');
  await turn(first, 'Also check downward scrolling.'); await delay(200); assert.equal(titleRequests, 1);
  assert.equal((await read(first)).name, 'Repair terminal scrolling', 'later turn replaced generated name');
  await rpc.request('thread/unsubscribe', { threadId: first });
  await rpc.request('thread/resume', { threadId: first });
  await turn(first, 'Check scrolling after resuming the session.');
  await delay(200);
  assert.equal((await read(first)).name, 'Repair terminal scrolling', 'resume replaced generated name');

  const named = await start();
  await rpc.request('thread/name/set', { threadId: named, name: 'My chosen name' });
  await turn(named, 'Repair the session picker.'); await delay(200); assert.equal(titleRequests, 1);
  assert.equal((await read(named)).name, 'My chosen name');

  const race = await start();
  await turn(race, 'Fix queue handling in the composer.');
  await until(() => pending.length === 1, 'no race title request');
  await rpc.request('thread/name/set', { threadId: race, name: 'Keep this manual name' });
  const raceResponse = pending.shift(); assert(raceResponse);
  respond(raceResponse.response, JSON.stringify({ title: 'Generated queue title' }));
  await delay(300); assert.equal((await read(race)).name, 'Keep this manual name');

  const malformed = await start();
  await turn(malformed, 'Improve contrast in the context ledger.');
  await until(() => pending.length === 1, 'no malformed-control request');
  const malformedResponse = pending.shift(); assert(malformedResponse);
  respond(malformedResponse.response, '{"title":"[broken:reference]"}');
  await delay(300); assert(!(await read(malformed)).name?.includes('broken'));
  await turn(malformed, 'Keep the original colors.'); await delay(200); assert.equal(titleRequests, 3);
  console.log(JSON.stringify({ passed: true, checks: ['greeting waits for task', 'naming does not block turn completion', 'generated name appears in thread read', 'name preserves recency', 'one naming call per loaded session', 'manual names preserved', 'concurrent rename wins', 'invalid title rejected without repeated requests'] }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { rpc?.dispose(); server.close(); server.closeAllConnections(); });
