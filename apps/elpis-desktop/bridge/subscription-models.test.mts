// The ChatGPT subscription's models are listed even when another connection is the default (1 Nov: Luna was missing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetSubscriptionModels, subscriptionModels } from './subscription-models.mts';

const catalog = JSON.stringify({ models: [
  { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', input_modalities: ['text', 'image'], default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
  { slug: 'codex-auto-review', display_name: 'Review', visibility: 'hide' },
] });

test('the engine is asked for the openai catalog with the profile home; hidden models stay out; the answer is reused', async () => {
  forgetSubscriptionModels();
  const calls: { command: string; args: string[]; home: string | undefined }[] = [];
  const run = async (command: string, args: string[], env: NodeJS.ProcessEnv) => { calls.push({ command, args, home: env.ELPIS_HOME }); return catalog; };
  const env = { ELPIS_ENGINE_BIN: '/opt/elpis/engine', ELPIS_HOME: '/home/me/.elpis-next' };
  const first = await subscriptionModels({ env, run, now: 0 });
  assert.deepEqual(calls, [{ command: '/opt/elpis/engine', args: ['-c', 'model_provider=openai', 'debug', 'models'], home: '/home/me/.elpis-next' }]);
  assert.deepEqual(first.data.map(model => model.model), ['gpt-6-luna']);
  assert.deepEqual(first.data[0]!.supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'medium']);
  assert.equal(first.data[0]!.defaultReasoningEffort, 'medium');
  assert.deepEqual(first.data[0]!.inputModalities, ['text', 'image'], 'vision capability reaches the board');
  await subscriptionModels({ env, run, now: 60000 });
  assert.equal(calls.length, 1, 'reused within ten minutes');
  await subscriptionModels({ env, run, now: 11 * 60000 });
  assert.equal(calls.length, 2, 'read again after ten minutes');
});

test('another engine-signed connection lists its own models, kept apart from ChatGPT\'s (1 Nov: the Anthropic credits vanished)', async () => {
  forgetSubscriptionModels();
  const calls: (string | undefined)[] = [];
  const claude = JSON.stringify({ models: [{ slug: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', visibility: 'list' }] });
  const run = async (_command: string, args: string[]) => { calls.push(args[1]); return args[1] === 'model_provider=anthropic-credits' ? claude : catalog; };
  assert.deepEqual((await subscriptionModels({ run, now: 0, provider: 'anthropic-credits' })).data.map(model => model.model), ['claude-haiku-5-5']);
  assert.deepEqual((await subscriptionModels({ run, now: 0 })).data.map(model => model.model), ['gpt-6-luna']);
  assert.deepEqual(calls, ['model_provider=anthropic-credits', 'model_provider=openai']);
  await assert.rejects(subscriptionModels({ run, now: 0, provider: 'x;rm' }), /existing configured connection/);
});

test('an unreadable answer is an error, not an empty menu', async () => {
  forgetSubscriptionModels();
  await assert.rejects(subscriptionModels({ run: async () => '{"nothing":1}', now: 0 }), /could not be read/);
});

test('a model menu that opens (refresh) asks the engine again, per connection, and its answer is then reused', async () => {
  forgetSubscriptionModels();
  const calls: (string | undefined)[] = [];
  let models = [{ slug: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', visibility: 'list' }];
  const run = async (_command: string, args: string[]) => { calls.push(args[1]); return JSON.stringify({ models }); };
  const provider = 'anthropic-credits';
  await subscriptionModels({ run, now: 0, provider });
  models = [...models, { slug: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', visibility: 'list' }];
  assert.equal((await subscriptionModels({ run, now: 1000, provider })).data.length, 1, 'no refresh: the last answer');
  assert.deepEqual((await subscriptionModels({ run, now: 2000, provider, refresh: true })).data.map(model => model.model), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal((await subscriptionModels({ run, now: 3000, provider })).data.length, 2, 'the refreshed answer is reused');
  await subscriptionModels({ run, now: 3000, provider: 'openai', refresh: true });
  assert.deepEqual(calls, ['model_provider=anthropic-credits', 'model_provider=anthropic-credits', 'model_provider=openai']);
});
