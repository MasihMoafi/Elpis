"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  holdChatOrder,
  staysWithChatList,
  isDefaultView,
  type ChatGroups,
  type SortBy,
} from "@/lib/chat-groups";

/** Hold positions from pointer entry through exit, or release outside after a held click. Statuses still render
 * immediately. Explicit group/sort/drag commands may release the order. No timers or polling. */
export function useChatListOrder<T extends { id: string }>(chats: T[]) {
  const [held, setHeld] = useState<string[] | null>(null),
    inside = useRef(false),
    pressed = useRef(false),
    dragging = useRef(false);
  const list = useRef<Element | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = () => {
    clearTimeout(timer.current);
    setHeld(null);
  };
  // A real exit releases after a moment, so crossing an edge never re-sorts the rows twice in a row.
  const leave = () => {
    inside.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!inside.current && !pressed.current) setHeld(null);
    }, 300);
  };
  useEffect(() => {
    if (!inside.current && !pressed.current) return;
    setHeld(previous => {
      if (!previous) return chats.map(chat => chat.id);
      const known = new Set(previous),
        added = chats.filter(chat => !known.has(chat.id)).map(chat => chat.id);
      return added.length ? [...previous, ...added] : previous;
    });
  }, [chats]);
  useEffect(() => {
    const start = () => {
      pressed.current = true;
    };
    const end = () => {
      pressed.current = false;
      dragging.current = false;
      if (!inside.current) setHeld(null);
    };
    const drag = () => {
      dragging.current = true;
    };
    const cancel = () => {
      if (!dragging.current) end();
    };
    const blur = () => {
      inside.current = false;
      end();
    };
    // Leaving through a row's tooltip or menu sends no pointerleave later: the first move onto anything else ends the hold.
    const over = (event: Event) => {
      const target = event.target as Element | null;
      if (inside.current && !list.current?.contains(target) && !staysWithChatList(target)) leave();
    };
    window.addEventListener("pointerover", over, true);
    window.addEventListener("pointerdown", start, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("dragstart", drag, true);
    window.addEventListener("dragend", end);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", start, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("dragstart", drag, true);
      window.removeEventListener("dragend", end);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointerover", over, true);
      clearTimeout(timer.current);
    };
  }, []);
  return {
    chats: holdChatOrder(chats, held),
    holding: held !== null,
    release,
    pointer: {
      onPointerEnter: (event: PointerEvent) => {
        list.current = event.currentTarget as Element;
        clearTimeout(timer.current);
        inside.current = true;
        setHeld(previous => previous ?? chats.map(chat => chat.id));
      },
      onPointerLeave: (event: PointerEvent) => {
        if (staysWithChatList(event.relatedTarget as Element | null)) return;
        if (!pressed.current && !event.buttons) leave();
        else inside.current = false;
      },
    },
  };
}

const SORT_BY: [SortBy, string][] = [
  ["recency", "Last activity"],
  ["created", "Date created"],
  ["name", "Name"],
  ["manual", "Manual (drag or Alt+Up/Down)"],
];

/** The sidebar's sort button: Sort by Last activity,
 * Date created or Name. The menu stays open while choosing, as Claude's does; away from the defaults the button is
 * marked and the menu offers Reset to defaults. */
export function GroupAndSortMenu({
  state,
  onChange,
}: {
  state: ChatGroups;
  onChange: (change: Partial<Pick<ChatGroups, "groupBy" | "sortBy">>) => void;
}) {
  const changed = !isDefaultView(state),
    label = "Sort chats";
  const current = SORT_BY.find(([value]) => value === state.sortBy)?.[1];
  // Match the drawing width of the sidebar's filled plus icons inside the same 16px icon box.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="group-sort"
            aria-label={label}
            title={changed ? `${label}: ${current}` : label}
            data-active={changed ? "true" : undefined}
          />
        }
      >
        <ListFilter size={13} viewBox="-1 -1 26 26" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" aria-label={label}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={state.sortBy} onValueChange={value => onChange({ sortBy: value as SortBy })}>
            {SORT_BY.map(([value, name]) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {changed && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange({ sortBy: "recency" })}>
              Reset to defaults
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
