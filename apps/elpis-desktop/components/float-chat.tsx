"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stateLabels } from "@/lib/agents";

/** The strip on top of the floating chat (full view): the chat's name, and the button that folds the card into its pill. */
export function FloatChatBar({ title, onCollapse }: { title: string; onCollapse: () => void }) {
  return <div className="float-chat-bar">
    <span className="float-chat-title" title={title}>{title}</span>
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Collapse floating chat" title="Collapse floating chat" onClick={onCollapse}><ChevronDown size={15} /></Button>
  </div>;
}

/** The folded floating chat: its name and state (the same dot and words as the Agents list); a click brings the card back. */
export function FloatChatPill({ title, state, onRestore }: { title: string; state: keyof typeof stateLabels; onRestore: () => void }) {
  return <Button type="button" variant="outline" size="sm" className="float-chat-pill" aria-label={`Restore floating chat: ${title}`} onClick={onRestore}>
    <span className={`agent-state ${state}`}><i aria-hidden="true" />{stateLabels[state]}</span>
    <span className="float-chat-pill-title">{title}</span>
  </Button>;
}
