/** Installs the workspace keyboard shortcuts and mouse back and forward buttons. */
import { useEffect } from "react";
import { shortcutFor } from "@/lib/shortcuts";

type Ref<T> = { current: T };
export function useGlobalShortcuts(shortcutAction: Ref<(id: string, index?: number) => void>) {
  // The mouse's side buttons go back and forward, as in a browser.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup") shortcutAction.current(event.button === 3 ? "back" : "forward");
    };
    const types = ["mousedown", "mouseup", "auxclick"] as const;
    for (const type of types) window.addEventListener(type, onMouse);
    return () => { for (const type of types) window.removeEventListener(type, onMouse); };
  }, []);
  // The ChatGPT app's shortcuts (lib/shortcuts.ts); the action reads this render's state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const hit = shortcutFor(event, typing); if (!hit) return;
      event.preventDefault(); shortcutAction.current(hit.id, hit.index);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
}
