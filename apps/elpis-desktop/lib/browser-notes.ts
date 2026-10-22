/** The text the browser panel attaches for the model. The drawing note is only an instruction, so it is never shown; the
 * comments note is shown as the user's own comments, without the scaffolding the model reads (desktop/browser-annotations.cjs). */
export const DRAWING_NOTE = "Page drawing context";
export const BROWSER_COMMENTS = "Browser comments";

/** The comment texts of a "# Browser comments:" note, in order. */
export function browserComments(note: string): string[] {
  return note.split(/^## User Comment \d+[ \t]*$/m).slice(1).flatMap(block => {
    const at = block.indexOf("\nComment:\n");
    if (at < 0) return [];
    const body = block.slice(at + "\nComment:\n".length).replace(/\n*The attached image shows[\s\S]*$/, "").trim();
    return body ? [body] : [];
  });
}
