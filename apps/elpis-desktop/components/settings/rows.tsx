"use client";

import { createContext, useContext, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";

/** The last save's result. A failure offers to reload the saved settings; unsaved edits are only discarded then. */
export function SaveFeedback({ outcome, onReload }: { outcome: { ok: boolean; text: string } | null; onReload?: () => void }) {
  if (!outcome) return null;
  return <div className="flex flex-wrap items-center gap-2">
    <SettingsNotice tone={outcome.ok ? "status" : "alert"}>{outcome.text}</SettingsNotice>
    {!outcome.ok && onReload && <Button variant="outline" className="mt-2" onClick={onReload}>Reload settings</Button>}
  </div>;
}

/** ChatGPT-style settings building blocks: a page header, titled groups, and rows with a
 * title, a one-line description and a control on the right. */
export function SettingsHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <header className="settings-page-header"><div className="settings-page-heading"><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>;
}

/** A page's Refresh action, placed by SettingsHeader beside the title. */
export function RefreshButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <Button variant="ghost" disabled={disabled} onClick={onClick}><RefreshCw />Refresh</Button>;
}

/** A list with nothing to show: what is missing, then what to do about it. */
export function SettingsEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="settings-rows settings-empty" role="status"><strong>{title}</strong>{children}</div>;
}

export function SettingsGroup({ title, description, action, children }: { title?: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group" aria-label={title}>
    {(title || action) && <div className="settings-group-heading">{title && <h3>{title}</h3>}{action}</div>}
    {description && <p className="settings-group-description">{description}</p>}
    <div className="settings-rows">{children}</div>
  </section>;
}

export type SettingScope = "new chats" | "this chat" | "this device" | "terminal";
const ScopeContext = createContext<SettingScope | null>(null);
export function SettingsScope({ value, children }: { value: SettingScope; children: ReactNode }) {
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
type RowProps = { title: ReactNode; description?: ReactNode; children?: ReactNode; stacked?: boolean; id?: string; scope?: SettingScope };
/** One setting. Its control carries its own label. `stacked` puts a wide control (text area, list) under the text. */
export function SettingRow({ title, description, children, stacked, id, scope }: RowProps) {
  const inheritedScope = useContext(ScopeContext);
  const effectiveScope = scope ?? inheritedScope;
  return <div className={`settings-row${stacked ? " stacked" : ""}`}>
    <div className="settings-row-text"><div className="settings-row-heading"><div className="settings-row-title" id={id}>{title}</div>{effectiveScope && <span className="settings-scope">{effectiveScope}</span>}</div>{description && <div className="settings-row-description">{description}</div>}</div>
    {children && <div className="settings-row-control">{children}</div>}
  </div>;
}

/** The last row of a group with a Save button and its feedback. */
export function SettingsActions({ children, feedback }: { children: ReactNode; feedback?: ReactNode }) {
  return <div className="settings-row settings-actions"><div className="settings-row-text">{feedback}</div><div className="settings-row-control">{children}</div></div>;
}

/** Feedback under a group or row: saved, failed, or why a control is unavailable. */
export function SettingsNotice({ tone = "status", children }: { tone?: "status" | "alert"; children: ReactNode }) {
  return <p className={`settings-notice${tone === "alert" ? " alert" : ""}`} role={tone}>{children}</p>;
}

type Option<T extends string> = { value: T; label: string; disabled?: boolean; icon?: ReactNode; title?: string };
/** A small set of mutually exclusive choices shown side by side. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, className }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void; disabled?: boolean; className?: string }) {
  return <div role="radiogroup" aria-label={label} className={className ? `segmented ${className}` : "segmented"}>
    {options.map(option => <Button data-slot="segment" key={option.value} title={option.title} type="button" variant="ghost" size="sm" role="radio" aria-checked={value === option.value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.icon}{option.label}</Button>)}
  </div>;
}

/** A labelled drop-down for longer lists of choices. */
export function Choice<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: Option<T>[]; onChange: (value: T) => void; disabled?: boolean }) {
  return <OptionSelect aria-label={label} className="settings-choice" value={value} disabled={disabled} onChange={event => onChange(event.target.value as T)}>
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </OptionSelect>;
}
