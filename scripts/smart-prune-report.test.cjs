const test = require('node:test');
const assert = require('node:assert/strict');
const { addAttempt, summarize, collectSnapshots } = require('./smart-prune-report.cjs');

test('repeated snapshots count once, and full audits win regardless of arrival order', () => {
  for (const order of [['audit', 'rollout'], ['rollout', 'audit']]) {
    const attempts = new Map();
    for (const source of order) for (let i = 0; i < 20; i++) addAttempt(attempts, {
      attempt_id: 'one', status: 'admitted', admitted_outputs: 2,
      saved_tokens: source === 'audit' ? 700 : 900,
      usage: source === 'audit' ? { total_tokens: 1200 } : null,
    }, 'session-one', '2026-09-10T00:00:00Z', source);
    const report = summarize(attempts);
    assert.equal(report.attempts, 1);
    assert.equal(report.estimatedTokensAvoided, 700);
    assert.equal(report.optimizerTokens, 1200);
    assert.equal(report.sessions, 1);
  }
});

test('failed or unchanged attempts do not inflate savings; missing usage stays missing', () => {
  const attempts = new Map();
  for (const status of ['unchanged', 'timed_out', 'malformed_response', 'cancelled', 'model_error', 'audit_error']) {
    addAttempt(attempts, { attempt_id: status, status, admitted_outputs: 1, saved_tokens: 9999 }, 'session', null, 'audit');
  }
  const report = summarize(attempts);
  assert.equal(report.estimatedTokensAvoided, 0);
  assert.equal(report.admittedOutputs, 0);
  assert.equal(report.optimizerTokens, 0);
  assert.equal(report.usageReports, 0);
  assert.equal(report.missingUsageReports, 6);
});

test('a planted snapshot is discovered on the real event envelope, not from quoted tool text', () => {
  const found = [];
  const planted = { approx_saved_tokens: 321, latest_attempt: { attempt_id: 'planted' } };
  collectSnapshots({ type: 'event_msg', payload: { type: 'token_count', smart_prune: planted } }, value => found.push(value));
  collectSnapshots({ payload: { text: JSON.stringify(planted) } }, value => found.push(value));
  assert.deepEqual(found, [planted]);
  collectSnapshots({ payload: { smart_prune: null } }, value => found.push(value));
  assert.equal(found.length, 1);
});

test('independent attempts and sessions add without claiming net savings', () => {
  const attempts = new Map();
  for (const id of ['a', 'b']) addAttempt(attempts, { attempt_id: id, status: 'admitted', admitted_outputs: 1, saved_tokens: 300, usage: { total_tokens: 1000 } }, id, '2026-09-10T01:00:00Z', 'audit');
  const report = summarize(attempts);
  assert.equal(report.estimatedTokensAvoided, 600);
  assert.equal(report.optimizerTokens, 2000);
  assert.equal(report.sessions, 2);
  assert.equal(report.daily[0].saved, 600);
  assert.ok(report.methodology.some(text => text.includes('not established')));
});
