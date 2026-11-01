// The ChatGPT subscription's models when ChatGPT is not the default connection (1 Nov: with the Anthropic promotional
// credits as the default, Luna and Sol were missing from every model menu, because the engine lists only the catalog of
// the provider it started with, and an "openai" connection was then treated as an API key that is not there).
// The engine itself reads that catalog with the person's ChatGPT sign-in: `elpis-next -c model_provider=openai debug models`.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MINUTES = 10;
let cached = null;

/** Maps one `debug models` entry to the shape model/list returns. */
export const toModel = entry => ({
  id: entry.slug, model: entry.slug, displayName: entry.display_name || entry.slug, description: entry.description ?? '',
  hidden: entry.visibility !== 'list',
  supportedReasoningEfforts: (entry.supported_reasoning_levels ?? []).map(level => ({ reasoningEffort: level.effort, description: level.description ?? '' })),
  defaultReasoningEffort: entry.default_reasoning_level ?? null,
});

/** `run` is replaceable for tests; it resolves to the command's stdout. */
export async function subscriptionModels({ env = process.env, now = Date.now(), run = defaultRun } = {}) {
  if (cached && now - cached.at < MINUTES * 60000) return cached.result;
  const engine = env.ELPIS_ENGINE_BIN || path.join(os.homedir(), '.local', 'bin', 'elpis-next');
  const parsed = JSON.parse(await run(engine, ['-c', 'model_provider=openai', 'debug', 'models'], env));
  if (!Array.isArray(parsed?.models)) throw new Error('The ChatGPT model list could not be read.');
  const result = { data: parsed.models.map(toModel).filter(model => !model.hidden), nextCursor: null };
  cached = { at: now, result };
  return result;
}
export const forgetSubscriptionModels = () => { cached = null; };

function defaultRun(command, args, env) {
  return new Promise((resolve, reject) => execFile(command, args, { env, timeout: 30000, maxBuffer: 8 << 20 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
