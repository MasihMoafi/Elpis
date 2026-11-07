import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeLoveSpotEvents } from '../lib/love-spot-events.ts';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, bootstrap?: string) {
  const original = globalThis.EventSource, sources: FakeEventSource[] = [], lifecycle: string[] = [], stops: (() => void)[] = [];
  class FakeEventSource {
    declare url: string;
    declare closed: boolean;
    declare listener: ((event: MessageEvent<string>) => void) | undefined;
    declare onerror: ((event: Event) => void) | undefined;
    constructor(url: string) { this.url = url; this.closed = false; sources.push(this); lifecycle.push('open'); }
    set onmessage(listener: ((event: MessageEvent<string>) => void) | undefined) { this.listener = listener; if (bootstrap) { assert.ok(listener); listener(new MessageEvent<string>('message', { data: bootstrap })); } }
    get onmessage() { return this.listener; }
    close() { this.closed = true; lifecycle.push('close'); this.error(); }
    message(data: string) { this.onmessage?.(new MessageEvent<string>('message', { data })); }
    error() { this.onerror?.(new Event('error')); }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource });
  t.after(() => { stops.forEach(stop => stop()); Object.assign(globalThis, { EventSource: original }); });
  const listen = () => {
    const messages: string[] = [], errors: string[] = [];
    const stop = subscribeLoveSpotEvents(event => messages.push(event.data), () => errors.push('reconnecting'));
    stops.push(stop);
    return { messages, errors, stop };
  };
  const source = (index: number) => { const found = sources.at(index); assert.ok(found); return found; };
  return { sources, lifecycle, listen, source };
}

test('activity and editor share one live board connection, closing before replacement opens', t => {
  const f = fixture(t); f.listen(); f.listen();
  assert.equal(f.sources.filter(source => !source.closed).length, 1);
  assert.deepEqual(f.lifecycle, ['open', 'close', 'open']);
  assert.equal(f.source(-1).url, '/api/love-spot/events');
});

test('joining consumer is registered before bootstrap and deliberate close stays silent', t => {
  const f = fixture(t, 'current snapshot'), activity = f.listen(), editor = f.listen();
  assert.deepEqual(activity.messages, ['current snapshot', 'current snapshot']);
  assert.deepEqual(editor.messages, ['current snapshot']);
  assert.deepEqual(activity.errors, []); assert.deepEqual(editor.errors, []);
});

test('scene, tray, server errors and unreadable messages reach both consumers unchanged', t => {
  const f = fixture(t), activity = f.listen(), editor = f.listen();
  const messages = [
    JSON.stringify({ type: 'scene', revision: 'current', scene: { page: { session: 'new-page' }, elements: [] } }),
    JSON.stringify({ type: 'screenshots', screenshots: [{ id: 'private', name: 'partial.png', dataURL: 'data:image/png;base64,pixels' }] }),
    JSON.stringify({ type: 'error', message: 'Drawing unavailable' }),
    'not json',
  ];
  messages.forEach(message => f.source(-1).message(message));
  assert.deepEqual(activity.messages, messages); assert.deepEqual(editor.messages, messages);
});

test('a late editor receives fresh server replay, never an older cached page or tray', t => {
  const f = fixture(t), activity = f.listen();
  f.source(0).message('old page'); f.source(0).message('old tray');
  const editor = f.listen();
  assert.equal(f.source(0).closed, true, 'joining must request a fresh server bootstrap');
  assert.deepEqual(editor.messages, [], 'old cached bytes must not overwrite the editor GET baseline');
  const bootstrap = ['current page', 'current tray', 'current server error'];
  bootstrap.forEach(message => f.source(-1).message(message));
  assert.deepEqual(editor.messages, bootstrap);
  assert.deepEqual(activity.messages, ['old page', 'old tray', ...bootstrap]);
});

test('queued events from a replaced connection cannot roll back current subscribers', t => {
  const f = fixture(t), activity = f.listen(), retired = f.source(0), editor = f.listen();
  retired.message('stale page'); retired.error();
  assert.deepEqual(activity.messages, []); assert.deepEqual(editor.messages, []);
  assert.deepEqual(activity.errors, []); assert.deepEqual(editor.errors, []);
});

test('one consumer leaving keeps the remaining connection and notifications alive', t => {
  const f = fixture(t), activity = f.listen(), editor = f.listen(), source = f.source(-1);
  editor.stop(); source.message('next scene'); source.error();
  assert.equal(source.closed, false); assert.equal(f.sources.length, 2);
  assert.deepEqual(activity.messages, ['next scene']); assert.deepEqual(activity.errors, ['reconnecting']);
  assert.deepEqual(editor.messages, []); assert.deepEqual(editor.errors, []);
});

test('native reconnect reports errors to both consumers and resumes on the same source', t => {
  const f = fixture(t), activity = f.listen(), editor = f.listen(), source = f.source(-1);
  source.error(); source.message('reconnected scene'); source.message('reconnected tray');
  assert.deepEqual(activity.errors, ['reconnecting']); assert.deepEqual(editor.errors, ['reconnecting']);
  assert.deepEqual(activity.messages, ['reconnected scene', 'reconnected tray']);
  assert.deepEqual(editor.messages, activity.messages);
  assert.equal(f.source(-1), source); assert.equal(source.closed, false);
});

test('last unsubscribe closes once, and a later visit starts without stale state', t => {
  const f = fixture(t), activity = f.listen(), editor = f.listen();
  const previous = f.source(-1);
  activity.stop(); editor.stop(); editor.stop(); activity.stop();
  assert.equal(previous.closed, true); assert.deepEqual(f.lifecycle, ['open', 'close', 'open', 'close']);
  const reopened = f.listen();
  previous.message('old scene'); previous.error();
  assert.deepEqual(reopened.messages, []); assert.deepEqual(reopened.errors, []);
  f.source(-1).message('fresh scene'); assert.deepEqual(reopened.messages, ['fresh scene']);
});
