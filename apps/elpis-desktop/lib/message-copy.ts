// "Copy text": a message's Markdown as the words a reader sees, for the message menu. Plain regular expressions,
// enough for chat replies; "Copy as Markdown" copies the source itself.

/** Markdown without its marks: emphasis, headings, quotes, links (their text) and fences (their code) are unwrapped. */
export function plainText(markdown: string): string {
  const code: string[] = [];
  const kept = (value: string) => `\u0000${code.push(value) - 1}\u0000`;
  return markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/gm, (_, __, body: string) => kept(body))
    .replace(/`([^`\n]+)`/g, (_, body: string) => kept(body))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^ {0,3}>[ \t]?/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)])
    .trim();
}
