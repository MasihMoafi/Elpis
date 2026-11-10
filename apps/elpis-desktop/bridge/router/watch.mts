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
/** How many of a chat's last entries to read for its final answer; tool steps among them are left out. */
const TAIL = 3;
/** A turn seen working at this many looks in a row is long enough to announce (20 s at a look every 5 s). */
export const LONG_LOOKS = 4;
interface Seen {
  state: Chat["state"];
  updated: string | undefined;
  /** How many looks in a row it has been working. */
  working: number;
}

export class ChatWatch {
  private readonly options: WatchOptions;
  private seen: Map<string, Seen> | undefined;
  private readonly expected = new Set<string>();
  constructor(options: WatchOptions) {
    this.options = options;
  }
  /** The router started a turn in this chat for him: its end is announced however short the turn. */
  expect(id: string): void {
    this.expected.add(id);
  }
  /** One look at his chats: says what changed since the last look. The first look only remembers. */
  async look(): Promise<void> {
    const chats = (await this.options.chats.list({ limit: LIMIT })).filter(chat => !this.options.skip(chat));
    const before = this.seen;
    this.seen = new Map(
      chats.map(chat => [
        chat.id,
        {
          state: chat.state,
          updated: chat.updated,
          working: chat.state === "working" ? (before?.get(chat.id)?.working ?? 0) + 1 : 0,
        },
      ]),
    );
    if (!before) return;
    for (const chat of chats) {
      const text = await this.change(chat, before.get(chat.id));
      if (text) await this.options.say(key("watch", chat.id, chat.state, chat.updated ?? ""), text);
    }
  }
  private async change(chat: Chat, was: Seen | undefined): Promise<string | undefined> {
    if (chat.state === "needs you")
      return was?.state === "needs you"
        ? undefined
        : `Needs you: “${chat.title}” is waiting for your approval or answer.`;
    if (chat.state === "failed")
      return was?.state === "working" ? `Failed: “${chat.title}” stopped with an error.` : undefined;
    if (chat.state !== "idle") return undefined;
    const asked = this.expected.has(chat.id);
    const long = (was?.working ?? 0) >= LONG_LOOKS;
    // A turn the router started may end between two looks: the chat is new or has moved, and never looked working.
    const moved = !was || (!!chat.updated && !!was.updated && chat.updated > was.updated);
    if (!long && !(asked && (was?.state === "working" || moved))) return undefined;
    const last = await this.options.chats.read(chat.id, TAIL).then(
      read => read.messages.at(-1),
      () => undefined,
    );
    // The person's message is the last word: the turn the router started has not answered yet.
    if (!long && last?.from !== "agent") return undefined;
    this.expected.delete(chat.id);
    const line = (last?.from === "agent" ? last.text : "").trim().split("\n")[0] ?? "";
    const said = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
    return `Finished: “${chat.title}”.${said ? ` ${said}` : ""}`;
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
