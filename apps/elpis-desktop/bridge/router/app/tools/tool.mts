// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/tools/tool.ts.
/** Shared tool primitives and schemas for the main and executor Sessions. */
import { z } from "zod";
import { IM_WORDS, wordCount } from "../../infra/text.mts";
import { resourceGrammar } from "../resource-names.mts";

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>;
}
export type RegisterTool = <S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  execute: Tool<S>["execute"],
) => void;
type Definition<S extends z.ZodType> = Omit<Tool<S>, "execute"> & {
  execute(args: z.infer<S>, signal: AbortSignal): unknown;
};
export const tool = <S extends z.ZodType>(definition: Definition<S>): Tool => ({
  ...definition,
  execute: (args, signal) => Promise.resolve().then(() => definition.execute(definition.schema.parse(args), signal)),
});

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    text => wordCount(text) <= IM_WORDS,
    `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`,
  );
/**
 * Builds the `orchestrator_read` tool, scoping allowed resource patterns to the main Session or to an
 * Executor Session (which may read only its own ticket and messages that reached it).
 */
export function readTool(
  description: string,
  executor: boolean,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => unknown,
): Tool {
  return tool({
    name: "orchestrator_read",
    description,
    schema: z
      .object({
        resource: z
          .string()
          .min(1)
          .describe(`The resource, one of: ${resourceGrammar(executor)}.`),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Copy next_offset from the previous page; it counts characters of a text and items of a list."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .optional()
          .describe(
            "Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.",
          ),
      })
      .strict(),
    execute: (args, signal) => read(args.resource, args.offset, args.limit, signal),
  });
}
