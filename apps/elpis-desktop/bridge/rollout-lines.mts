import fs from 'node:fs/promises';

const CHUNK = 64 * 1024;
const MAX_LINE = 256 * 1024;

/** Metadata only: scan a bounded suffix newest first, skipping oversized records without joining them.
 * Message payloads are read by the engine's paged history API, never by this reader. */
export async function* reverseRolloutLines(file: string, limit = 8 * 1024 * 1024) {
  const handle = await fs.open(file, 'r');
  try {
    let end = (await handle.stat()).size, scanned = 0, carry = Buffer.alloc(0), skipping = false;
    while (end > 0 && scanned < limit) {
      const start = Math.max(0, end - Math.min(CHUNK, limit - scanned));
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const data = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      carry = Buffer.alloc(0);
      let stop = data.length;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 10) continue;
        if (!skipping && stop - index - 1 <= MAX_LINE) yield data.toString('utf8', index + 1, stop);
        skipping = false; stop = index;
      }
      if (start === 0) {
        if (!skipping && stop <= MAX_LINE) yield data.toString('utf8', 0, stop);
      } else if (!skipping && stop <= MAX_LINE) carry = Buffer.from(data.subarray(0, stop));
      else skipping = true;
      scanned += end - start; end = start;
    }
  } finally { await handle.close(); }
}
