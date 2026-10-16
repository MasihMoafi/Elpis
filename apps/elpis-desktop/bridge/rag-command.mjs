import fs from 'node:fs';
const prompt = fs.readFileSync(new URL('./resources/rag.md', import.meta.url), 'utf8').trimEnd() + ' ';
export function ragMessage(input) {
  return /^\/rag(?:\s|$)/.test(input) ? prompt + input.slice(4).trimStart() : input;
}
