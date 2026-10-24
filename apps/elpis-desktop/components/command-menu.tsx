"use client";

import { useEffect, useId, useRef, useState, type ComponentType, type RefObject } from "react";
import { ArrowRight, X } from "lucide-react";
import { ChatIcon, FolderIcon, NewChatIcon } from "@/components/elpis-icons";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { api, isAgentRun, title, unreadable, type Thread } from "@/lib/api";
import type { Project } from "@/lib/projects";
import { rankBySearch } from "@/lib/search-rank";

export type CommandAction = { id: string; name: string; keys?: string[]; run: () => void };
type Command = CommandAction & { detail?: string };
type Props = {
  threads: Thread[]; projects: Project[]; actions: CommandAction[];
  onThread: (thread: Thread) => void; onProject: (project: Project) => void;
  onNewChat: (prompt: string) => void; onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
};

/** Ctrl+K: one search for chats, projects and the app's existing actions. */
export function CommandMenu({ threads, projects, actions, onThread, onProject, onNewChat, onClose, returnFocus }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<{ query: string; data: Thread[]; loading: boolean; error: string }>({ query: "", data: [], loading: false, error: "" });
  const ran = useRef(false), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const listId = useId(), term = query.trim(), lower = term.toLowerCase();
  useEffect(() => {
    if (!term) return;
    let disposed = false;
    setSaved({ query: term, data: [], loading: true, error: "" });
    const timer = setTimeout(() => {
      api<{ data: Thread[] }>(`/threads?limit=100&searchTerm=${encodeURIComponent(term)}`)
        .then(result => {
          if (!Array.isArray(result.data)) throw unreadable("search");
          if (!disposed) setSaved({ query: term, data: result.data, loading: false, error: "" });
        })
        .catch(cause => { if (!disposed) setSaved({ query: term, data: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [term]);
  const matches = (value: string) => value.toLowerCase().includes(lower);
  threads = threads.filter(thread => !isAgentRun(thread));
  const found = new Map(threads.filter(thread => matches(`${title(thread)} ${thread.preview ?? ""} ${thread.cwd ?? ""} ${thread.agentNickname ?? ""}`)).map(thread => [thread.id, thread]));
  if (term && saved.query === term) for (const thread of saved.data) if (!isAgentRun(thread)) found.set(thread.id, thread);
  const chats = term ? rankBySearch([...found.values()], term, title, thread => `${thread.preview ?? ""} ${thread.cwd ?? ""} ${thread.agentNickname ?? ""}`) : threads.filter(thread => !thread.parentThreadId).slice(0, 8);
  const chatRows: Command[] = chats.map(thread => ({ id: `chat:${thread.id}`, name: title(thread), detail: thread.cwd, run: () => onThread(thread) }));
  const groups: { name: string; icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>; rows: Command[] }[] = [
    ...(!term ? [{ name: "Recents", icon: ChatIcon, rows: chatRows }] : []),
    { name: "Actions", icon: ArrowRight, rows: actions.filter(action => !term || matches(`${action.name} ${action.keys?.join(" ") ?? ""}`)) },
    ...(term ? [
      { name: "Chats", icon: ChatIcon, rows: chatRows },
      { name: "Projects", icon: FolderIcon, rows: projects.filter(project => matches(`${project.name} ${project.cwd}`)).map(project => ({ id: `project:${project.id}`, name: project.name, detail: project.cwd, run: () => onProject(project) })) },
      { name: "New chat", icon: NewChatIcon, rows: [{ id: "prompt", name: "New chat", detail: term, run: () => onNewChat(term) }] },
    ] : []),
  ].filter(group => group.rows.length);
  const rows = groups.flatMap(group => group.rows), active = Math.min(index, rows.length - 1);
  const activeId = active >= 0 ? `${listId}-${active}` : undefined;
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, query, saved]);
  const run = (command: Command) => { ran.current = true; onClose(); command.run(); };
  let rowIndex = 0;
  return <AlertDialog open onOpenChange={open => { if (!open) onClose(); }}>
    <AlertDialogContent role="dialog" className="command-menu" initialFocus={input} finalFocus={() => ran.current ? false : returnFocus.current} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey) { const search = actions.find(action => action.id === "search"); if (search) run(search); }
        else onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); if (rows.length) setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
      } else if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); if (rows[active]) run(rows[active]); }
    }}>
      <div className="flex items-center justify-between"><AlertDialogTitle>Command menu</AlertDialogTitle><Button variant="ghost" size="icon-sm" aria-label="Close command menu" onClick={onClose}><X size={16} /></Button></div>
      <SearchField ref={input} role="combobox" aria-label="Search or start a chat" placeholder="Search or start a chat" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeId} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} />
      <div ref={list} id={listId} role="listbox" aria-label="Commands" className="command-list">
        {groups.map(({ name, icon: Icon, rows: commands }) => <section key={name} role="group" aria-label={name}>
          <h3 className="hud-label">{name}</h3>
          {commands.map(command => {
            const at = rowIndex++;
            return <div key={command.id} id={`${listId}-${at}`} role="option" aria-selected={at === active} className="command-row" onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
              <Icon size={16} aria-hidden={true} /><span className="command-copy"><span className="command-name">{command.name}</span>{command.detail && <span className="command-detail">{command.detail}</span>}</span>
              {command.keys?.length && <span className="shortcut-keys">{command.keys.map(keys => <kbd key={keys} className="kbd">{keys}</kbd>)}</span>}
            </div>;
          })}
        </section>)}
      </div>
      {term && saved.query === term && saved.loading && <p role="status" className="text-xs text-muted-foreground">Searching saved chats…</p>}
      {term && saved.query === term && saved.error && <p role="alert" className="text-xs text-destructive">Could not search saved chats: {saved.error}</p>}
      <p className="command-help text-xs text-muted-foreground">↑ ↓ to move · Enter to open · Esc to close</p>
    </AlertDialogContent>
  </AlertDialog>;
}
