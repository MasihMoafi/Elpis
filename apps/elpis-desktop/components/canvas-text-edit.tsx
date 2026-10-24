"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/** One inline edit: Enter or blur commits once; Escape closes without changing the graph. */
export function CanvasTextEdit({ value, label, maxLength, onSave, onCancel }: { value: string; label: string; maxLength: number; onSave: (value: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value), field = useRef<HTMLInputElement>(null), finished = useRef(false);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const save = () => { if (finished.current) return; finished.current = true; onSave(text.trim()); };
  return <Input ref={field} className="canvas-text-edit nodrag nowheel" aria-label={label} value={text} maxLength={maxLength} onChange={event => setText(event.target.value)}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onBlur={save} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); save(); }
      else if (event.key === "Escape") { event.preventDefault(); finished.current = true; onCancel(); }
    }} />;
}
