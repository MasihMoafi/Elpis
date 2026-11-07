import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { connectAppServer } from '../app-server-connection.mts';

test('app-server requests go to a registered handler or are declined', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let initializedResolve = () => {};
  const initialized = new Promise<void>(resolve => { initializedResolve = resolve; });
  const peerReady = new Promise<WebSocket>(resolve => server.once('connection', peer => {
    peer.on('message', data => {
      const message = JSON.parse(String(data)) as { id?: string; method?: string };
      if (message.method === 'initialize') peer.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'initialized') initializedResolve();
    });
    resolve(peer);
  }));
  const client = connectAppServer({ url: `ws://127.0.0.1:${address.port}` });
  t.after(async () => {
    client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const peer = await peerReady;
  await client.ready;
  await initialized;
  const observed: string[] = [];
  client.listeners.add(message => { if (message.method) observed.push(message.method); });
  client.requests.add(message => {
    if (message.method !== 'handled' || message.id === undefined) return false;
    client.respond(message.id, { decision: 'accept' });
    return true;
  });
  const request = async (id: string, method: string) => {
    const reply = once(peer, 'message');
    peer.send(JSON.stringify({ id, method, params: {} }));
    const [data] = await reply;
    return JSON.parse(String(data));
  };
  assert.deepEqual(await request('first', 'handled'), { id: 'first', result: { decision: 'accept' } });
  assert.deepEqual(await request('second', 'unhandled'), { id: 'second', result: { decision: 'decline' } });
  assert.deepEqual(observed, ['handled', 'unhandled']);
});
