/** A long message is parsed one bounded part at a time. A continued code fence
 * keeps its language, while Copy code still refers to the original complete block. */
export type MarkdownFence = { marker: string; info: string; body: number };
export type MarkdownPosition = { start: number; fence: MarkdownFence | null };
const PART = 8000;

function fences(text: string, offset: number, continued: MarkdownFence | null) {
  let active = continued;
  const blocks: { offset: number; fence: MarkdownFence }[] = continued ? [{ offset: 0, fence: continued }] : [];
  for (let at = 0; at < text.length;) {
    const newline = text.indexOf("\n", at),
      end = newline < 0 ? text.length : newline;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(text.slice(at, end));
    if (match) {
      const marker = match[1]!,
        info = match[2]!.trim();
      if (!active) {
        active = { marker, info, body: offset + (newline < 0 ? end : end + 1) };
        blocks.push({ offset: at, fence: active });
      } else if (marker[0] === active.marker[0] && marker.length >= active.marker.length && !info) active = null;
    }
    at = end + 1;
  }
  return { active, blocks };
}

export function markdownPage(text: string, position: MarkdownPosition) {
  const { start, fence } = position;
  let end = Math.min(text.length, start + PART);
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline > start + PART / 2) end = newline + 1;
    // A forced break must not split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  }
  const raw = text.slice(start, end),
    parsed = fences(raw, start, fence);
  const prefix = fence ? `${fence.marker}${fence.info}\n` : "";
  return {
    source: prefix + raw + (parsed.active ? `\n${parsed.active.marker}` : ""),
    next: end < text.length ? { start: end, fence: parsed.active } : null,
    codeSource(rendered: string, offset: number): string | undefined {
      const renderedBlocks = fences(rendered, 0, null).blocks;
      const index = renderedBlocks.findIndex(block => block.offset === offset);
      const block = parsed.blocks[index]?.fence;
      if (!block) return undefined;
      // Scan the rest only on an explicit copy, never during paint or parsing.
      let end = text.length;
      for (let at = block.body; at < text.length;) {
        const newline = text.indexOf("\n", at),
          lineEnd = newline < 0 ? text.length : newline;
        const line = text.slice(at, lineEnd).trim();
        if (line.startsWith(block.marker) && /^(?:`+|~+)$/.test(line)) {
          end = at;
          break;
        }
        at = lineEnd + 1;
      }
      return text.slice(block.body, end).replace(/\r?\n$/, "");
    },
  };
}
