"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Children, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import "@/components/step.css";

/** Close the nearest disclosure and bring its header back into view, keeping keyboard focus usable. */
export function CollapseDetails({ label }: { label: string }) {
  return <Button type="button" variant="ghost" size="sm" className="tool-collapse" onClick={event => {
    const details = event.currentTarget.closest('details');
    const summary = details?.querySelector<HTMLElement>(':scope > summary');
    if (!details || !summary) return;
    details.open = false;
    summary.focus({ preventScroll: true });
    summary.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}><ChevronUp size={14} aria-hidden="true" />{label}</Button>;
}

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
    <DisclosureSummary className="step-head">{head}</DisclosureSummary>
    {shown && <div className="step-card">{body}<CollapseDetails label="Collapse details" /></div>}
  </details>;
}
