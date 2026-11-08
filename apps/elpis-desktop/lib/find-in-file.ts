import type { ChangeEvent, KeyboardEvent } from "react";

/** The find field's typing and Enter/Shift+Enter behaviour, shared by both file editors. */
export function findFieldEvents<Find extends { query: string; at: number }>(
  find: Find,
  setFind: (next: Find) => void,
  step: (direction: 1 | -1) => void,
) {
  return {
    onChange: (event: ChangeEvent<HTMLInputElement>) => setFind({ ...find, query: event.target.value, at: 0 }),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    },
  };
}
