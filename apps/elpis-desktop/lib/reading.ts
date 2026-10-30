// Reading options (Settings → Appearance), as Claude's desktop app has them: the transcript's text size and width, the
// interface font and a code font. They become CSS variables on the document (app/page.tsx), read by app/globals.css and
// the terminal. No value imports, so the node tests load this file as it is.

export type ReadingStep = "s" | "m" | "l";
export type InterfaceFont = "sans" | "serif";
export type ChatFont = "default" | "sans" | "serif" | "mono" | "system";
export type Reading = { transcriptSize: ReadingStep; transcriptWidth: ReadingStep; interfaceFont: InterfaceFont; codeFont: string; chatFont: ChatFont; interfaceSize: ReadingStep; codeSize: ReadingStep };

export const SANS = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const SERIF = 'ui-serif, "Iowan Old Style", "Source Serif 4", Georgia, "DejaVu Serif", serif';
export const MONO = '"JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace';
/** Medium is ChatGPT's thread size (14px text, specs/chatgpt-chat-style.md); Narrow keeps the 740px column. */
const SIZES: Record<ReadingStep, string> = { s: "13px", m: "14px", l: "16px" };
const WIDTHS: Record<ReadingStep, string> = { s: "740px", m: "900px", l: "1100px" };
const FONTS: Record<InterfaceFont, string> = { sans: SANS, serif: SERIF };
const CHAT_FONTS: Record<ChatFont, string> = {
  default: "var(--ui-font)", sans: SANS,
  serif: '"DejaVu Serif", ui-serif, serif',
  mono: '"DejaVu Sans Mono", ui-monospace, monospace',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};
const NAME_LIMIT = 80;
const ONE_NAME = /^[\p{L}\p{N} ._-]*$/u;

/** Why `name` cannot be the code font, or null: one family name, so it can be quoted safely into a font list. */
export function codeFontProblem(name: string): string | null {
  const wanted = name.trim();
  if (wanted.length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer.`;
  return ONE_NAME.test(wanted) ? null : "Use one font name: letters, digits, spaces, hyphens, underscores and dots.";
}

const step = (value: unknown, fallback: ReadingStep): ReadingStep => value === "s" || value === "m" || value === "l" ? value : fallback;
/** The CSS variables for these choices; a value that is not one of the choices, or a refused font name, is the default. */
export function readingStyle(choices: { [K in keyof Reading]?: unknown }): Record<string, string> {
  const code = typeof choices.codeFont === "string" && !codeFontProblem(choices.codeFont) ? choices.codeFont.trim() : "";
  return {
    "--interface-size": ({ s: "14px", m: "16px", l: "18px" })[step(choices.interfaceSize, "m")],
    "--code-size": ({ s: "12px", m: "13px", l: "16px" })[step(choices.codeSize, "m")],
    "--transcript-size": SIZES[step(choices.transcriptSize, "m")],
    "--transcript-width": WIDTHS[step(choices.transcriptWidth, "s")],
    "--ui-font": FONTS[choices.interfaceFont === "serif" ? "serif" : "sans"],
    "--chat-font": typeof choices.chatFont === "string" && Object.hasOwn(CHAT_FONTS, choices.chatFont) ? CHAT_FONTS[choices.chatFont as ChatFont] : CHAT_FONTS.default,
    "--mono": code ? `"${code}", ${MONO}` : MONO,
  };
}
