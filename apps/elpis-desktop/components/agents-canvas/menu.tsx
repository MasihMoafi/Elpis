import { useLayoutEffect, useRef, useState } from "react";
import { MenuRow } from "@/components/ui/menu-row";
import { MenuAt } from "./types";

export type MenuItem = { label: string; hint?: string; keys?: string; take: () => void };

/** A menu where the board was clicked, as ComfyUI's, Slate's and Grasshopper's: on a wire (insert agents or remove
 * it), an agent, the Mother or the empty board. ↑↓ move, Enter takes, Esc closes; Delete answers `onDelete`. */
/** Every menu that opens at a point on the board: it moves up or left until all of it shows, and scrolls only when even the
 * whole board is too short for it (Masih, 31 Oct: "these scrollbars shouldn't exist when they can not exist"). */
export function useFitted(at: { left: number; top: number }, ...changes: unknown[]) {
  const box = useRef<HTMLDivElement>(null), [place, setPlace] = useState({ left: at.left, top: at.top });
  useLayoutEffect(() => {
    const menu = box.current, area = menu?.offsetParent as HTMLElement | null;
    if (!menu || !area) return;
    const gap = 8, left = Math.max(gap, Math.min(at.left, area.clientWidth - menu.offsetWidth - gap)), top = Math.max(gap, Math.min(at.top, area.clientHeight - menu.scrollHeight - gap));
    setPlace(current => current.left === left && current.top === top ? current : { left, top });
  }, [at.left, at.top, ...changes]);
  return [box, { ...place, maxHeight: `calc(100% - ${place.top + 8}px)` }] as const;
}

export function CanvasMenu({ at, name, title, detail, items, onDelete, onClose }: { at: MenuAt; name: string; title: string; detail?: string; items: MenuItem[]; onDelete?: (() => void) | undefined; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null), [box, place] = useFitted(at, items.length);
  const move = (step: number) => {
    const buttons = [...(list.current?.querySelectorAll("button") ?? [])], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  return <div ref={box} className="quick-add hud-menu nodrag nowheel" role="menu" tabIndex={-1} aria-label={name} style={place} onContextMenu={event => event.preventDefault()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); }}
    onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if ((event.key === "Delete" || event.key === "Backspace") && onDelete) { event.preventDefault(); event.stopPropagation(); onClose(); onDelete(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <p className="hud-menu-title quick-add-title"><span>{title}</span>{detail && <span>{detail}</span>}</p>
    <div ref={list} className="quick-add-list">{items.map((item, index) => <MenuRow key={item.label} role="menuitem" autoFocus={index === 0} onClick={() => { onClose(); item.take(); }}>
      <span className="select-option">{item.label}{item.hint && <small>{item.hint}</small>}</span>{item.keys && <kbd className="kbd-hint" aria-hidden="true">{item.keys}</kbd>}</MenuRow>)}</div>
  </div>;
}