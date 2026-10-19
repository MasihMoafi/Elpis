'use strict';
const http = require('node:http');
const { once } = require('node:events');

// This is a controlled Responses provider, not a substitute for Elpis.
// It records exactly what the real Elpis runtime sends to inference and emits fixed
// tool calls/conclusions. Live-model quality is a separate, explicitly labelled check.
// The runtime asks once per thread for a short session title (session_title.rs).
// Answer those requests here, outside the scripted turn actions and `requests`,
// so a test's queued replies and request counts cover only the conversation.
const isTitleRequest = request => Boolean(request.text?.format?.schema?.required?.includes('title'));
class Provider {
  constructor() { this.requests = []; this.titleRequests = []; this.actions = []; this.hanging = new Set(); }
  async start() {
    this.server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (isTitleRequest(request)) {
          this.titleRequests.push({ path: req.url, body: request });
          const item = { type: 'message', id: `title_${this.titleRequests.length}`, role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ title: 'Editor test session' }) }] };
          const id = `title_response_${this.titleRequests.length}`;
          const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } }];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
          return;
        }
        this.requests.push({ path: req.url, body: request });
        const action = this.actions.shift();
        if (!action) throw new Error('Unexpected provider request');
        if (action.hang) { this.hanging.add(res); res.on('close', () => this.hanging.delete(res)); return; }
        if (action.httpError) {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:action.httpError,type:'invalid_request_error'}}));return;}
        const item = typeof action === 'function' ? action(request, req.headers) : action;
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
        this.error ??= error;
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

module.exports = { Provider, message, call };
