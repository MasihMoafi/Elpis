import { browserComments } from "@/lib/browser-notes";

/** What the user wrote on the page, as a numbered list: the note the model also gets stays out of sight. */
export function BrowserComments({ text }: { text: string }) {
  const comments = browserComments(text);
  return comments.length ? <ol aria-label="Browser comments" dir="auto" className="list-decimal space-y-1 pl-5">{comments.map((comment, index) => <li key={index} className="whitespace-pre-wrap break-words">{comment}</li>)}</ol> : null;
}
