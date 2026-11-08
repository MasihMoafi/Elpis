'use strict';
type FixtureControl = { capture: string; release?: string | null; failRead?: boolean; failLoad?: boolean; hold?: boolean };
type AdapterMessage = { id: number; method: string; params: { sessionId?: string; _meta?: { systemPrompt?: { append?: string } }; prompt: { text: string }[] }; message: { content: string } };
type Session = { instructions: string; turns: { text: string }[][] };
type Capture = { sessionId: string; text: string; instructions: string; prompt: { text: string }[]; turns: unknown[] };
type Socket = { once(event: 'open', listener: () => void): void; once(event: 'error', listener: (error: Error) => void): void; on(event: 'message', listener: (data: unknown) => void): void; send(data: string): void; close(): void };
type Turn = { status: string; error: { message: string } };
type Result = { thread: { id: string }; };
type WireMessage = { id: number; method?: string; params: unknown; result: Result; error?: { message: string } };
type Pending = { resolve(result: Result): void; reject(error: Error): void };

// Actual bridge + engine + deterministic local provider. No provider credentials or requests.
// Usage: node scripts/bridge-context.test.cjs /absolute/engine [absolute/bridge] [--gemini]
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { randomUUID, createHash }: typeof import('node:crypto') = require('node:crypto');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const lines = (receive: (message: AdapterMessage) => void) => require('node:readline').createInterface({ input: process.stdin }).on('line', (line: string) => receive(JSON.parse(line)));
const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n');
const control = (): FixtureControl => JSON.parse(fs.readFileSync(process.env.CONTEXT_FIXTURE_CONTROL as string, 'utf8'));

if (process.argv.includes('--engine-fixture')) {
  // Forward every real engine operation except the explicitly injected instruction-read fault.
  const engine = spawn(process.env.CONTEXT_FIXTURE_ENGINE as string, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  engine.stdout.pipe(process.stdout);
  lines(msg => {
    if (msg.method === 'thread/elpisInstructions/read' && control().failRead) {
      send({ id: msg.id, error: { code: -32603, message: 'Fixture instruction read failed' } });
    } else engine.stdin.write(JSON.stringify(msg) + '\n');
  });
  process.stdin.on('end', () => engine.stdin.end());
  process.on('SIGTERM', () => engine.kill());
  engine.on('exit', code => process.exit(code ?? 0));
} else if (process.argv.includes('--agy-fixture')) {
  if (process.argv.includes('models')) console.log('gemini-3.8-flash-medium\tGemini fixture');
  else {
    const at = process.argv.indexOf('--conversation');
    const sessionId = at < 0 ? randomUUID() : process.argv[at + 1];
    send({ event: 'init', conversation_id: sessionId });
    lines(async msg => {
      const ctl = control();
      fs.writeFileSync(ctl.capture, JSON.stringify({ sessionId, text: msg.message.content, pid: process.pid }));
      while (ctl.release && !fs.existsSync(ctl.release)) await pause(10);
      send({ event: 'result', result: { status: 'SUCCESS' } });
    });
  }
} else if (process.env.CONTEXT_FIXTURE_ADAPTER) {
  const sessions = new Map<string | undefined, Session>();
  const configOptions = [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'haiku', options: [{ value: 'haiku', name: 'Haiku' }] }];
  lines(async msg => {
    const p = msg.params ?? {};
    fs.appendFileSync(process.env.CONTEXT_FIXTURE_CALLS as string, JSON.stringify(msg) + '\n');
    let result: Record<string, unknown> = { configOptions };
    if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (msg.method === 'session/new' || msg.method === 'session/load') {
      if (msg.method === 'session/load' && control().failLoad) {
        send({ id: msg.id, error: { code: -32603, message: 'Fixture session reload failed' } }); return;
      }
      const sessionId = p.sessionId ?? randomUUID();
      const prior = sessions.get(sessionId);
      sessions.set(sessionId, { instructions: p._meta?.systemPrompt?.append ?? '', turns: prior?.turns ?? [] });
      result = { sessionId, configOptions };
    }
    if (msg.method === 'session/prompt') {
      const ctl = control(), session = sessions.get(p.sessionId) as Session;
      fs.writeFileSync(ctl.capture, JSON.stringify({ sessionId: p.sessionId, instructions: session.instructions, prompt: p.prompt, turns: session.turns }));
      while (ctl.release && !fs.existsSync(ctl.release)) await pause(10);
      session.turns.push(p.prompt);
      send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture context answer.' } } } });
      result = { stopReason: 'end_turn' };
    }
    if (msg.id !== undefined) send({ id: msg.id, result });
  });
} else main().catch((error: Error) => { console.error(error.stack); process.exitCode = 1; });

