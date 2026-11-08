import type { Entry } from "./api.ts";

type Transcript = { entries: Entry[]; cursor: string | null };
const MAX_CHARS = 2 * 1024 * 1024;
const MAX_CHATS = 4;

function textSize(value: unknown, remaining: number): number {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object") return 0;
  let total = 0;
  for (const part of Object.values(value)) {
    total += textSize(part, remaining - total);
    if (total > remaining) break;
  }
  return total;
}

/** Recently viewed transcripts are an optional accelerator; disk history owns older or oversized chats. */
export class TranscriptCache {
  private readonly values = new Map<string, { transcript: Transcript; chars: number }>();
  private chars = 0;
  has(id: string) {
    return this.values.has(id);
  }
  get(id: string) {
    const value = this.values.get(id);
    if (value) {
      this.values.delete(id);
      this.values.set(id, value);
    }
    return value?.transcript;
  }
  delete(id: string) {
    const value = this.values.get(id);
    if (value) {
      this.chars -= value.chars;
      this.values.delete(id);
    }
  }
  set(id: string, transcript: Transcript) {
    this.delete(id);
    if (transcript.entries.length > 2000) return;
    const chars = textSize(transcript.entries, MAX_CHARS);
    if (chars > MAX_CHARS) return;
    this.values.set(id, { transcript, chars });
    this.chars += chars;
    while (this.values.size > MAX_CHATS || this.chars > MAX_CHARS) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
