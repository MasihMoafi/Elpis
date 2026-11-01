// The ChatGPT subscription's models are listed even when another connection is the default (1 Nov: Luna was missing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetSubscriptionModels, subscriptionModels } from './subscription-models.mjs';

const catalog = JSON.stringify({ models: [
  { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
  { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' },
] });

test('the engine is asked for the openai catalog with the profile home; hidden models stay out; the answer is reused', async () => {
  forgetSubscriptionModels();
  const calls = [];
  const run = async (command, args, env) => { calls.push({ command, args, home: env.ELPIS_HOME }); return catalog; };
  const env = { ELPIS_ENGINE_BIN: '/opt/elpis/engine', ELPIS_HOME: '/home/me/.elpis-next' };
  const first = await subscriptionModels({ env, run, now: 0 });
  assert.deepEqual(calls, [{ command: '/opt/elpis/engine', args: ['-c', 'model_provider=openai', 'debug', 'models'], home: '/home/me/.elpis-next' }]);
  assert.deepEqual(first.data.map(model => model.model), ['gpt-6-luna']);
  assert.deepEqual(first.data[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'medium']);
  assert.equal(first.data[0].defaultReasoningEffort, 'medium');
  await subscriptionModels({ env, run, now: 60000 });
  assert.equal(calls.length, 1, 'reused within ten minutes');
  await subscriptionModels({ env, run, now: 11 * 60000 });
  assert.equal(calls.length, 2, 'read again after ten minutes');
});

test('an unreadable answer is an error, not an empty menu', async () => {
  forgetSubscriptionModels();
  await assert.rejects(subscriptionModels({ run: async () => '{"nothing":1}', now: 0 }), /could not be read/);
});
