"use client";

import { useRef } from "react";
import { ConfirmDelete } from "@/components/confirm-delete";
import { isAgent, title, type Thread } from "@/lib/api";

import { errorText } from "@/lib/error-text.mts";

/** Confirms deleting chats as one decision: one chat by name, several by count. Once confirmation is off
 * ("Don’t show me this again", Settings → General) it deletes at once and opens only to show a failure.
 * `onDelete` deletes each chat for good; `trash` instead deletes them all as one step Ctrl+Z undoes (the sidebar's). */
export function DeleteChatsDialog({
  threads,
  onDelete,
  trash,
  onClose,
  alwaysConfirm,
}: {
  threads: Thread[] | null;
  onDelete?: (thread: Thread) => Promise<void>;
  trash?: (threads: Thread[]) => Promise<void>;
  onClose: () => void;
  /** Bulk deletes ask even when confirmation is off. */ alwaysConfirm?: boolean;
}) {
  const deleted = useRef(new Set<string>());
  const previous = useRef<Thread[] | null>(null);
  if (previous.current !== threads) {
    previous.current = threads;
    deleted.current.clear();
  }
  const only = threads?.length === 1 ? threads[0] : null;
  return (
    <ConfirmDelete
      request={threads}
      names={threads?.map(title) ?? []}
      noun="chat"
      {...(alwaysConfirm === undefined ? {} : { alwaysConfirm })}
      onClose={onClose}
      description={
        trash ? (
          <>
            {only
              ? isAgent(only)
                ? "This deletes this agent's chat from Elpis."
                : "This deletes the conversation and all of its agents from Elpis."
              : "This deletes these conversations and all of their agents from Elpis."}{" "}
            Chats continued from these agents are deleted too. Ctrl+Z brings {only ? "it" : "them"} back until you quit
            Elpis.
          </>
        ) : (
          <>
            {only
              ? isAgent(only)
                ? "This permanently deletes this agent's chat from Elpis."
                : "This permanently deletes the conversation and all of its agents from Elpis."
              : "This permanently deletes these conversations and all of their agents from Elpis."}{" "}
            Chats continued from these agents are deleted too. This cannot be undone.
          </>
        )
      }
      onDelete={async items => {
        if (trash) {
          await trash(items);
          return;
        }
        const queue = items.filter(thread => !deleted.current.has(thread.id));
        await Promise.all(
          Array.from({ length: Math.min(4, queue.length) }, async () => {
            for (let thread = queue.shift(); thread; thread = queue.shift()) {
              try {
                await onDelete!(thread);
              } catch (e) {
                queue.length = 0;
                throw Error(items.length > 1 ? `Could not delete “${title(thread)}”: ${message(e)}` : message(e));
              }
              deleted.current.add(thread.id);
            }
          }),
        );
      }}
    />
  );
}

export const message = (e: unknown) => errorText(e);
