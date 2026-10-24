// A local stand-in for the OpenAI Responses API, for runtime tests in throwaway homes (no account). Its replies replay, in
// order, the responses of Masih's longest gpt-6.1-sol chat (numbers only, codex-rs/core/src/elpis_reasoning_cost.json):
// each reply carries reasoning items of the real encrypted lengths and reports the real reasoning tokens, and a later
// request is charged those same tokens for each reasoning item it sends back. Everything else is four bytes a token.
// The truth is what the provider reported, never the engine's estimate. `work N` in the user's message runs N
// exec_command steps before the answer; `slow` holds the first reply for a minute.
import http from 'node:http';
import fs from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';

const measured = JSON.parse(fs.readFileSync(new URL('../../../codex-rs/core/src/elpis_reasoning_cost.json', import.meta.url), 'utf8'));
const replies = measured.chats.reduce((longest, chat) => (chat.length > longest.length ? chat : longest));
const tok = text => Math.ceil(Buffer.byteLength(text ?? '') / 4);

/** Starts the stand-in; `state.last` is what the latest request really held: input, output and reasoning tokens. */
export async function model() {
  const state = { requests: [], compactions: 0, last: null }, charged = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }], models: [] })); return; }
      const request = JSON.parse(body || '{}');
      if (req.url.endsWith('/compact')) {
        state.compactions++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ output: [{ type: 'compaction', encrypted_content: 'g'.repeat(800) }] }));
        return;
      }
      const input = request.input ?? [];
      let reasoning = 0, other = tok(request.instructions) + tok(JSON.stringify(request.tools ?? []));
      for (const item of input) {
        if (item.type === 'reasoning') reasoning += charged.get((item.encrypted_content ?? '').split(':', 1)[0]) ?? 0;
        else if (item.type === 'message') other += (item.content ?? []).reduce((sum, part) => sum + tok(part.text), 0);
        else other += tok(JSON.stringify(item));
      }
      const lastUser = input.findLastIndex(item => item.type === 'message' && item.role === 'user');
      const asked = (input[lastUser]?.content ?? []).map(part => part.text ?? '').join(' ');
      const steps = Number(/work (\d+)/.exec(asked)?.[1] ?? 0);
      const done = input.slice(lastUser + 1).filter(item => item.type === 'function_call_output').length;
      const n = state.requests.push({ url: req.url, asked, reasoningItems: input.filter(item => item.type === 'reasoning').length });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: `resp_${n}` } });
      if (asked.includes('slow') && done === 0) await pause(60000);
      if (res.destroyed) return;
      // The n-th real reply: its reported reasoning tokens, split over its items by length, are what each item costs later.
      const [outReasoning, ...lengths] = replies[(n - 1) % replies.length], chars = lengths.reduce((sum, length) => sum + length, 0);
      lengths.forEach((length, index) => {
        const key = `r${n}.${index}`;
        charged.set(key, Math.round(outReasoning * length / chars));
        send('response.output_item.done', { item: { type: 'reasoning', id: `rs_${n}_${index}`, summary: [], encrypted_content: `${key}:`.padEnd(length, 'g') } });
      });
      const call = done < steps;
      const out = call
        ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd: 'true' }) }
        : { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: `reply ${n}` }] };
      send('response.output_item.done', { item: out });
      const outOther = tok(call ? out.name + out.arguments : out.content[0].text);
      state.last = { input: reasoning + other, output: outReasoning + outOther, reasoning: reasoning + outReasoning };
      send('response.completed', { response: { id: `resp_${n}`, usage: { input_tokens: reasoning + other, input_tokens_details: null, output_tokens: outReasoning + outOther, output_tokens_details: { reasoning_tokens: outReasoning }, total_tokens: reasoning + other + outReasoning + outOther } } });
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

