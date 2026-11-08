import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BridgeError, object, text } from "./validate.mts";
import { speechModelUnavailable, speechPcmRate } from "../lib/speech-model.mts";

const DEFAULT = Object.freeze({ source: "local", model: null, voice: null });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const MAX_AUDIO = 16 * 1024 * 1024;
const revision = (choice: unknown) => createHash("sha256").update(JSON.stringify(choice)).digest("hex").slice(0, 24);

async function audioBytes(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_AUDIO || !response.body) throw new BridgeError("Read aloud audio is too large or empty.", 502);
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AUDIO) {
        await reader.cancel().catch(() => {});
        throw new BridgeError("Read aloud audio is too large.", 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new BridgeError("Read aloud API returned empty audio.", 502);
  return Buffer.concat(chunks, length);
}

function pcmWav(audio: Buffer, rate: number) {
  if (audio.length % 2) throw new BridgeError("Read aloud API returned invalid PCM audio.", 502);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + audio.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

/** The bridge owns this preference; keys remain in the existing provider credential store. */
export function createReadAloudProvider({
  home,
  kokoro,
  provider,
  fetchImpl = fetch,
}: {
  home: string;
  kokoro: {
    voices?: () => Promise<string[]>;
    available: () => boolean;
    speak: (text: string, voice: string | null) => Promise<Buffer>;
  };
  provider: (source: string) => Promise<{ baseUrl: string; key: string }>;
  fetchImpl?: typeof fetch;
}) {
  const file = path.join(home, "read-aloud.json");
  let writing: Promise<unknown> = Promise.resolve();
  function validate(input: unknown) {
    const value = object(input, ["source", "model", "voice"]) as Record<string, unknown>;
    if (typeof value.source !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.source))
      throw new BridgeError("Choose a read aloud source.");
    if (value.source === "local") {
      if (value.model !== null || (value.voice !== null && (typeof value.voice !== "string" || !ID.test(value.voice))))
        throw new BridgeError("Choose a Kokoro voice.");
    } else {
      if (typeof value.model !== "string" || !ID.test(value.model)) throw new BridgeError("Choose a speech model.");
      const reason = speechModelUnavailable(value.model);
      if (reason) throw new BridgeError(reason);
      if (value.voice !== null && (typeof value.voice !== "string" || !ID.test(value.voice)))
        throw new BridgeError("Choose a supported voice.");
    }
    return { source: value.source, model: value.model, voice: value.voice } as {
      source: string;
      model: string | null;
      voice: string | null;
    };
  }
  async function read() {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 4096)
      throw new BridgeError("Read aloud settings are not a private, owned file.", 403);
    try {
      return validate(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      throw new BridgeError("Read aloud settings could not be read. Choose a source again.", 500);
    }
  }
  async function save(input: unknown) {
    const choice = validate(input);
    if (choice.source !== "local") await provider(choice.source);
    else if (choice.voice && !(await kokoro.voices?.())?.includes(choice.voice))
      throw new BridgeError("Choose an installed Kokoro voice.");
    const task = writing
      .catch(() => {})
      .then(async () => {
        const stat = await fs.lstat(home);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
          throw new BridgeError("Read aloud needs an Elpis home folder you own.", 403);
        const temporary = path.join(home, `.read-aloud-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, `${JSON.stringify(choice)}\n`, { mode: 0o600, flag: "wx" });
          await fs.rename(temporary, file);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        return choice;
      });
    writing = task;
    return task;
  }
  async function status() {
    const choice = await read();
    if (choice.source === "local") {
      if (!kokoro.available())
        return {
          ...choice,
          revision: revision(choice),
          available: false,
          reason: "Kokoro is unavailable on this computer.",
        };
      try {
        await kokoro.voices?.();
        return { ...choice, revision: revision(choice), available: true };
      } catch (error) {
        return { ...choice, revision: revision(choice), available: false, reason: (error as Error).message };
      }
    }
    try {
      await provider(choice.source);
      return { ...choice, revision: revision(choice), available: true };
    } catch (error) {
      return { ...choice, revision: revision(choice), available: false, reason: (error as Error).message };
    }
  }
  async function speak(raw: unknown, signal?: AbortSignal) {
    const input = object(raw, ["text", "revision"]) as Record<string, unknown>;
    const value = text(input.text, "read aloud text", 4000);
    if (!value.trim()) throw new BridgeError("Read aloud needs text.");
    const choice = await read();
    if (input.revision !== undefined && input.revision !== revision(choice))
      throw new BridgeError("Read aloud source changed. Try again with the selected source.", 409);
    if (choice.source === "local") return { audio: await kokoro.speak(value, choice.voice), type: "audio/wav" };
    const connection = await provider(choice.source);
    const rate = speechPcmRate(choice.model as string);
    let response;
    try {
      response = await fetchImpl(`${connection.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.key}` },
        body: JSON.stringify({
          model: choice.model,
          input: value,
          ...(choice.voice ? { voice: choice.voice } : {}),
          response_format: rate ? "pcm" : "mp3",
        }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
    } catch {
      throw new BridgeError("Read aloud could not reach the selected API provider.", 502);
    }
    if (!response.ok)
      throw new BridgeError(
        [401, 403].includes(response.status)
          ? "Read aloud API rejected the provider key."
          : `Read aloud API failed (HTTP ${response.status}).`,
        502,
      );
    const type = response.headers.get("content-type") ?? "";
    if (!(rate ? /^audio\/pcm(?:;|$)/i : /^audio\/(mpeg|mp3)(?:;|$)/i).test(type))
      throw new BridgeError("Read aloud API returned an unsupported audio format.", 502);
    if (rate) {
      const params = Object.fromEntries(
        type
          .split(";")
          .slice(1)
          .map(part =>
            part
              .trim()
              .split("=")
              .map(value => value.trim().replace(/^"|"$/g, "")),
          )
          .filter(pair => pair.length === 2)
          .map(([key, value]) => [key!.toLowerCase(), value]),
      );
      if (
        (params.rate !== undefined && Number(params.rate) !== rate) ||
        (params.channels !== undefined && Number(params.channels) !== 1)
      ) {
        await response.body?.cancel().catch(() => {});
        throw new BridgeError("Read aloud API returned an unsupported PCM format or sample rate.", 502);
      }
    }
    const audio = await audioBytes(response);
    return rate ? { audio: pcmWav(audio, rate), type: "audio/wav" } : { audio, type: "audio/mpeg" };
  }
  return { read, save, status, speak };
}
