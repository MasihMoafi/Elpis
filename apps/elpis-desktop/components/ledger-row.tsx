import type { ReactNode } from "react";
import { SettingsNotice } from "@/components/settings/rows";

export function Description({ text }: { text: string }) {
  return <span className="customize-description" title={text}>{text}</span>;
}

/** Installed and catalog entries share the Ledger's existing row and theme. */
export function LedgerRow({ name, description, badge, error, notice, children }: { name: string; description?: string; badge?: string; error?: string; notice?: string; children: ReactNode }) {
  return <li className="customize-item">
    <div className="customize-text"><span className="customize-name break-words">{name}</span>{description && <Description text={description} />}
      {notice && <SettingsNotice>{notice}</SettingsNotice>}{error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    </div>
    {badge && <span className="customize-badge max-w-40 truncate" title={badge}>{badge}</span>}
    {children}
  </li>;
}
