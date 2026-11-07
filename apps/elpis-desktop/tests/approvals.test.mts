// Approval cards' decisions (lib/approvals.ts): which choices an MCP request offers, what a form may send, and which
// permission grants are allowed. The bridge runs the same checks before it answers the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ElicitationParams, McpElicitationSchema } from '../lib/approvals.ts';
import { elicitationChoices, elicitationResponse, elicitationFormContent, permissionsResponse } from '../lib/approvals.ts';

const tool: ElicitationParams = { serverName: 'elpis_browser', mode: 'form', message: 'Open the fixture site', requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'browser_open', persist: ['session'] } };

test('an MCP tool call offers Allow, the session choice it asks for and Cancel, never Deny or Always allow', () => {
  assert.deepEqual(elicitationChoices(tool).map(choice => choice.label), ['Allow', 'Allow for this session', 'Cancel']);
  assert.deepEqual(elicitationResponse(tool, { action: 'accept', content: null, _meta: { persist: 'session' } }), { action: 'accept', content: null, _meta: { persist: 'session' } });
  const unoffered = { ...tool, _meta: { ...tool._meta, persist: undefined } };
  assert.deepEqual(elicitationChoices(unoffered).map(choice => choice.label), ['Allow', 'Cancel']);
  assert.throws(() => elicitationResponse(unoffered, { action: 'accept', _meta: { persist: 'session' } }), /not offered/);
  assert.deepEqual(elicitationResponse(unoffered, { action: 'cancel' }), { action: 'cancel', content: null, _meta: null });
  assert.throws(() => elicitationResponse(tool, { action: 'decline' }), /not offered/, 'a tool call has no Deny');
});

test('an MCP form sends typed values and refuses an invalid email, a missing answer or an unknown field', () => {
  const schema: McpElicitationSchema = { type: 'object', required: ['email'], properties: {
    email: { type: 'string', title: 'Email', format: 'email' }, count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' },
    color: { type: 'string', enum: ['red', 'blue'] }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } };
  const form = { mode: 'form', message: 'Fill it in', requestedSchema: schema };
  assert.throws(() => elicitationFormContent(schema, { email: ['bad'] }), /Check Email/);
  assert.throws(() => elicitationFormContent(schema, {}), /Answer Email/);
  const content = elicitationFormContent(schema, { email: ['fixture@example.test'], count: ['2'], enabled: ['false'], color: ['blue'], tags: ['["a","b"]'] });
  assert.deepEqual(content, { email: 'fixture@example.test', count: 2, enabled: false, color: 'blue', tags: ['a', 'b'] });
  assert.deepEqual(elicitationResponse(form, { action: 'accept', content }).content, content);
  assert.throws(() => elicitationResponse(form, { action: 'accept', content: { ...content, extra: 1 } }), /Unsupported form fields/);
  assert.throws(() => elicitationResponse(form, { action: 'decline', content }), /cannot include form content/);
});

test('a permission card grants exactly the requested scope for the session, or denies for this turn only', () => {
  const requested = { network: { enabled: true }, fileSystem: { read: ['/fixture'], write: ['/fixture/output'] }, macos: null };
  const granted = { network: { enabled: true }, fileSystem: { read: ['/fixture'], write: ['/fixture/output'] } };
  assert.deepEqual(permissionsResponse(requested, { permissions: granted, scope: 'session' }), { permissions: granted, scope: 'session' });
  assert.deepEqual(permissionsResponse(requested, { permissions: {}, scope: 'turn' }), { permissions: {}, scope: 'turn' });
  assert.throws(() => permissionsResponse(requested, { permissions: { network: { enabled: true } }, scope: 'session' }), /only the requested/);
  assert.throws(() => permissionsResponse(requested, { permissions: {}, scope: 'session' }), /Deny without granting session scope/);
});
