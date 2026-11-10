/** Tells every chat transcript that the person means to move it (send, jump): a restored reading place stops holding
 * the view (lib/use-transcript-presentation.ts). */
export const SCROLL_INTENT = "elpis-scroll-intent";

export function announceScrollIntent() {
  for (const scroller of document.querySelectorAll(".chat-scroll")) scroller.dispatchEvent(new Event(SCROLL_INTENT));
}
