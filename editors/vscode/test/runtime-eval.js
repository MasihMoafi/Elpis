'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// This is a controlled Responses provider, not a substitute for the editor or Elpis.
// It records exactly what the real Elpis runtime sends to inference and emits fixed
// tool calls/conclusions. Live-model quality is a separate, explicitly labelled check.
class Provider {
  constructor() { this.requests = []; this.actions = []; this.hanging = new Set(); }
  async start() {
    this.server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        this.requests.push({ path: req.url, body: request });
        const action = this.actions.shift();
        if (!action) throw new Error('Unexpected provider request');
        if (action.hang) { this.hanging.add(res); res.on('close', () => this.hanging.delete(res)); return; }
        if (action.httpError) {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:action.httpError,type:'invalid_request_error'}}));return;}
        const item = typeof action === 'function' ? action(request) : action;
        const id = `response_${this.requests.length}`;
        const events = [{ type: 'response.created', response: { id } }];
        if (item.type === 'message') {
          events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
          events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
        }
        events.push({ type: 'response.output_item.done', output_index: 0, item });
        events.push({ type: 'response.completed', response: { id, usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 } } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } catch (error) {
        this.error = error;
        res.writeHead(500); res.end(error.message);
      }
    });
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}/v1`;
  }
  close() { for (const response of this.hanging) response.destroy(); this.server.closeAllConnections(); this.server.close(); }
}
const message = text => ({ type: 'message', id: `msg_${Date.now()}`, role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
function waitTurn(session, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Runtime turn did not complete')); }, timeout);
    const completed = turn => { cleanup(); turn.status === 'failed' ? reject(new Error(JSON.stringify(turn.error))) : resolve(turn); };
    const disconnected = text => { cleanup(); reject(new Error(text)); };
    function cleanup() { clearTimeout(timer); session.off('completed', completed); session.off('disconnected', disconnected); }
    session.on('completed', completed); session.on('disconnected', disconnected);
  });
}
async function turn(session, prompt) {
  const done = waitTurn(session);
  // Attach error handling before send so a fast failure is never an unhandled rejection.
  const pair = Promise.all([done, session.send(prompt)]);
  return (await pair)[0];
}

async function runtimeEvaluation({ vscode, root, bridge, document, sentinel, evidence, eventually, EditorBridge, Session }) {
  const provider = new Provider();
  await provider.start();
  const data = process.env.ELPIS_EDITOR_TEST_DATA;
  const home = path.join(data, 'runtime-home');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "editor_eval"\nmodel_context_window = 128000\n[model_providers.editor_eval]\nname = "Deterministic editor acceptance provider"\nbase_url = ${JSON.stringify(provider.url)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const options = { executable: process.env.ELPIS_EDITOR_TEST_RUNTIME, transport: { env: { ...process.env, CODEX_HOME: home, ELPIS_HOME: home } } };
  const sessions = [];
  const customInstruction='PERSONALIZATION_SENTINEL: Explain changes before suggesting follow-up work.';
  const configPath=path.join(home,'config.toml');
  await fs.writeFile(configPath,'developer_instructions='+JSON.stringify(customInstruction)+'\n'+await fs.readFile(configPath,'utf8'));
  const create = (b = bridge, folder = root) => { const s = new Session(folder.fsPath, b, options); sessions.push(s); return s; };
  const record = (name, detail) => evidence.results.push({ name, passed: true, ...detail });
  const uri = document.uri.toString();
  try {
    // The padding is only in the unsaved document; all modes see the same fixture.
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), '// ordinary unrelated source comment\n'.repeat(500)));
    const session = create();
    const statuses = []; session.on('status', text => statuses.push(text));
    let transcript = ''; session.on('delta', text => { transcript += text; });
    provider.actions.push(call('read_live', 'editor_read', { uri }), request => {
      assert(JSON.stringify(request.input).includes(sentinel), 'actual inference request must contain only-in-editor sentinel');
      assert(JSON.stringify(request).includes(customInstruction),'configured personalization must reach inference alongside IDE instructions');
      return call('diagnostics_live', 'editor_diagnostics', { uri });
    }, request => {
      assert(JSON.stringify(request.input).includes("not assignable to type"));
      return call('definition_live', 'editor_definition', { uri, line: 1, character: 24 });
    }, () => call('references_live', 'editor_references', { uri, line: 0, character: 17 }), request => {
      const outputs = request.input.filter(item => item.type === 'function_call_output');
      assert(outputs.some(item => item.call_id === 'definition_live'));
      assert(outputs.some(item => item.call_id === 'references_live'));
      return message('I read the live editor document.');
    });
    await turn(session, 'Read the live editor document. Retain its unique unsaved value for the next question.');
    assert.match(transcript, /live editor document/);
    const raw = JSON.stringify(provider.requests.at(-1).body.input);
    assert(raw.includes(sentinel));
    record('real Elpis dynamic-tool roundtrip and streamed chat (controlled provider)', { identity: session.identity, rawInputBytes: Buffer.byteLength(raw) });

    provider.actions.push(message('Ready for your next question.'));
    await turn(session, 'Keep the previously read fact available.');
    const disabledCompression = JSON.stringify(provider.requests.at(-1).body.input);
    assert(disabledCompression.includes(sentinel));
    assert(!disabledCompression.includes('[ELPIS CONTEXT UPDATE]'));

    await session.prune();
    const firstRequest=provider.requests.length;
    provider.actions.push(call('read_smart','editor_read',{uri}),request=>{
      assert(JSON.stringify(request).includes('You are Elpis Smart Prune'),'request must be the optimizer');
      assert(JSON.stringify(request).includes(sentinel),'optimizer receives actual unsaved editor output');
      return message(JSON.stringify({items:[{call_id:'read_smart',decision:'compact',content:`${sentinel}; greet returns string and result is incorrectly declared number.`}]}));
    },request=>{
      const before=provider.requests[firstRequest].body;
      assert.deepEqual(request.input.slice(0,before.input.length),before.input,'Smart Pruning leaves earlier model-visible prefix unchanged');
      assert.deepEqual(request.tools,before.tools,'cached tool definitions remain unchanged');
      assert.equal(request.instructions,before.instructions,'cached instructions remain unchanged');
      const fresh=request.input.find(item=>item.call_id==='read_smart'&&item.type==='function_call_output');
      const text=JSON.stringify(fresh);assert(text.includes(sentinel));assert(!text.includes('ordinary unrelated source comment'));
      assert.throws(()=>assert(text.replace(sentinel,'').includes(sentinel)),assert.AssertionError,'retention oracle detects damaged output');
      return message('Fresh editor fact retained.');
    });
    await turn(session,'Read the live editor document again using editor_read.');
    assert(session.ledger().saved>0);assert(session.ledger().optimizerTokens>0);
    record('Smart Pruning compresses fresh real editor output before inference while preserving the prior prefix and reporting optimizer overhead');
    provider.actions.push(call('read_malformed','editor_read',{uri}),message('invalid manifest'),request=>{
      const fresh=request.input.find(item=>item.call_id==='read_malformed'&&item.type==='function_call_output');
      assert(JSON.stringify(fresh).includes(sentinel));assert(JSON.stringify(fresh).includes('ordinary unrelated source comment'));
      return message('Original editor output retained after optimizer failure.');
    });
    await turn(session,'Read the live editor document once more.');
    await session.setSmartPruning(false);
    record('Malformed Smart Pruning response retains original editor output and required facts');
    let done;

    const disabledBridge = new EditorBridge(vscode, root, { enabled: () => false });
    const disabled = create(disabledBridge);
    provider.actions.push(call('read_disabled', 'editor_read', { uri }), request => {
      const input = JSON.stringify(request.input);
      assert(!input.includes(sentinel)); assert(input.includes('Editor access is disabled'));
      return message('Editor access is disabled; I cannot see unsaved text.');
    });
    await turn(disabled, 'Read the live editor document.');
    disabledBridge.dispose();
    record('fresh real-runtime conversation with editor access disabled cannot receive sentinel');

    provider.actions.push({ hang: true });
    await session.send('Wait for cancellation.');
    await eventually(() => provider.hanging.size, 'provider sees cancellable request');
    done = waitTurn(session); await Promise.all([done, session.cancel()]);
    provider.actions.push(message('Recovered after cancellation.'));
    await turn(session, 'Can we continue?');
    record('real runtime cancellation permits another turn');

    const previousThread = session.threadId;
    session.rpc.child.kill('SIGKILL');
    await eventually(() => session.rpc.closed, 'runtime disconnect');
    assert(statuses.some(text => text.includes('disconnected')));
    provider.actions.push(message('Reconnected in a new conversation.'));
    await turn(session, 'Reconnect.');
    assert.notEqual(session.threadId, previousThread);
    record('runtime disconnect is visible and reconnect starts an isolated thread');

    const otherPath = path.join(data, 'other-worktree'); await fs.mkdir(otherPath, { recursive: true });
    await fs.writeFile(path.join(otherPath, 'only-here.txt'), 'SECOND_WORKTREE_DISK_FACT');
    const otherRoot = vscode.Uri.file(otherPath);
    const otherBridge = new EditorBridge(vscode, otherRoot, { enabled: () => true });
    const other = create(otherBridge, otherRoot);
    provider.actions.push(call('cross_workspace', 'editor_read', { uri }), request => {
      const input = JSON.stringify(request.input);
      assert(!input.includes(sentinel)); assert(input.includes('outside this conversation workspace'));
      return message('That document belongs to another workspace.');
    });
    await turn(other, 'Read the requested document.');
    assert.notEqual(other.threadId, session.threadId);
    otherBridge.dispose();
    record('independent workspace sessions have distinct threads and reject cross-worktree reads', { firstThread: session.threadId, secondThread: other.threadId, limitation: 'Two Session instances in one real extension host; separate-window UI acceptance remains manual.' });
    if (provider.error) throw provider.error;
  } finally {
    for (const session of sessions) session.dispose();
    provider.close();
    await fs.writeFile(path.join(data, 'provider-requests.json'), JSON.stringify(provider.requests, null, 2));
    evidence.runtime = { provider: 'Controlled local Responses provider; real Elpis app-server, VS Code editor and TypeScript service', requestCount: provider.requests.length, captures: 'provider-requests.json' };
  }
}
module.exports = { runtimeEvaluation, Provider, message, call };
