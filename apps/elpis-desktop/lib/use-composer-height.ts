import { useLayoutEffect, type RefObject } from "react";

/** The input fits its text at every width, and scrolls only past its 240 px ceiling (29 Oct, Masih: "the scroll bar here is
 * unnecessary": a narrower window wrapped the draft onto more lines, and a fraction of a pixel showed a scrollbar).
 * `deps` are what can change its content or mount it again (the draft, the chat, the view). */
export function useComposerHeight(ref: RefObject<HTMLTextAreaElement | null>, deps: readonly unknown[]) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => {
      box.style.height = "auto";
      box.style.height = `${Math.min(240, Math.max(44, box.scrollHeight))}px`;
      box.style.overflowY = box.scrollHeight > 241 ? "auto" : "hidden";
    };
    fit();
    let width = box.clientWidth;
    const observer = new ResizeObserver(() => { if (box.clientWidth !== width) { width = box.clientWidth; fit(); } });
    observer.observe(box);
    return () => observer.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps -- the caller names what refits it
}
