import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startDesktopServer } from './server.mjs';

test('only the split-session document permits same-origin framing; external embedding remains refused', async () => {
  const client = new EventEmitter(); client.close = () => {}; client.connected = true;
  const server = await startDesktopServer({ client });
  try {
    const origin = new URL(server.url).origin;
    const normal = await fetch(origin);
    assert.equal(normal.headers.get('x-frame-options'), 'DENY');
    const split = await fetch(`${origin}/?pane=1&session=chat-a`);
    assert.equal(split.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(split.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const hostile = await fetch(`${origin}/?pane=1`, { headers: { Origin: 'https://external.invalid' } });
    assert.equal(hostile.status, 403);
  } finally { await server.close(); }
});
