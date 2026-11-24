// The credit-funded API client owns its requests and credentials independently of Codex.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import OpenAI from "openai";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Response, ResponseCreateParamsStreaming, ResponseInputMessageContentList } from "openai/resources/responses/responses";

const keyFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "elpis", "openai-credits.env");
export const hasCreditKey = () => Boolean(process.env.OPENAI_CREDITS_API_KEY?.trim() || existsSync(keyFile()));

export function createCreditClient() {
  const key = process.env.OPENAI_CREDITS_API_KEY?.trim() || parseEnv(readFileSync(keyFile(), "utf8")).OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Set OPENAI_CREDITS_API_KEY or configure the credit organization’s key in openai-credits.env.");
  return new OpenAI({ apiKey: key, baseURL: "https://api.openai.com/v1", organization: null, project: null, maxRetries: 0,
    fetchOptions: { redirect: "error" }, logLevel: "off" });
}

export async function creditModels(client: OpenAI) {
  const ids = new Set<string>();
  for await (const model of client.models.list({ timeout: 12_000 })) {
    if (/^gpt-\d+(?:\.\d+)?-(?:sol|astra)$/.test(model.id)) ids.add(model.id);
  }
  return [...ids].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
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
