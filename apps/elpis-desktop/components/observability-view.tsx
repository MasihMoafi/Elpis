"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SettingsNotice } from "@/components/settings/rows";
import { SearchField } from "@/components/ui/search-field";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "@/components/ui/combobox";
import { title, type Thread } from "@/lib/api";

const recency = (chat: Thread) => chat.recencyAt ?? chat.updatedAt ?? chat.createdAt ?? 0;

/** Observability is the TUI's /dashboard page (apps/elpis-trajectory, DeepSeek Harness's Trajectory tab), served by the
 * bridge with a chat's rollout (5 Nov, Masih: "it already was there", A132, R33). It opens on the selected chat; its
 * Chat menu names the chat shown and picks any other, newest first (5 Nov: "observability doesn't show which session it's
 * observing! I can't pick?"). */
export function ObservabilityView({ threadId, chats }: { threadId?: string; chats: Thread[] }) {
  const [picked, setPicked] = useState(threadId);
  const [query, setQuery] = useState("");
  useEffect(() => { if (threadId) setPicked(threadId); }, [threadId]);
  const rows = [...chats].filter(chat => !chat.parentThreadId).sort((a, b) => recency(b) - recency(a));
  const current = chats.find(chat => chat.id === picked) ?? null;
  return <div className="observability" data-view="observability" aria-label="Observability">
    <div className="observability-bar">
      <Combobox items={rows} value={current} inputValue={query} onInputValueChange={setQuery}
        itemToStringLabel={(chat: Thread) => title(chat)} itemToStringValue={(chat: Thread) => chat.id}
        onValueChange={chat => { if (chat) { setPicked(chat.id); setQuery(""); } }}>
        <ComboboxTrigger role="combobox" aria-label="Chat" className="observability-chat" title={current ? title(current) : undefined}>
          <span className="truncate">{current ? title(current) : picked ? "Chat" : "Choose a chat"}</span><ChevronDown size={16} />
        </ComboboxTrigger>
        <ComboboxContent className="observability-chat-menu">
          <SearchField variant="bare"><ComboboxInput aria-label="Search chats" placeholder="Search chats…" autoFocus /></SearchField>
          <ComboboxEmpty>No chat matches.</ComboboxEmpty>
          <ComboboxList>{(chat: Thread) => <ComboboxItem key={chat.id} value={chat} data-thread-id={chat.id}><span className="truncate pr-6">{title(chat)}</span></ComboboxItem>}</ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
    {picked ? <iframe key={picked} title="Trajectory" src={`/trajectory/index.html?thread=${encodeURIComponent(picked)}`} />
      : <SettingsNotice>Choose a chat to see its trajectory.</SettingsNotice>}
  </div>;
}
