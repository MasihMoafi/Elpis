import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mts';

type SentRequest = {
  id?: number;
  method: string;
  params: {
    forceReload?: boolean;
    expectedVersion?: string;
    edits: Array<{ keyPath: string; value: Array<{ path: string; enabled: boolean }>; mergeStrategy: string }>;
  };
};

const MINE = '/skills/mine/SKILL.md', OTHER = '/skills/other/SKILL.md';

/** An engine with two listed skills and a config that already switches OTHER off. */
function setup(t: TestContext) {
  const root = path.join(os.tmpdir(), `skill-switch-${randomUUID()}`);
  let entries = [{ path: OTHER, enabled: false }];
  const socket = Object.assign(new EventEmitter(), {
    sent: [] as SentRequest[],
    close: (): void => {},
    send: (raw: string): void => {
      const request = JSON.parse(raw) as SentRequest; socket.sent.push(request);
      if (request.id === undefined) return;
      const skill = (file: string, name: string) => ({ name, path: file, description: name, scope: 'user', enabled: !entries.some(entry => entry.path === file && entry.enabled === false) });
      let result: Record<string, unknown> = {};
      if (request.method === 'skills/list') result = { data: [{ cwd: '/', skills: [skill(MINE, 'mine'), skill(OTHER, 'other')], errors: [] }] };
      else if (request.method === 'config/read') result = { config: { skills: { config: entries } }, origins: {}, layers: [{ name: { type: 'user', file: '/home/config.toml' }, version: 'v1' }] };
      else if (request.method === 'config/batchWrite') entries = request.params.edits[0]!.value;
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
    }
  });
  const client = new DesktopClient(socket, { archiveDirectory: path.join(root, 'archives'), rewindHome: path.join(root, 'rewind'), spawnLinksFile: path.join(root, 'links.json'),
    githubConnector: { snapshot: async () => ({ name: 'GitHub', transport: 'gh', enabled: false }), instructions: async () => null }, workflowOptions: { stateDir: path.join(root, 'workflows') } });
  t.after(() => client.close());
  return { client, socket };
}
const enabled = (snapshot: { skills: { data: Array<{ name: string; enabled: boolean }> } }) => Object.fromEntries(snapshot.skills.data.map(skill => [skill.name, skill.enabled]));

// 22 Oct: "I can't turn skills on or off!": the engine's own skills/config/write answered and saved nothing.
test('a skill is switched through the config, keeping the other entries, and the list shows the result', async t => {
  const f = setup(t);
  const off = await f.client.setSkill({ path: MINE, enabled: false }) as { skills: { data: Array<{ name: string; enabled: boolean }> } };
  assert.deepEqual(enabled(off), { mine: false, other: false });
  const written = f.socket.sent.findLast(request => request.method === 'config/batchWrite')!.params;
  assert.equal(written.expectedVersion, 'v1');
  assert.deepEqual(written.edits, [{ keyPath: 'skills.config', value: [{ path: OTHER, enabled: false }, { path: MINE, enabled: false }], mergeStrategy: 'replace' }]);
  const back = await f.client.setSkill({ path: MINE, enabled: true }) as { skills: { data: Array<{ name: string; enabled: boolean }> } };
  assert.deepEqual(enabled(back), { mine: true, other: false }, 'turning it on replaces its entry and leaves the other skill alone');
  assert.equal(f.socket.sent.some(request => request.method === 'skills/config/write'), false, 'the engine call that saves nothing is not used');
  await assert.rejects(f.client.setSkill({ path: '/skills/nowhere/SKILL.md', enabled: true }), /not listed/);
});

// 22 Oct: "fix the slow update when I turn on and off skills": a switch read the whole Settings page and reloaded every skill twice.
test('a skill switch asks for little: one reload of the skills, none of the Settings page', async t => {
  const f = setup(t);
  await f.client.setSkill({ path: MINE, enabled: false });
  const methods = f.socket.sent.map(request => request.method);
  assert.equal(f.socket.sent.filter(request => request.method === 'skills/list' && request.params.forceReload).length, 1, 'the skills are reloaded once, for the answer');
  for (const method of ['experimentalFeature/list', 'configRequirements/read', 'pruner/read']) assert.equal(methods.includes(method), false, `${method} is not needed to switch a skill`);
  assert.equal(methods.includes('plugin/installed'), false, 'the plugins are not listed again for a skill');
  assert.ok(methods.length <= 5, `a switch is ${methods.length} requests: ${methods.join(', ')}`);
});
