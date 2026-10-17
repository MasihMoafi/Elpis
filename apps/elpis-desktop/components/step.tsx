"use client";

import { Children, useState, type ReactNode } from "react";
import "@/components/step.css";

/** One step of agent work as a row of an opened group, as Claude's desktop app draws them: a sentence, its time or its
 * +N −M at the right, and a bordered card that opens under it. Commands, tools, searches, edits and reasoning all draw
 * this, so they read as one kind of row. A step with nothing to open is the row alone. The card is built only while it
 * is open, so a long diff costs nothing until it is asked for. */
export function Step({ title, meta, body, open = false, failed = false }: { title: ReactNode; meta?: ReactNode; body?: ReactNode; open?: boolean; failed?: boolean }) {
  const [shown, setShown] = useState(open);
  const head = <><span className="step-title">{title}</span>{meta ? <span className="step-meta">{meta}</span> : null}</>;
  const className = `step${failed ? " failed" : ""}`;
  if (Children.toArray(body).length === 0) return <div className={className}><div className="step-head">{head}</div></div>;
  return <details className={className} open={open} onToggle={event => setShown(event.currentTarget.open)}>
    <summary className="step-head">{head}</summary>
    {shown && <div className="step-card">{body}</div>}
  </details>;
}
