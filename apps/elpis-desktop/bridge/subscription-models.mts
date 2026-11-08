// The ChatGPT subscription's models when ChatGPT is not the default connection (1 Nov: with the Anthropic promotional
// credits as the default, Luna and Sol were missing from every model menu, because the engine lists only the catalog of
// the provider it started with, and an "openai" connection was then treated as an API key that is not there).
// The engine itself reads that catalog with the person's ChatGPT sign-in: `elpis-next -c model_provider=openai debug models`.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

type CatalogEntry = {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  input_modalities?: string[];
  supported_reasoning_levels?: { effort: string; description?: string }[];
  default_reasoning_level?: string;
};
type CatalogModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  inputModalities?: string[];
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
};
type CatalogResult = { data: CatalogModel[]; nextCursor: null };
type Runner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const MINUTES = 10;
const cached = new Map<string, { at: number; result: CatalogResult }>(); // provider → { at, result }

/** Maps one `debug models` entry to the shape model/list returns. */
export const toModel = (entry: CatalogEntry): CatalogModel => ({
  id: entry.slug,
  model: entry.slug,
  displayName: entry.display_name || entry.slug,
  description: entry.description ?? "",
  hidden: entry.visibility !== "list",
  ...(entry.input_modalities ? { inputModalities: entry.input_modalities } : {}),
  supportedReasoningEfforts: (entry.supported_reasoning_levels ?? []).map(level => ({
    reasoningEffort: level.effort,
    description: level.description ?? "",
  })),
  defaultReasoningEffort: entry.default_reasoning_level ?? null,
});

/** `run` is replaceable for tests; it resolves to the command's stdout. */
/** `provider` is a connection the engine signs in to itself (ChatGPT `openai`, or one configured such as `anthropic-credits`).
 * `refresh` (a model menu opening) asks the engine again; the answer then serves other readers for ten minutes. */
export async function subscriptionModels({
  env = process.env,
  now = Date.now(),
  run = defaultRun,
  provider = "openai",
  refresh = false,
}: { env?: NodeJS.ProcessEnv; now?: number; run?: Runner; provider?: string; refresh?: boolean } = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new Error("Choose an existing configured connection.");
  const hit = cached.get(provider);
  if (hit && !refresh && now - hit.at < MINUTES * 60000) return hit.result;
  const engine = env.ELPIS_ENGINE_BIN || path.join(os.homedir(), ".local", "bin", "elpis-next");
  const parsed = JSON.parse(await run(engine, ["-c", `model_provider=${provider}`, "debug", "models"], env)) as {
    models?: CatalogEntry[];
  };
  if (!Array.isArray(parsed?.models)) throw new Error(`The ${provider} model list could not be read.`);
  const result = { data: parsed.models.map(toModel).filter(model => !model.hidden), nextCursor: null };
  cached.set(provider, { at: now, result });
  return result;
}
export const forgetSubscriptionModels = () => {
  cached.clear();
};

function defaultRun(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) =>
    execFile(command, args, { env, timeout: 30000, maxBuffer: 8 << 20 }, (error: Error | null, stdout: string) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    }),
  );
}
