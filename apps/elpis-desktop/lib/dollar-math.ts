/** After a dollar: a number, then what shows it is an amount of money and not the start of a formula. */
const AMOUNT =
  /^\d[\d,]*(?:\.\d+)?(?:[kKmMbB]\b)?(?:$|\*\*|[.,;:!?)\]]+(?:\s|$)|\s+(?:\*\*|[^\s+\-=<>*/^\\×·])|\s*$|[-–]\$|\/[A-Za-z])/;

/**
 * A dollar that is not the edge of a formula is written as money: `\$`. Two rules decide. A dollar followed by a
 * number and then a word, a bold mark, the end of the sentence or a range ("$5-$10") is an amount. Of the dollars
 * left, a formula opens at one followed by a character that is not a space, and closes at the next one that follows
 * such a character and is not itself followed by a digit (Pandoc's rule); a dollar with no partner is money too.
 * Without this, "about $0.34 … around $0.70" rendered as one italic formula with its words run together (11 Nov,
 * Masih's screenshot).
 */
function money(part: string): string {
  const single = (at: number) => part[at] === "$" && part[at - 1] !== "\\" && part[at - 1] !== "$" && part[at + 1] !== "$";
  const escaped = new Set<number>();
  const dollars: number[] = [];
  for (let at = 0; at < part.length; at++) {
    if (!single(at)) continue;
    if (AMOUNT.test(part.slice(at + 1, at + 40))) escaped.add(at);
    else dollars.push(at);
  }
  for (let i = 0; i < dollars.length; i++) {
    const open = dollars[i]!;
    const opens = /\S/.test(part[open + 1] ?? "");
    const close = opens
      ? dollars.slice(i + 1).findIndex(at => {
          // A formula stays inside its paragraph.
          if (part.slice(open, at).includes("\n\n")) return false;
          return /\S/.test(part[at - 1] ?? "") && !/\d/.test(part[at + 1] ?? "");
        })
      : -1;
    if (close < 0) escaped.add(open);
    else i += close + 1;
  }
  if (!escaped.size) return part;
  return [...part].map((char, at) => (escaped.has(at) ? "\\$" : char)).join("");
}

/** Models write math as \( … \) and \[ … \] as often as $ … $ and $$ … $$; remark-math reads only dollars, so the
 * bracket forms become dollars everywhere except inside code, a line that is only $$ … $$ is a display formula, and
 * a dollar of an amount of money is no formula. */
export function dollarMath(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[") && !text.includes("$")) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, index) =>
      index % 2
        ? part
        : money(
            part
              .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, math: string) => `$$\n${math.trim()}\n$$`)
              .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
              .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => `$${math.trim()}$`),
          ),
    )
    .join("");
}
