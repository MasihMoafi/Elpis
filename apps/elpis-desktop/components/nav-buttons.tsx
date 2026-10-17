"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Back and Forward beside the sidebar button, as in Claude's desktop app: the chats and pages visited (lib/nav-history.ts). */
export function NavButtons({ canBack, canForward, onBack, onForward }: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void }) {
  return <>
    <Button variant="ghost" size="icon" aria-label="Back" title="Back (Alt+Left)" disabled={!canBack} onClick={onBack}><ArrowLeft /></Button>
    <Button variant="ghost" size="icon" aria-label="Forward" title="Forward (Alt+Right)" disabled={!canForward} onClick={onForward}><ArrowRight /></Button>
  </>;
}
