import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopClient } from './client.mts';
import { rpcResult } from './client-wire.mts';
import type { ThreadResumeResponse } from '../../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeResponse.ts';
import type { ExperimentalFeature } from '../../../codex-rs/app-server-protocol/schema/typescript/v2/ExperimentalFeature.ts';
import type { ExternalAgentConfigMigrationItem } from '../../../codex-rs/app-server-protocol/schema/typescript/v2/ExternalAgentConfigMigrationItem.ts';

const CHAT = '00000000-0000-0000-0000-000000000001';
test('native nullable response fields preserve compatibility without accepting malformed fields', () => {
  const collaborationMode: ThreadResumeResponse['collaborationMode'] = null;
  assert.equal(rpcResult('thread/resume', { thread: { id: CHAT }, collaborationMode }).collaborationMode, null);
  const feature: Pick<ExperimentalFeature, 'name' | 'stage' | 'enabled' | 'displayName' | 'description'> = {
    name: 'multi_agent', stage: 'stable', enabled: true, displayName: null, description: null,
  };
  assert.equal(rpcResult('experimentalFeature/list', { data: [feature] }).data[0]?.displayName, null);
  assert.throws(() => rpcResult('experimentalFeature/list', { data: [{ ...feature, enabled: 'yes' }] }), /malformed/);
  const details: ExternalAgentConfigMigrationItem['details'] = null;
  assert.equal(rpcResult('externalAgentConfig/detect', { items: [{ itemType: 'config', details }] }).items[0]?.details, null);
});
test('desktop socket rejects malformed envelopes and typed results while valid traffic continues', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-wire-'));
  let result: unknown = {};
  const socket = Object.assign(new EventEmitter(), { close() {}, send(raw: string) {
    const request = JSON.parse(raw) as { id?: string };
    if (request.id) queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  } });
  const client = new DesktopClient(socket, { home, appHome: home });
  try {
    for (const value of [null, [], 1, 'text', { method: 4 }, { method: 'thread/name/updated', params: null }, { id: {} }]) {
      assert.doesNotThrow(() => socket.emit('message', JSON.stringify(value)));
    }
    for (result of [null, [], { thread: null }, { thread: { id: CHAT, cwd: 42 } },
      { thread: { id: CHAT, source: { subAgent: 42 } } },
      { thread: { id: CHAT, turns: [{ id: 'turn', items: [{ id: 'item', type: 'agentMessage', text: 42 }] }] } }]) {
      await assert.rejects(client.readThreadMetadata(CHAT), /malformed.*thread\/read/i);
    }
    result = { config: 'invalid' };
    await assert.rejects(client.sideRpc('config/read', {}), /malformed.*config\/read/i);
    result = { thread: { id: CHAT, cwd: '/project', path: null, source: 'cli', status: { type: 'idle' } } };
    assert.equal((await client.readThreadMetadata(CHAT)).id, CHAT);
    result = { thread: { id: CHAT, source: { subAgent: { thread_spawn: {} } } } };
    assert.equal((await client.readThreadMetadata(CHAT)).id, CHAT);
    result = {};
    await client.initialize();
    assert.equal(client.connected, true);
    const events: unknown[] = [];
    client.on('event', event => events.push(event));
    socket.emit('message', JSON.stringify({ method: 'thread/name/updated', params: { threadId: CHAT, threadName: 'Renamed' } }));
    assert.equal(events.length, 1);
  } finally { client.close(); rmSync(home, { recursive: true, force: true }); }
});
