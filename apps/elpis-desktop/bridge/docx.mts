import { execFile } from "node:child_process";
import { ATTACHMENT_LIMITS } from "./attachments.mts";
import { BoundedCache } from "./bounded-cache.mts";
import { BridgeError } from "./validate.mts";

/** Pandoc reads only the supplied bytes; no document resources or original files can be changed. */
export function convertDocx(bytes: Buffer, { command = "pandoc", timeout = 5000 } = {}): Promise<Buffer> {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return Promise.reject(new BridgeError("This Word document is invalid. Open it in your document editor.", 422));
  return new Promise((resolve, reject) => {
    const child = execFile(command, ["+RTS", "-M128m", "-RTS", "--sandbox", "--from=docx", "--to=plain", "--wrap=none"],
      { encoding: "buffer", timeout, killSignal: "SIGKILL", maxBuffer: ATTACHMENT_LIMITS.fileBytes },
      (error, stdout) => {
        if (!error) resolve(stdout);
        else reject(new BridgeError(error.code === "ENOENT"
          ? "Install Pandoc to preview Word documents."
          : "This Word document could not be previewed. Open it in your document editor.", error.code === "ENOENT" ? 503 : 422));
      });
    child.stdin?.on("error", () => { /* execFile reports a converter that exited before reading its input. */ });
    child.stdin?.end(bytes);
  });
}

// Paging and document acknowledgments reuse conversion. At most two bounded documents stay in memory.
const cache = new BoundedCache<string, { key: string; text: Promise<Buffer> }>(2);
export function docxText(real: string, info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }, read: () => Promise<Buffer>) {
  const key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const known = cache.get(real);
  if (known?.key === key) return known.text;
  const text = read().then(convertDocx);
  cache.set(real, { key, text });
  void text.catch(() => { if (cache.get(real)?.text === text) cache.delete(real); });
  return text;
}

/** UTF-8 pages join exactly; line references refer to the extracted text, never compressed ZIP bytes. */
export function docxPage(bytes: Buffer, length: number, wantedPage = 0, wantedLine?: number) {
  const pages = Math.max(1, Math.ceil(bytes.length / length));
  let page = wantedPage;
  if (wantedLine !== undefined) {
    let offset = 0;
    for (let line = 1; line < wantedLine; line++) {
      const next = bytes.indexOf(10, offset);
      if (next < 0) { offset = Math.max(0, bytes.length - 1); break; }
      offset = next + 1;
    }
    page = Math.min(pages - 1, Math.floor(offset / length));
  }
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new BridgeError("Invalid file page.");
  let from = page * length, to = Math.min(bytes.length, (page + 1) * length);
  const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;
  while (from > 0 && continuation(bytes[from])) from--;
  while (to > from && continuation(bytes[to])) to--;
  let firstLine = 1;
  for (let index = 0; index < from; index++) if (bytes[index] === 10) firstLine++;
  return { content: bytes.subarray(from, to).toString("utf8"), page, pages, firstLine };
}
