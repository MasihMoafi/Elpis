/** Elpis equivalents of the reference's model catalog, transcript and logging ports. */
export interface TranscriptBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface TranscriptMessage {
  role: string;
  content: TranscriptBlock[];
}
export type TranscriptEvent =
  | { type: "user/message"; data: TranscriptMessage }
  | { type: "assistant/message" | "tool/result"; data: { message: TranscriptMessage } };
export interface CatalogModel {
  id: string;
  name: string;
  reasoning?: { efforts: { id: string; name: string }[] };
}
export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string } | null;
  groups: { id: string; name: string; models: CatalogModel[] }[];
  failures: { provider: string; error: string }[];
}
export interface AppContext {
  logger: { warn(format: string, ...values: unknown[]): void };
  sessionController: {
    modelCatalog(): Promise<ModelCatalog>;
    inspect(sessionId: string): Promise<{ events: TranscriptEvent[] }>;
  };
}
