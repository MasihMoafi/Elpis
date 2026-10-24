import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DesktopClient } from './client.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'connection state did not recover'); await sleep(10); }
}

test('runtime connection recovers without replaying a write whose result is unknown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-reconnect-'));
  const socketPath = path.join(dir, 'runtime.sock');
  const { createServer } = await import('node:http');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0, starts = 0;
  wss.on('connection', socket => {
    connections++;
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      if (message.method === 'thread/start') { starts++; socket.close(); return; }
      const result = message.method === 'model/list' ? { data: [{ id: 'test-model', model: 'test-model' }], nextCursor: null } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  let client;
  t.after(async () => {
    client?.close(); for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  client = await DesktopClient.connect({ socketPath, reconnectDelayMs: 20 });
  await client.models();
  const events = [];
  client.on('event', event => { if (event.type === 'connection') events.push(event.data.connected); });
  await assert.rejects(client.createThread({ model: 'test-model', cwd: dir }), /connection closed|disconnected/i);
  await until(() => connections === 2 && client.connected);
  assert.deepEqual(events, [false, true]);
  assert.equal(starts, 1, 'a disconnected request must never be replayed');
  assert.equal((await client.models()).data[0].model, 'test-model');
  client.close();
  await sleep(100);
  assert.equal(connections, 2, 'closing the app must cancel reconnection');
});

test('read disconnect reports an interrupted read while writes retain unknown-delivery errors',async()=>{
  const {EventEmitter}=await import('node:events');
  const socket=new EventEmitter();socket.sent=[];socket.close=()=>{};
  socket.send=wire=>{const message=JSON.parse(wire);socket.sent.push(message);queueMicrotask(()=>{
    if(message.method==='model/list'&&socket.sent.length===1){socket.emit('close');return;}
    if(message.method==='model/list'){socket.emit('message',JSON.stringify({id:message.id,result:{data:[{model:'test-model'}]}}));return;}
    if(message.method==='thread/start')socket.emit('close');
  });};
  const reader=new DesktopClient(socket);try{await assert.rejects(reader.models(),error=>/closed while reading/.test(error.message)&&!/outcome.*unknown/.test(error.message));assert.equal(socket.sent.length,1);}finally{reader.close();}
  const writeSocket=new EventEmitter();writeSocket.sent=[];writeSocket.close=()=>{};
  writeSocket.send=wire=>{const message=JSON.parse(wire);writeSocket.sent.push(message);queueMicrotask(()=>{if(message.method==='config/read'){writeSocket.emit('message',JSON.stringify({id:message.id,result:{config:{},layers:[]}}));return;}if(message.method==='model/list')writeSocket.emit('message',JSON.stringify({id:message.id,result:{data:[{model:'test-model'}]}}));else if(message.method==='thread/start')writeSocket.emit('close');});};
  const writer=new DesktopClient(writeSocket);try{await writer.models();await assert.rejects(writer.createThread({model:'test-model'}),/outcome is unknown/);assert.equal(writeSocket.sent.filter(message=>message.method==='thread/start').length,1);}finally{writer.close();}
});

test('read timeout reports a retryable view read and never silently retries it',async()=>{
  const {EventEmitter}=await import('node:events');const socket=new EventEmitter();socket.sent=[];socket.close=()=>{};socket.send=wire=>socket.sent.push(JSON.parse(wire));
  const client=new DesktopClient(socket,{timeoutMs:20});try{await assert.rejects(client.models(),error=>/timed out while reading/.test(error.message)&&!/outcome.*unknown/.test(error.message));assert.equal(socket.sent.length,1);}finally{client.close();}
});

test('a runtime that is still starting, or missing, never holds the app: a background connection is ready at once and joins when the runtime arrives', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-late-runtime-'));
  const socketPath = path.join(dir, 'runtime.sock');
  const { createServer } = await import('node:http');
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.id) socket.send(JSON.stringify({ id: message.id, result: message.method === 'model/list' ? { data: [{ id: 'late-model', model: 'late-model' }], nextCursor: null } : {} }));
  }));
  let client, attempts = 0, runtimeUp = false;
  t.after(async () => { client?.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); if (runtimeUp) await new Promise(resolve => server.close(resolve)); });
  const beforeConnect = async () => { attempts++; if (!runtimeUp) throw new Error('Install Elpis before opening the app. The Elpis runtime executable could not be found.'); };
  const started = Date.now();
  client = await DesktopClient.connect({ socketPath, reconnectDelayMs: 20, beforeConnect, background: true });
  assert.ok(Date.now() - started < 1000, 'the app does not wait for the runtime');
  assert.equal(client.connected, false);
  await assert.rejects(client.models(), /disconnected/i);
  await until(() => attempts >= 2);
  assert.match(client.connectionError, /could not be found/, 'the reason stays available while it retries');
  const events = [];
  client.on('event', event => { if (event.type === 'connection') events.push(event.data.connected); });
  await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600); runtimeUp = true;
  await until(() => client.connected);
  assert.deepEqual(events, [true]);
  assert.equal(client.connectionError, null);
  assert.equal((await client.models()).data[0].model, 'late-model');
});