async function main() {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const { EventEmitter }: typeof import('node:events') = require('node:events');
  const WebSocket: new (address: string) => Socket = require('../tools/elpis-claude/node_modules/ws');
  const enginePath = process.argv[2];
  assert(enginePath && path.isAbsolute(enginePath), 'provide an absolute engine path');
  const bridgePath = process.argv[3]?.startsWith('--') ? undefined : process.argv[3];
  const gemini = process.argv.includes('--gemini');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'elpis-bridge-context-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work');
  const rules = path.join(home, 'skills/dev'), memory = path.join(home, 'memories/MEMORY.md');
  fs.mkdirSync(rules, { recursive: true }); fs.mkdirSync(path.dirname(memory)); fs.mkdirSync(cwd);
  const rule = path.join(rules, 'fixture.md'), custom = path.join(cwd, 'fixture-context.md');
  fs.writeFileSync(rule, 'ADMITTED_RULE_ALPHA'); fs.writeFileSync(memory, 'ADMITTED_MEMORY_ALPHA'); fs.writeFileSync(custom, 'ADMITTED_FILE_ALPHA');
  const stateDir = path.join(home, 'context/workspaces', `work-${createHash('sha256').update(cwd).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const admission = path.join(stateDir, 'admission.toml');
  const admit = (included = true) => fs.writeFileSync(admission, `memory=${included}\nproject_rules=${included}\n[dev_sources]\n"fixture.md"=${included}\n[custom_sources]\n${JSON.stringify(custom)}=${included}\n`);
  admit();
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-5.5"\n[features]\nsubagents=false\n');
  const controlPath = path.join(root, 'control.json'), callsPath = path.join(root, 'calls.jsonl');
  fs.writeFileSync(controlPath, '{}'); fs.writeFileSync(callsPath, '');
  const engineWrapper = path.join(root, 'engine'), agyWrapper = path.join(root, 'agy');
  for (const [file, mode] of [[engineWrapper, '--engine-fixture'], [agyWrapper, '--agy-fixture']] as const) {
    fs.writeFileSync(file, `#!${process.execPath}\nprocess.argv.push(${JSON.stringify(mode)}); require(${JSON.stringify(__filename)});\n`, { mode: 0o755 });
  }
  const log = path.join(root, 'bridge.log');
  const bridge = spawn(process.execPath, [bridgePath ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
    cwd, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
      ELPIS_ENGINE_BIN: engineWrapper, CONTEXT_FIXTURE_ENGINE: enginePath, CONTEXT_FIXTURE_CONTROL: controlPath,
      CONTEXT_FIXTURE_ADAPTER: '1', CONTEXT_FIXTURE_CALLS: callsPath, ACP_ADAPTER: __filename,
      ...(gemini ? { AGY_BIN: agyWrapper } : { ELPIS_NO_AGY: '1' }), ACP_BRIDGE_NO_AGENTS: '1', PORT: '0',
      ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: path.join(home, 'sessions.json') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '', ws: Socket | undefined;
  bridge.stderr.on('data', data => { stderr += data; });
  const messages: WireMessage[] = [], checks: string[] = [];
  const waitFor = async (condition: () => unknown, label: string) => {
    const end = Date.now() + 20000;
    while (!condition()) { assert(Date.now() < end, `${label} timed out: ${stderr}`); await pause(15); }
  };
  const pass = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
  try {
    await waitFor(() => fs.existsSync(log) && /LISTENING (\d+)/.test(fs.readFileSync(log, 'utf8')), 'bridge start');
    const socket = new WebSocket(`ws://127.0.0.1:${(fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/) as RegExpMatchArray)[1]}`); ws = socket;
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const pending = new Map<number, Pending>(), events = new EventEmitter(); let seq = 0;
    socket.on('message', data => {
      const msg: WireMessage = JSON.parse(String(data)); messages.push(msg);
      if (msg.method) events.emit(msg.method, msg.params);
      else { const waiter = pending.get(msg.id); pending.delete(msg.id); if (waiter) msg.error ? waiter.reject(Error(msg.error.message)) : waiter.resolve(msg.result); }
    });
    const request = (method: string, params: object) => new Promise<Result>((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const completion = (threadId: string) => new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => { events.off('turn/completed', receive); reject(Error('turn completion timed out')); }, 20000);
      function receive(p: { threadId: string; turn: Turn }) { if (p.threadId !== threadId) return; clearTimeout(timer); events.off('turn/completed', receive); resolve(p.turn); }
      events.on('turn/completed', receive);
    });
    await request('initialize', { clientInfo: { name: 'bridge_context_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = await request('thread/start', { cwd, model: gemini ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku', approvalPolicy: 'never', permissions: ':danger-full-access' });
    let turnSeq = 0;
    async function start(options: Partial<FixtureControl> = {}) {
      const capture = path.join(root, `capture-${++turnSeq}.json`), release = options.hold ? path.join(root, `release-${turnSeq}`) : null;
      fs.writeFileSync(controlPath, JSON.stringify({ capture, release, ...options }));
      const done = completion(thread.id);
      await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Context fixture turn ${turnSeq}.` }] });
      if (!options.failRead) await waitFor(() => fs.existsSync(capture), 'provider prompt');
      return { done, capture, release: () => fs.writeFileSync(release as string, 'release'), value: () => JSON.parse(fs.readFileSync(capture, 'utf8')) };
    }
    async function run(options?: Partial<FixtureControl>) { const turn = await start(options); assert.equal((await turn.done).status, 'completed'); return turn.value(); }
    const text = (value: Capture) => gemini ? value.text : value.instructions;
    const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as AdapterMessage);
    const setups = () => calls().filter(c => ['session/new', 'session/load'].includes(c.method)).length;
    const initial = await run();
    for (const marker of ['RULE', 'MEMORY', 'FILE']) assert(text(initial).includes(`ADMITTED_${marker}_ALPHA`), `${marker} initially admitted`);
    pass('initial admitted rules, memory and custom file reach actual provider input');
    async function readFailure() {
      const beforeFailure = setups(), failed = await start({ failRead: true });
      const failedTurn = await failed.done;
      assert.equal(failedTurn.status, 'failed', 'instruction read failure fails the turn');
      assert.match(failedTurn.error.message, /instruction read failed/i);
      assert(!fs.existsSync(failed.capture), 'failed read never prompts the provider');
      assert.equal(setups(), beforeFailure, 'failed read must not replace the last good session');
      pass('instruction RPC failure is visible and never sends empty or stale context');
    }
    if (process.argv.includes('--read-failure-only')) { await readFailure(); return; }
    const count = setups(), unchanged = await run();
    assert.equal(unchanged.sessionId, initial.sessionId);
    if (gemini) assert(!unchanged.text.includes('<elpis_instructions>'), 'unchanged context is not repeated');
    else assert.equal(setups(), count, 'unchanged instructions reuse the native session');
    pass('unchanged instructions reuse the session');
    const held = await start({ hold: true }), snapshot = fs.readFileSync(held.capture, 'utf8');
    fs.writeFileSync(rule, 'ADMITTED_RULE_BETA'); fs.writeFileSync(memory, 'ADMITTED_MEMORY_BETA'); fs.writeFileSync(custom, 'ADMITTED_FILE_BETA');
    await request('thread/elpisInstructions/read', { threadId: thread.id });
    assert.equal(fs.readFileSync(held.capture, 'utf8'), snapshot, 'an in-flight request keeps its captured instructions');
    if (!gemini) assert.equal(setups(), count);
    held.release(); assert.equal((await held.done).status, 'completed');
    pass('edits leave an in-flight provider request unchanged');
    const changed = await run();
    for (const marker of ['RULE', 'MEMORY', 'FILE']) assert(text(changed).includes(`ADMITTED_${marker}_BETA`), `${marker} edit must reach the next provider turn`);
    assert(!text(changed).includes('_ALPHA'));
    assert.equal(changed.sessionId, initial.sessionId, 'native conversation is preserved');
    if (!gemini) assert.equal(changed.turns.length, 3, 'prior native turns survive reload');
    pass('changed admitted context reaches next turn and retains conversation');
    admit(false);
    const withdrawn = await run();
    assert(!text(withdrawn).includes('ADMITTED_'), 'withdrawn context must not be sent again');
    if (gemini) assert.match(withdrawn.text, /replace|supersede/i, 'Gemini receives an explicit withdrawal of earlier instructions');
    else assert.equal(withdrawn.instructions, '');
    assert.equal(withdrawn.sessionId, initial.sessionId);
    pass('withdrawal replaces previously admitted instructions');
    await readFailure();
    admit();
    const recovered = await run();
    assert(text(recovered).includes('ADMITTED_MEMORY_BETA'));
    assert.equal(recovered.sessionId, initial.sessionId);
    pass('retry after read failure recovers the same conversation');
    if (!gemini) {
      fs.writeFileSync(rule, 'ADMITTED_RULE_GAMMA');
      const fallback = await run({ failLoad: true });
      assert.notEqual(fallback.sessionId, initial.sessionId);
      assert(fallback.instructions.includes('ADMITTED_RULE_GAMMA'));
      assert(fallback.prompt[0].text.includes('Context fixture turn 1.'));
      pass('failed native reload starts fresh with current instructions and preserved transcript');
    }
    const projectRules = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(projectRules, 'PROJECT_RULE_LIVE_ALPHA');
    assert(text(await run()).includes('PROJECT_RULE_LIVE_ALPHA'), 'new project instructions reach the next turn');
    fs.writeFileSync(projectRules, 'PROJECT_RULE_LIVE_BETA');
    const editedRules = text(await run());
    assert(editedRules.includes('PROJECT_RULE_LIVE_BETA'));
    assert(!editedRules.includes('PROJECT_RULE_LIVE_ALPHA'));
    admit(false);
    assert(!text(await run()).includes('PROJECT_RULE_LIVE_'), 'withdrawn project instructions leave the current request');
    admit();
    assert(text(await run()).includes('PROJECT_RULE_LIVE_BETA'), 're-admission uses the current project file');
    fs.unlinkSync(projectRules);
    assert(!text(await run()).includes('PROJECT_RULE_LIVE_'), 'deleted project instructions leave the current request');
    pass('project instruction discovery, edits, withdrawal, re-admission and deletion reach live provider turns');
  } finally {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ checks, messages, stderr }, null, 2));
    console.log(`Evidence: ${root}`);
    ws?.close();
    if (bridge.exitCode === null && bridge.signalCode === null) {
      const stopped = new Promise<void>(resolve => bridge.once('exit', () => resolve())); bridge.kill(); await stopped;
    }
  }
}
