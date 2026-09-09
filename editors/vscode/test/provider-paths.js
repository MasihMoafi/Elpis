'use strict';
// Offline end-to-end: real Elpis, real provider adapters, synthetic HTTP responses.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { Session } = require('../src/session');
const { providers, runtimeOptions } = require('../src/providers');
const runtime = process.env.ELPIS_EDITOR_TEST_RUNTIME;
if (!runtime) throw new Error('Set ELPIS_EDITOR_TEST_RUNTIME to an Elpis-built app-server.');
const marker = 'PROVIDER_TOOL_ONLY_734129';
function event(res, type, data) { res.write(`${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`); }
function respond(res, provider, tool) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (provider === 'anthropic') {
    event(res, 'message_start', { type: 'message_start', message: { id: 'msg1', role: 'assistant', model: 'test-model', usage: { input_tokens: 10, output_tokens: 0 } } });
    event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call1', name: 'editor_read', input: {} } : { type: 'text', text: '' } });
    event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"uri":"file:///synthetic.ts"}' } : { type: 'text_delta', text: marker } });
    event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
    event(res, 'message_stop', { type: 'message_stop' });
  } else if (provider === 'google-gemini') {
    event(res, '', { responseId: 'gem1', candidates: [{ content: { role: 'model', parts: [tool ? { thoughtSignature: 'opaque-test-signature', functionCall: { id: 'call1', name: 'editor_read', args: { uri: 'file:///synthetic.ts' } } } : { text: marker }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
    event(res, '', { responseId: 'gem1', candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
  } else if (provider === 'openrouter') {
    event(res, '', { id: 'chat1', choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'editor_read', arguments: '{"uri":"file:///synthetic.ts"}' } }] } : { content: marker }, finish_reason: null }] });
    event(res, '', { id: 'chat1', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
  } else {
    const output = tool ? { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'editor_read', arguments: '{"uri":"file:///synthetic.ts"}' } : { type: 'message', id: 'msg1', role: 'assistant', content: [{ type: 'output_text', text: marker }] };
    event(res, 'response.created', { type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
    if (!tool) {
      event(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...output, content: [] } });
      event(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg1', output_index: 0, content_index: 0, delta: marker });
    }
    event(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: output });
    event(res, 'response.completed', { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [output], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  }
  res.end();
}
async function run(provider, disabled, data) {
  const requests = []; let serverError;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw); requests.push({ path: req.url, body });
      if (requests.length > 2) throw new Error('Unexpected extra inference request');
      if (requests.length === 2) assert.equal(JSON.stringify(body).includes(marker), !disabled, 'tool fact must arrive only when bridge enabled');
      if (requests.length === 2 && provider.id === 'google-gemini') {
        const call = body.contents.flatMap(c => c.parts || []).find(p => p.functionCall);
        assert.equal(call?.thoughtSignature, 'opaque-test-signature', 'Gemini tool signature must survive the real runtime history');
      }
      const expectedPath = provider.id === 'anthropic' ? '/messages' : provider.id === 'google-gemini' ? ':streamGenerateContent' : provider.id === 'openrouter' ? '/chat/completions' : '/responses';
      assert(req.url.includes(expectedPath));
      const header = provider.id === 'anthropic' ? 'x-api-key' : provider.id === 'google-gemini' ? 'x-goog-api-key' : 'authorization';
      assert(String(req.headers[header]).includes('synthetic-key'), 'selected provider authentication header missing');
      respond(res, provider.id, requests.length === 1);
    } catch (error) { serverError = error; res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = path.join(data, provider.id + (disabled ? '-disabled' : ''));
  await fs.mkdir(home, { recursive: true });
  const wire = provider.id === 'anthropic' ? 'anthropic_messages' : provider.id === 'google-gemini' ? 'gemini_generate_content' : provider.id === 'openrouter' ? 'chat' : 'responses';
  await fs.writeFile(path.join(home, 'config.toml'), `model = "test-model"\nmodel_context_window = 128000\nweb_search = "disabled"\n[features]\nmulti_agent = false\n[model_providers.fixture]\nname = "${provider.id}"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "${wire}"\nenv_key = "${provider.key}"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  let calls = 0;
  const bridge = { epoch: 0, cancel() { this.epoch++; }, async execute(name) { assert.equal(name, 'editor_read'); calls++; if (disabled) throw new Error('Editor bridge disabled'); return { text: marker }; } };
  // Built-in IDs cannot be redirected. This custom fixture exercises the same wire adapter offline.
  const session = new Session(home, bridge, { ...runtimeOptions({ executable: runtime, home, provider: provider.id, model: 'test-model' }, 'synthetic-key'), provider: 'fixture' });
  let visible = ''; session.on('delta', text => visible += text);
  const statuses = []; session.on('status', text => statuses.push(text));
  let timer;
  try {
    const completed = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${statuses.join('; ')}`)), 30000); session.once('completed', resolve); });
    const [turn] = await Promise.all([completed, session.send('Read the editor document and report its fact.')]);
    if (serverError) throw serverError;
    assert.equal(turn.status, 'completed', JSON.stringify(turn));
    assert.equal(calls, 1); assert.equal(requests.length, 2); assert.equal(visible, marker);
    await fs.writeFile(path.join(home, 'requests.json'), JSON.stringify(requests, null, 2));
    return { provider: provider.id, disabled, calls, requests: requests.length, completed: true };
  } finally { await fs.writeFile(path.join(home, 'status.json'), JSON.stringify({calls, statuses}, null, 2)); await fs.writeFile(path.join(home, 'requests.json'), JSON.stringify(requests, null, 2)); clearTimeout(timer); session.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => {
  const data = path.resolve(__dirname, '../.test-data', `providers-${Date.now()}`); await fs.mkdir(data, { recursive: true });
  const results = [];
  try { for (const provider of providers.filter(p => p.id && (!process.argv[2] || p.id === process.argv[2]))) for (const disabled of [false, true]) { const result = await run(provider, disabled, data); results.push(result); console.log(JSON.stringify(result)); } }
  finally { await fs.writeFile(path.join(data, 'results.json'), JSON.stringify(results, null, 2)); console.log(data); }
})().catch(error => { console.error(error); process.exitCode = 1; });
