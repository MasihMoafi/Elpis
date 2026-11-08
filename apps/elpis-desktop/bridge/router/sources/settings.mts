// Ported from dsh-superagent (MIT), src/policy.ts and src/deployment.ts
import { z } from "zod";

export { AdmissionTableSchema } from "../policy.mts";
export const GithubAccountsSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "owner/name")
    .default(""),
  cli: z.string().trim().default(""),
});
export interface Settings {
  sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
  policy: { sources: Record<string, Record<string, unknown>> };
}
