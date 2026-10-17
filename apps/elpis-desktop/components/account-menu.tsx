"use client";

import { ChevronDown, Moon, Sun } from "lucide-react";
import { PersonIcon, SettingsIcon } from "@/components/elpis-icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useProviderUsage } from "@/components/provider-usage";

/** Who Elpis works as, from the accounts Settings > Models & accounts shows: the ChatGPT account with its plan, else the
 * Claude subscription that Elpis uses, else nobody. The row shows the part of the email before the @ (as Claude shows a
 * first name, so it fits the sidebar); the full email is its label. */
function whoIs(data: ReturnType<typeof useProviderUsage>["data"], error: string) {
  if (!data) return { name: error ? "Account" : "…", plan: null, label: "Account" };
  const { auth } = data.openai ?? {};
  if (auth?.state === "signedIn") {
    const plan = auth.plan ? auth.plan[0].toUpperCase() + auth.plan.slice(1) : null, who = auth.email || "ChatGPT account";
    return { name: auth.email?.split("@")[0] || "Signed in", plan, label: `Account: ${who}${plan ? `, ${plan} plan` : ""}` };
  }
  if (data.claude?.state === "connected" && !data.claude.signedOut) return { name: "Anthropic", plan: null, label: "Account: Claude subscription" };
  return { name: "Not signed in", plan: null, label: "Account: not signed in" };
}

/** The sidebar's bottom row, as in Claude's desktop app: an avatar, the signed-in account and its plan, and a chevron that
 * opens a small menu: Settings, Models & accounts and the theme. Signing in or out stays in Models & accounts. */
export function AccountMenu({ refreshKey, dark, onTheme, onSettings, onAccounts }: { refreshKey: number; dark: boolean; onTheme: () => void; onSettings: () => void; onAccounts: () => void }) {
  const { data, error } = useProviderUsage(refreshKey), { name, plan, label } = whoIs(data, error);
  return <DropdownMenu>
    <DropdownMenuTrigger className="account-row" aria-label={label} title={label}>
      <span className="account-avatar" aria-hidden="true">{name[0]?.toUpperCase()}</span>
      <span className="account-name">{name}</span>
      {plan && <span className="account-plan">{plan}</span>}
      <ChevronDown size={14} className="account-chevron" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="top" className="account-menu w-60">
      <DropdownMenuItem onClick={onSettings}><SettingsIcon size={15} aria-hidden="true" />Settings</DropdownMenuItem>
      <DropdownMenuItem onClick={onAccounts}><PersonIcon size={15} aria-hidden="true" />Models & accounts</DropdownMenuItem>
      <DropdownMenuItem onClick={onTheme}>{dark ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}{dark ? "Use light theme" : "Use dark theme"}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
