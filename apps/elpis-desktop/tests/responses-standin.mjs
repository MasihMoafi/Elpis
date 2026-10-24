// A local stand-in for the OpenAI Responses API, for runtime tests in throwaway homes (no account). It charges what it is
// sent the way the provider does for Masih's gpt-6.1-sol chats: encrypted reasoning at one token per 15.6 characters
// (measured 24 Oct 2026 over 4,511 requests) and everything else at four bytes a token, and reports that as usage.
// `work N` in the user's message runs N exec_command steps before the answer; `slow` holds the first reply for a minute.
import http from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';

export const CHARS_PER_TOKEN = 15.6;
const REASONING_CHARS = 40000;
const tok = text => Math.ceil(Buffer.byteLength(text ?? '') / 4);

/** Starts the stand-in; `state.last` is what the latest request really held: input, output and reasoning tokens. */
export async function model() {
  const state = { requests: [], compactions: 0, last: null };
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
        if (item.type === 'reasoning') reasoning += Math.ceil((item.encrypted_content ?? '').length / CHARS_PER_TOKEN);
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
      const outReasoning = Math.ceil(REASONING_CHARS / CHARS_PER_TOKEN);
      send('response.output_item.done', { item: { type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: 'g'.repeat(REASONING_CHARS) } });
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

