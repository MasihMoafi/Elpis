// The credit-funded API client owns its requests and credentials independently of Codex.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import OpenAI from "openai";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { FunctionTool, Response, ResponseCreateParamsStreaming, ResponseInputItem, ResponseInputMessageContentList } from "openai/resources/responses/responses";

const keyFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "elpis", "openai-credits.env");
export const hasCreditKey = () => Boolean(process.env.OPENAI_CREDITS_API_KEY?.trim() || existsSync(keyFile()));

export type CreditReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CreditEffortOption = { value: CreditReasoningEffort; name: string; description: string };

export const CREDIT_REASONING_EFFORTS: readonly CreditEffortOption[] = [
  { value: "low", name: "Low", description: "Fast responses with lighter reasoning" },
  { value: "medium", name: "Medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { value: "high", name: "High", description: "Greater reasoning depth for complex problems" },
  { value: "xhigh", name: "Xhigh", description: "Extra high reasoning depth for complex problems" },
  { value: "max", name: "Max", description: "Maximum reasoning depth for the hardest problems" },
];

const CREDIT_MODEL_RE = /^gpt-\d+(?:\.\d+)?-(?:sol|astra)$/;

export function creditEffortsForModel(model: string): { levels: readonly CreditEffortOption[]; defaultEffort: CreditReasoningEffort | null } {
  if (!CREDIT_MODEL_RE.test(model)) return { levels: [], defaultEffort: null };
  return { levels: CREDIT_REASONING_EFFORTS, defaultEffort: model === "gpt-6-sol" ? "medium" : "low" };
}

export function parseCreditEffort(model: string, value: unknown): { ok: true; effort: CreditReasoningEffort | undefined } | { ok: false } {
  if (value === undefined || value === null || value === "" || value === "default") return { ok: true, effort: undefined };
  if (typeof value !== "string") return { ok: false };
  const { levels } = creditEffortsForModel(model);
  const match = levels.find((level) => level.value === value);
  return match ? { ok: true, effort: match.value } : { ok: false };
}

function loopbackBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "https://api.openai.com/v1";
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]")) {
    throw new Error("OPENAI_CREDITS_BASE_URL may only target a local loopback address.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function createCreditClient() {
  const key = process.env.OPENAI_CREDITS_API_KEY?.trim() || parseEnv(readFileSync(keyFile(), "utf8")).OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Set OPENAI_CREDITS_API_KEY or configure the credit organization’s key in openai-credits.env.");
  return new OpenAI({
    apiKey: key,
    baseURL: loopbackBaseUrl(process.env.OPENAI_CREDITS_BASE_URL),
    organization: null,
    project: null,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
  });
}

export async function creditModels(client: OpenAI) {
  const ids = new Set<string>();
  for await (const model of client.models.list({ timeout: 12_000 })) {
    if (CREDIT_MODEL_RE.test(model.id)) ids.add(model.id);
  }
  return [...ids].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

export function buildCreditRequestParams({ model, effort, instructions, input, tools }: {
  model: string;
  effort?: unknown;
  instructions?: string | undefined;
  input: ResponseInputItem[];
  tools: FunctionTool[];
}): ResponseCreateParamsStreaming {
  const parsed = parseCreditEffort(model, effort);
  return {
    model,
    ...(instructions ? { instructions } : {}),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    input,
    tools,
    ...(parsed.ok && parsed.effort ? { reasoning: { effort: parsed.effort } } : {}),
  };
}

export async function streamCreditResponse(client: OpenAI, params: ResponseCreateParamsStreaming, signal: AbortSignal, onText: (delta: string) => Promise<void>) {
  // Preserve the API's output items for the next request, including tool calls and encrypted reasoning.
  let response: Response | undefined;
  const stream = await client.responses.create(params, { signal });
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") await onText(event.delta);
    if (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") response = event.response;
    if (event.type === "error") throw new Error(event.message);
  }
  if (!response) throw new Error("The OpenAI API stream ended before the response completed.");
  if (response.status !== "completed") throw new Error(response.error?.message || `OpenAI response ${response.status}: ${response.incomplete_details?.reason || "no complete answer"}`);
  return response;
}

export function promptContent(blocks: ContentBlock[]): ResponseInputMessageContentList {
  return blocks.map(block => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "image") return { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: "auto" };
    if (block.type === "resource_link") return { type: "input_text", text: block.uri };
    if (block.type === "resource" && "text" in block.resource) return { type: "input_text", text: block.resource.text };
    throw new Error(`Unsupported OpenAI API input: ${block.type}`);
  });
}
