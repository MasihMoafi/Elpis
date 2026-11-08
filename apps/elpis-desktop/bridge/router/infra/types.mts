/** Structural boundaries supplied by the host; no DeepSeek runtime dependency is required. */
export interface Deployment {
  stateDir: string;
  repository: string;
  github: { cli: string; login: string; noreply: string };
  feishu?: { cli: string; appId: string; brand: "feishu" | "lark"; botId: string; name: string } | undefined;
}
export type { Health, HealthCode } from "./health-contract.mts";
export interface SubprocessOutputReader {
  readFrom(offset: number): { text: string };
}
export interface SubprocessRuntime {
  spawn(options: {
    argv: string[];
    cwd: string;
    graceMs: number;
    signal: AbortSignal;
    env?: Record<string, string | undefined>;
    stdio: { stdin: "ignore"; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
  }): {
    done: Promise<{ exitCode: number | null }>;
    collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader };
  };
}
