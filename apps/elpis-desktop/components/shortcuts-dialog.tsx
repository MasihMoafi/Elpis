"use client";

import { useState, type RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SHORTCUTS } from "@/lib/shortcuts";

/** Ctrl+/ — the ChatGPT app's searchable shortcut list, limited to what Elpis implements. */
export function ShortcutsDialog({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().trim();
  const shown = SHORTCUTS.filter(item => !terms || `${item.label} ${item.keys.join(" ")}`.toLowerCase().includes(terms));
  return <AlertDialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setQuery(""); }}>
    <AlertDialogContent className="shortcuts-dialog" finalFocus={returnFocus}>
      <div className="flex items-center justify-between"><AlertDialogTitle>Keyboard shortcuts</AlertDialogTitle><Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => onOpenChange(false)}><X size={16} /></Button></div>
      <SearchField aria-label="Search keyboard shortcuts" placeholder="Search shortcuts" value={query} onChange={event => setQuery(event.target.value)} autoFocus />
      <div className="shortcuts-list">
        {(["Chat", "Navigation", "App"] as const).map(group => {
          const rows = shown.filter(item => item.group === group);
          return rows.length > 0 && <section key={group} aria-label={group}><h3 className="hud-label">{group}</h3>
            {rows.map(item => <div key={item.id} className="shortcut-row"><span>{item.label}</span><span className="shortcut-keys">{item.keys.map(keys => <kbd key={keys} className="kbd">{keys}</kbd>)}</span></div>)}
          </section>;
        })}
        {!shown.length && <p className="text-sm text-muted-foreground">No shortcut matches.</p>}
      </div>
    </AlertDialogContent>
  </AlertDialog>;
}
