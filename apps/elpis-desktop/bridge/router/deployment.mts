// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/deployment.ts.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { LIMITS } from "./limits.mts";
import { SetupError } from "./infra/setup.mts";
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from "./infra/environment.mts";
import type { Deployment as SourceDeployment, SubprocessRuntime } from "./infra/types.mts";
export { GithubAccountsSchema } from "./sources/settings.mts";
import { GithubAccountsSchema } from "./sources/settings.mts";
import { GH_DIRECT_ARGS } from "./infra/github-env.mts";

export interface Value<T> {
  get(): T;
}
export interface Machine {
  stateDir: string;
  promptMaxChars: Value<number>;
  admissionContextMaxPages: Value<number>;
  admissionContextTimeoutMs: Value<number>;
}
export interface Deployment extends SourceDeployment, Machine {}
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: ["repository"] };
export const Config = z
  .object({
    promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).default(100_000),
    admissionContextMaxPages: z
      .number()
      .int()
      .min(LIMITS.admissionContextMaxPages.min)
      .max(LIMITS.admissionContextMaxPages.max)
      .default(10),
    admissionContextTimeoutMs: z
      .number()
      .int()
      .min(LIMITS.admissionContextTimeoutMs.min)
      .max(LIMITS.admissionContextTimeoutMs.max)
      .default(15_000),
  })
  .strict();
export function machineOf(stateDir: string, read: () => unknown = () => ({})): Machine {
  return {
    stateDir,
    promptMaxChars: { get: () => Config.parse(read()).promptMaxChars },
    admissionContextMaxPages: { get: () => Config.parse(read()).admissionContextMaxPages },
    admissionContextTimeoutMs: { get: () => Config.parse(read()).admissionContextTimeoutMs },
  };
}
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes("/") && !isAbsolute(name)) throw new Error("A command name or absolute path is required");
  const candidates = isAbsolute(name)
    ? [name]
    : path
        .split(delimiter)
        .filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude)))
        .map(dir => join(dir, name));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      /* Try the next executable. */
    }
  }
  throw new Error(`${name} is not executable`);
}
export type Probe = (argv: string[]) => Promise<string>;
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? "", workerBin(stateDir));
  return argv =>
    runAsWorker(
      subprocess,
      ["env", ...GH_DIRECT_ARGS, `PATH=${path}`, ...argv],
      cwd,
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    );
}
const User = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() });
const Access = z.object({ full_name: z.string(), permissions: z.object({ push: z.boolean().optional() }).optional() });
/** Use the existing gh login. Authentication material stays in gh's credential store. */
export async function resolveDeployment(
  machine: Machine,
  github: unknown,
  probe: Probe,
  path = process.env.PATH ?? "",
): Promise<Deployment> {
  const { repository } = GithubAccountsSchema.parse(github ?? {});
  if (!repository) throw new SetupError("repositoryUnset");
  let cli: string;
  try {
    cli = executable("gh", path, workerBin(machine.stateDir));
  } catch {
    throw new SetupError("agentCliMissing");
  }
  const user = User.safeParse(
    JSON.parse(
      await probe([cli, "api", "user"]).catch(() => {
        throw new SetupError("agentCliSignedOut");
      }),
    ),
  );
  if (!user.success) throw new SetupError("agentCliNoAccount");
  const result = Access.safeParse(
    JSON.parse(
      await probe([cli, "api", `repos/${repository}`]).catch(() => {
        throw new SetupError("repositoryUnreadable", { account: user.data.login, repository });
      }),
    ),
  );
  if (!result.success) throw new SetupError("repositoryUnreported", { repository });
  return {
    ...machine,
    repository: result.data.full_name,
    github: { cli, login: user.data.login, noreply: `${user.data.id}+${user.data.login}@users.noreply.github.com` },
  };
}
