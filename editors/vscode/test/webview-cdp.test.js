'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WebviewDOM } = require('./webview-cdp');

test('evaluation continues in a live context after a webview context is destroyed', async () => {
  const dom = new WebviewDOM();
  dom.contexts = new Set([1, 2]);
  dom.send = async (_method, { contextId }) => {
    if (contextId === 1) throw new Error('Cannot find context with specified id');
    return { result: { value: 'live reply' } };
  };
  assert.equal(await dom.evaluate('d.body.textContent'), 'live reply');
  assert.deepEqual([...dom.contexts], [2]);
});

test('evaluation preserves unexpected debugger failures', async () => {
  const dom = new WebviewDOM();
  dom.contexts = new Set([1]);
  dom.send = async () => { throw new Error('Debugger disconnected'); };
  await assert.rejects(dom.evaluate('d.body.textContent'), /Debugger disconnected/);
});
