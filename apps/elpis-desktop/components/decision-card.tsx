"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** The one card for everything Elpis asks of the person (approvals, questions, plans), as Claude's desktop app has one:
 * numbered choices, the number keys pick one, Enter takes the first, Esc takes the one marked `escape`. The keys reach
 * the card from inside it, and from the page or an empty message box for the first card on the page (`globalKeys`). */
export type Choice = {
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Esc takes this choice. */
  escape?: boolean;
  choose?: () => unknown;
  /** The choice opens a text box first, as "Deny, and tell Elpis what to do instead" and "Keep planning" do. */
  ask?: { label: string; placeholder: string; submit: string; send: (text: string) => unknown };
};
export type DecisionKeys = { count: number; pick: (index: number) => void; enter?: () => void; escape?: () => void };

type Registered = { root: RefObject<HTMLElement | null>; keys: RefObject<DecisionKeys | null>; global: boolean };
const cards: Registered[] = [];
const textField = (element: Element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element as HTMLElement).isContentEditable;
/** The message box, while it holds nothing: the card's keys win there, as Claude's do; a draft keeps them. */
const emptyComposer = (element: Element) => element instanceof HTMLTextAreaElement && element.getAttribute("aria-label") === "Message Elpis" && element.value === "";
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const inside = target?.closest("[data-decision-card]");
  let card: Registered | undefined;
  if (inside) { if (textField(target!)) return; card = cards.find(item => item.root.current === inside); }
  else if (!target || target === document.body || emptyComposer(target)) card = cards.find(item => item.global && item.root.current?.isConnected);
  const keys = card?.keys.current; if (!keys) return;
  const take = (run: () => void) => { event.preventDefault(); event.stopPropagation(); run(); };
  if (/^[1-9]$/.test(event.key) && !event.shiftKey) { const index = Number(event.key) - 1; if (index < keys.count) take(() => keys.pick(index)); }
  // Enter on a focused button inside the card presses that button.
  else if (event.key === "Enter" && !event.shiftKey && keys.enter && !(inside && target instanceof HTMLButtonElement)) take(keys.enter);
  else if (event.key === "Escape" && keys.escape) take(keys.escape);
}
function useDecisionKeys(root: RefObject<HTMLElement | null>, keys: DecisionKeys | null, global: boolean) {
  const current = useRef(keys); current.current = keys;
  useEffect(() => {
    const entry: Registered = { root, keys: current, global };
    if (!cards.length) window.addEventListener("keydown", onKey, true);
    cards.push(entry);
    return () => { cards.splice(cards.indexOf(entry), 1); if (!cards.length) window.removeEventListener("keydown", onKey, true); };
  }, [root, global]);
}

/** One numbered row. `checked` makes it a radio (question options); `shortcut` names a key that also takes it. */
export function ChoiceRow({ index, label, description, shortcut, checked, primary, disabled, onClick, rowRef }: { index?: number; label: string; description?: ReactNode; shortcut?: string; checked?: boolean; primary?: boolean; disabled?: boolean; onClick: () => void; rowRef?: (element: HTMLButtonElement | null) => void }) {
  const id = useId();
  const radio = checked !== undefined;
  return <button ref={rowRef} type="button" className="choice" data-primary={primary || undefined} disabled={disabled} onClick={onClick} aria-label={label}
    aria-describedby={description ? id : undefined} aria-keyshortcuts={index === undefined ? undefined : String(index + 1)} {...(radio ? { role: "radio", "aria-checked": checked } : {})}>
    {index === undefined ? <span className="choice-key" data-radio={radio || undefined} aria-hidden="true" /> : <kbd className="choice-key" aria-hidden="true">{index + 1}</kbd>}
    <span className="choice-text" aria-hidden="true"><span className="choice-label">{label}</span>{description && <span className="choice-note" id={id}>{description}</span>}</span>
    {checked ? <Check className="choice-end" size={15} aria-hidden="true" /> : shortcut ? <span className="choice-end choice-shortcut" aria-hidden="true">{shortcut}</span> : null}
  </button>;
}

export function DecisionCard({ title, className, choices, keys, busy, error, globalKeys = true, children, actions }: {
  title: string; className?: string; busy?: boolean; error?: string; globalKeys?: boolean; children?: ReactNode;
  /** The numbered choices; without them the card's own content (`keys`) takes the keys. */
  choices?: Choice[]; keys?: DecisionKeys; actions?: ReactNode;
}) {
  const root = useRef<HTMLElement>(null), box = useRef<HTMLTextAreaElement>(null), rows = useRef<(HTMLButtonElement | null)[]>([]);
  const [asking, setAsking] = useState<number | null>(null), [text, setText] = useState("");
  const ask = asking === null ? null : choices?.[asking]?.ask ?? null;
  useEffect(() => { if (ask) box.current?.focus(); }, [ask]);
  function back() { const from = asking; setAsking(null); setText(""); requestAnimationFrame(() => from !== null && rows.current[from]?.focus()); }
  function take(index: number) {
    const choice = choices?.[index]; if (!choice || choice.disabled || busy) return;
    if (choice.ask) { setAsking(index); setText(""); } else void choice.choose?.();
  }
  const escape = choices?.findIndex(choice => choice.escape) ?? -1;
  const ownKeys: DecisionKeys | null = busy ? null : ask ? null : choices
    ? { count: choices.length, pick: take, enter: () => take(choices.findIndex(choice => !choice.disabled)), escape: escape >= 0 ? () => take(escape) : undefined }
    : keys ?? null;
  useDecisionKeys(root, ownKeys, globalKeys);
  const send = () => { if (ask && !busy) void ask.send(text.trim()); };
  return <section ref={root} data-decision-card="" className={`decision-card${className ? ` ${className}` : ""}`} role="group" aria-label={title} tabIndex={-1}>
    <h3 className="decision-title">{title}</h3>
    {children && <div className="decision-body">{children}</div>}
    {ask ? <div className="decision-ask">
      <Textarea ref={box} aria-label={ask.label} placeholder={ask.placeholder} rows={2} value={text} disabled={busy} onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); back(); }
          else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); send(); }
        }} />
      <div className="decision-actions"><Button variant="ghost" size="sm" disabled={busy} onClick={back}>Back</Button><Button size="sm" disabled={busy} onClick={send}>{ask.submit}</Button></div>
    </div> : choices && <div className="decision-choices">{choices.map((choice, index) =>
      <ChoiceRow key={index} index={index} label={choice.label} description={choice.description} primary={index === 0} disabled={busy || choice.disabled} onClick={() => take(index)}
        shortcut={index === 0 ? "Enter" : choice.escape ? "Esc" : undefined} rowRef={element => { rows.current[index] = element; }} />)}</div>}
    {error && <p className="decision-error" role="alert">{error}</p>}
    {actions && !ask && <div className="decision-actions">{actions}</div>}
  </section>;
}
