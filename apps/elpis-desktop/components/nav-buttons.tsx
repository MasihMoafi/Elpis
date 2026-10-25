"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortcutTitle } from "@/lib/shortcuts";
import type { Preferences } from "@/lib/preferences";

/** Back and Forward beside the sidebar button, as in Claude's desktop app: the chats and pages visited (lib/nav-history.ts). */
export function NavButtons({ canBack, canForward, onBack, onForward, preferences }: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; preferences: Pick<Preferences, "shortcutBindings"> }) {
  return <>
    <Button variant="ghost" size="icon" aria-label="Back" title={shortcutTitle("Back", "back", preferences)} disabled={!canBack} onClick={onBack}><ArrowLeft /></Button>
    <Button variant="ghost" size="icon" aria-label="Forward" title={shortcutTitle("Forward", "forward", preferences)} disabled={!canForward} onClick={onForward}><ArrowRight /></Button>
  </>;
}
