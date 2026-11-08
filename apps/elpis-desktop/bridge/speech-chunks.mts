/** The engine estimates ceil(UTF-8 bytes / 4). Keep every append below 900 tokens, without splitting a scalar. */
export function speechChunks(value: string) {
  const chunks = [];
  let chunk = "",
    bytes = 0,
    boundary = 0;
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > 3596) {
      const end = boundary > chunk.length / 2 ? boundary : chunk.length;
      chunks.push(chunk.slice(0, end));
      chunk = chunk.slice(end);
      bytes = Buffer.byteLength(chunk, "utf8");
      boundary = 0;
    }
    chunk += scalar;
    bytes += size;
    if (/\s/u.test(scalar)) boundary = chunk.length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
