/**
 * Tells him in the Elpis chat when one of his chats finishes, fails or starts waiting for him, so he need not watch
 * tabs. The host does this itself, without a model: it looks at his chats every few seconds and says what changed.
 * A short turn in a chat he is using is not news: only a long one, or one the router itself started, is announced.
 */
import { key } from "./core/index.mts";
import type { Chat, Chats } from "./chats.mts";

export interface WatchOptions {
  chats: Pick<Chats, "list" | "read">;
  /** Chats the router runs itself: its conversation, its Sessions and its workers, whose results it reports anyway. */
  skip(chat: Pick<Chat, "id" | "folder">): boolean;
  /** Writes one line in the Elpis chat; the id makes a repeated line a no-op. */
  say(id: string, text: string): Promise<unknown>;
}

const LIMIT = 50;
const LINE_CHARS = 160;
/** A turn seen working at this many looks in a row is long enough to announce (20 s at a look every 5 s). */
export const LONG_LOOKS = 4;
/** How many looks a turn the router started stays expected: half an hour at a look every 5 s. */
export const EXPECTED_LOOKS = 360;
interface Seen {
  state: Chat["state"];
  updated: string | undefined;
  /** How many looks it has been working in this turn; waiting for him in between does not start the count again. */
  working: number;
}

export class ChatWatch {
  private readonly options: WatchOptions;
  private seen: Map<string, Seen> | undefined;
  /** Chats in which the router started a turn for him, with the looks left before that is forgotten. */
  private readonly expected = new Map<string, number>();
  constructor(options: WatchOptions) {
    this.options = options;
  }
  /** The router started a turn in this chat for him: its end is announced however short the turn. */
  expect(id: string): void {
    this.expected.set(id, EXPECTED_LOOKS);
  }
  /**
   * One look at his chats: says what changed since the last look. The first look only remembers. A look whose lines
   * could not all be written remembers nothing new, so the next look says them again; a line already written is a
   * no-op by its id.
   */
  async look(): Promise<void> {
    const listed = await this.options.chats.list({ limit: LIMIT });
    const chats = listed.chats.filter(chat => !this.options.skip(chat));
    const before = this.seen;
    const next = new Map(
      chats.map(chat => {
        const was = before?.get(chat.id)?.working ?? 0;
        const working = chat.state === "working" ? was + 1 : chat.state === "needs you" ? was : 0;
        return [chat.id, { state: chat.state, updated: chat.updated, working }] as const;
      }),
    );
    const settled: string[] = [];
    if (before)
      for (const chat of chats) {
        const change = await this.change(chat, before.get(chat.id));
        if (!change) continue;
        await this.options.say(key("watch", chat.id, chat.state, chat.updated ?? ""), change.text);
        if (change.ends) settled.push(chat.id);
      }
    this.seen = next;
    for (const id of settled) this.expected.delete(id);
    for (const [id, looks] of this.expected) {
      if (looks <= 1) this.expected.delete(id);
      else this.expected.set(id, looks - 1);
    }
  }
  /** What to say about a chat, and whether that ends the turn the router may have started in it. */
  private async change(chat: Chat, was: Seen | undefined): Promise<{ text: string; ends: boolean } | undefined> {
    if (chat.state === "needs you")
      return was?.state === "needs you"
        ? undefined
        : { text: `Needs you: “${chat.title}” is waiting for your approval or answer.`, ends: false };
    if (chat.state === "failed")
      return was?.state === "working" || was?.state === "needs you"
        ? { text: `Failed: “${chat.title}” stopped with an error.`, ends: true }
        : undefined;
    if (chat.state !== "idle") return undefined;
    const asked = this.expected.has(chat.id);
    const long = (was?.working ?? 0) >= LONG_LOOKS;
    const ran = was?.state === "working" || was?.state === "needs you";
    // A turn the router started may end between two looks: the chat is new or has moved, and never looked working.
    const moved = !was || (!!chat.updated && !!was.updated && chat.updated > was.updated);
    if (!long && !(asked && (ran || moved))) return undefined;
    const last = await this.options.chats.read(chat.id, 1).then(
      read => read.messages.at(-1),
      () => undefined,
    );
    // The person's message is the last word: the turn the router started has not answered yet.
    if (!long && !ran && last?.from !== "agent") return undefined;
    const line = (last?.from === "agent" ? last.text : "").trim().split("\n")[0] ?? "";
    const said = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
    return { text: `Finished: “${chat.title}”.${said ? ` ${said}` : ""}`, ends: true };
  }
}

/** Looks every `everyMs`; a look that fails is tried again at the next one. Returns the function that stops it. */
export function watchChats(watch: ChatWatch, everyMs = 5000): () => void {
  let looking = false;
  const timer = setInterval(() => {
    if (looking) return;
    looking = true;
    void watch
      .look()
      .catch(() => {})
      .finally(() => {
        looking = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
