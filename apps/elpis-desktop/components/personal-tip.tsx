"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type PersonalStatus = { path: string; showTip: boolean };

export function usePersonal(ready: boolean, onOpen: (path: string) => void, onError: (message: string) => void) {
  const [showTip, setShowTip] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const refresh = () => { void api<PersonalStatus>("/personal").then(status => { if (active) setShowTip(status.showTip); }).catch(() => {}); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [ready]);
  async function act(action: "open" | "dismiss") {
    try {
      const status = await api<PersonalStatus>("/personal", { action });
      setShowTip(status.showTip);
      if (action === "open") onOpen(status.path);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return { showTip, open: () => void act("open"), dismiss: () => void act("dismiss") };
}

export function PersonalTip({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return <div className="mt-4 flex max-w-full items-center justify-center gap-1 text-muted-foreground">
    <Button variant="link" size="sm" className="min-w-0 whitespace-normal text-muted-foreground" onClick={onOpen}>Tell Elpis how you work: /personal</Button>
    <Button variant="ghost" size="icon-xs" aria-label="Dismiss personal tip" onClick={onDismiss}><X /></Button>
  </div>;
}
