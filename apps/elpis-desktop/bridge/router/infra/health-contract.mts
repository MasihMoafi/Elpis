// Adapted from dsh-superagent (MIT), src/sources/host.ts. Client-safe health contract.
import { fill } from "./text.mts";
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: "Waiting for the deployment check",
  sourceOff: "Off",
  feishuCliUnset: "The Source is on, and its bot lark-cli is not set",
  feishuBotMissing: "Waiting for the Feishu bot",
  pollFailures: "{count} consecutive failed polls; last: {error}",
} as const;
export type HealthCode = keyof typeof HEALTH_TEXT;
export type Health = {
  state: "starting" | "ready" | "paused" | "error";
  detail: string;
  at?: string;
  code?: HealthCode;
  values?: Record<string, string>;
};
export function health(state: Health["state"], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...(Object.keys(values).length ? { values } : {}) };
}
