"use client";

import { Square, Volume2 } from "lucide-react";
import { useReadAloud } from "@/components/read-aloud";
import { Button } from "@/components/ui/button";

/** While Matilda speaks, a small control stays on screen wherever he is in the app, and stops her from there (5 Nov: her voice cut when he left the board). */
export function MatildaSpeaking() {
  const speech = useReadAloud();
  if (!speech?.active) return null;
  return <div className="fixed right-4 top-14 z-50" role="status" aria-label="Matilda is speaking">
    <Button variant="outline" size="sm" onClick={() => speech.stop()} aria-label="Stop Matilda"><Volume2 size={14} aria-hidden="true" />Matilda<Square size={12} aria-hidden="true" />Stop</Button>
  </div>;
}
