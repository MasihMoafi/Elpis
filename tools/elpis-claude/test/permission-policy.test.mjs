import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultPermissionMode, defaultPermissionSettings, permissionAllowed, permissionMode, permissionSettings, permissionSettingsAllowed } from '../permission-policy.mjs';
import { PermissionChoices } from '../permission-choices.mjs';
import { forAll } from './property.mjs';

test('Full access is the missing-policy default and never enables Bypass', () => {
  for (const config of [{}, { default_permissions: ':danger-full-access' }, { sandbox_mode: 'workspace-write' }]) {
    assert.equal(defaultPermissionMode({ config }), 'full');
    assert.deepEqual(permissionSettings('full'), { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
  }
  assert.equal(permissionSettings('bypass').permissions, ':bypass-permissions');
});
test('config layers decide the profile syntax and custom configs stay custom', () => {
  const config = { approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write', default_permissions: ':danger-full-access' };
  assert.equal(defaultPermissionMode({ config, layers: [{ config: { sandbox_mode: 'workspace-write' } }, { config: { default_permissions: ':danger-full-access' } }] }), 'auto');
  assert.equal(defaultPermissionMode({ config, layers: [{ config: { default_permissions: ':danger-full-access' } }] }), 'custom');
  assert.equal(defaultPermissionMode({ config: { approval_policy: 'never', default_permissions: ':bypass-permissions' } }), 'custom');
});
test('a scoped automatic task is checked by its actual never policy, separately from the Ask preset', () => {
  const scoped = { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only' };
  assert.equal(permissionSettingsAllowed(scoped, { allowedApprovalPolicies: ['never'], allowedSandboxModes: ['read-only'] }), true);
  assert.equal(permissionSettingsAllowed(scoped, { allowedApprovalPolicies: ['never'], allowedSandboxModes: ['workspace-write'] }), false);
});
test('automatic agents follow the configured access scope and never ask or inherit Bypass', async () => {
  await forAll(200, g => {
    const approval = g.pick(['never', 'on-request']), profile = g.pick([':workspace', ':read-only', ':danger-full-access', ':bypass-permissions']);
    const automatic = defaultPermissionSettings({ config: { approval_policy: approval, default_permissions: profile } }, true);
    assert.equal(automatic.approvalPolicy, 'never');
    assert.equal(automatic.permissions, profile === ':bypass-permissions' ? ':danger-full-access' : profile);
  });
});
test('preset round trips and managed restrictions hold for arbitrary allowed sets', async () => {
  await forAll(300, g => {
    const mode = g.pick(['ask', 'auto', 'full', 'bypass']);
    const settings = permissionSettings(mode);
    assert.equal(permissionMode(settings), mode);
    const approvals = g.shuffle(['on-request', 'never', 'untrusted']).slice(0, g.int(0, 3));
    const sandboxes = g.shuffle(['read-only', 'workspace-write', 'danger-full-access']).slice(0, g.int(0, 3));
    const allowed = permissionAllowed(mode, { allowedApprovalPolicies: approvals, allowedSandboxModes: sandboxes });
    const expectedSandbox = ['full', 'bypass'].includes(mode) ? 'danger-full-access' : 'workspace-write';
    assert.equal(allowed, approvals.includes(settings.approvalPolicy) && sandboxes.includes(expectedSandbox));
    assert.equal(permissionSettings(mode).permissions === ':bypass-permissions', mode === 'bypass');
  });
});
test('choices survive a new store, concurrent chats do not overwrite one another, and invalid paths fail', async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/permission-choices-'));
  t.after(() => promisify(execFile)('gio', ['trash', root]));
  const store = new PermissionChoices(root);
  assert.equal(await store.read('legacy-on-request'), null);
  await forAll(80, async (g, i) => {
    const id = `chat-${i}`, choice = permissionSettings(g.pick(['ask', 'auto', 'full', 'bypass']));
    const other = permissionSettings('full');
    await Promise.all([store.write(id, choice), store.write(`${id}-other`, other)]);
    assert.deepEqual(await new PermissionChoices(root).read(id), choice);
    assert.deepEqual(await new PermissionChoices(root).read(`${id}-other`), other);
  });
  await assert.rejects(store.read('../config'));
  await assert.rejects(store.write('', permissionSettings('full')));
});
