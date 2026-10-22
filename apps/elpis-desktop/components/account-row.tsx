"use client";

import { useProviderUsage } from "@/components/provider-usage";
import { usePreferences } from "@/lib/preferences";

/** Who Elpis works as, from the accounts Settings > Models & accounts shows: the ChatGPT account with its plan, else the
 * Claude subscription that Elpis uses, else nobody. The row shows the part of the email before the @ (so it fits the
 * sidebar); the full email is its label. */
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

/** The sidebar's bottom row: the first letter of the name they gave (else the account's), the name and the plan. It only shows;
 * Settings holds the name, the gear beside it opens Settings. */
export function AccountRow({ refreshKey }: { refreshKey: number }) {
  const { data, error } = useProviderUsage(refreshKey), { name, plan, label } = whoIs(data, error);
  const { profileName } = usePreferences(), shown = profileName || name;
  return <div data-slot="account-row" className="account-row" role="group" aria-label={profileName ? `${profileName}. ${label}` : label} title={label}>
    <span className="account-avatar" aria-hidden="true">{shown[0]?.toUpperCase()}</span>
    <span className="account-name">{shown}</span>
    {plan && <span className="account-plan">{plan}</span>}
  </div>;
}
