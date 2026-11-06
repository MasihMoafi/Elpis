/** Models write math as \( … \) and \[ … \] as often as $ … $ and $$ … $$; remark-math reads only dollars, so the
 * bracket forms become dollars everywhere except inside code, and a line that is only $$ … $$ is a display formula. */
export function dollarMath(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[") && !text.includes("$$")) return text;
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part
    .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, math: string) => `$$\n${math.trim()}\n$$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math.trim()}$`)).join("");
}
