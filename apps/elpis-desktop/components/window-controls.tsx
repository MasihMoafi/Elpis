"use client";

import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WindowControls() {
  const controls = typeof window === "undefined" ? undefined : window.elpisDesktop?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls) return;
    let useInitial = true;
    const stop = controls.onMaximized(value => {
      useInitial = false;
      setMaximized(value);
    });
    void controls.maximized().then(value => { if (useInitial) setMaximized(value); });
    return () => { useInitial = false; stop(); };
  }, [controls]);
  if (!controls) return null;
  const resize = maximized ? "Restore window" : "Maximize window";
  return (
    <div className="window-controls flex items-center gap-1 pr-1" role="group" aria-label="Window controls">
      <Button variant="ghost" size="icon-sm" aria-label="Minimize window" title="Minimize window" onClick={() => void controls.perform("minimize")}><Minus size={16} /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={resize} title={resize} onClick={() => void controls.perform("toggle-maximize")}>{maximized ? <Copy size={16} /> : <Square size={16} />}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close window" title="Close window" onClick={() => void controls.perform("close")}><X size={16} /></Button>
    </div>
  );
}
