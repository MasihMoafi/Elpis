"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { api } from "@/lib/api";

type Account = { id: string; label: string; email: string | null; plan: string | null; authenticated: boolean; duplicate: boolean; signingIn: boolean; error: string | null };
type Accounts = { activeId: string; accounts: Account[]; authUrl?: string };

export function ClaudeAccountsSettings({ refreshKey, onChanged }: { refreshKey: number; onChanged?: () => Promise<void> | void }) {
  const [data, setData] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const load = useCallback(async () => { setData(await api<Accounts>("/providers/claude-accounts")); }, []);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : String(e))); }, [load, refreshKey]);
  const signingIn = data?.accounts.some(account => account.signingIn) ?? false;
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => { void load().catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [signingIn, load]);
  async function action(action: "login" | "select" | "code", id?: string) {
    setBusy(true); setError("");
    try {
      const next = await api<Accounts>("/providers/claude-accounts", { action, ...(id && { id }), ...(action === "code" && { code: code.trim() }) });
      setData(next);
      if (next.authUrl) {
        setLoginId(next.accounts.find(account => account.signingIn)?.id ?? null);
        if (window.elpisDesktop?.browser) await window.elpisDesktop.browser.command("external-url", { url: next.authUrl });
        else window.open(next.authUrl, "_blank", "noopener");
      }
      if (action === "select") await onChanged?.();
      if (action === "code") setCode("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const pending = data?.accounts.find(account => !account.authenticated || account.duplicate);
  return <div className="grid gap-3" aria-label="Claude accounts">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data && <>
      <label className="field">Claude account<OptionSelect aria-label="Claude account" value={data.activeId} disabled={busy} onChange={event => void action("select", event.target.value)}>
        {data.accounts.map(account => <option key={account.id} value={account.id} disabled={!account.authenticated || account.duplicate}>{account.email ?? account.label}{account.plan ? ` · ${account.plan}` : ""}{account.duplicate ? " · Same account" : account.authenticated ? "" : " · Sign in needed"}</option>)}
      </OptionSelect></label>
      <p className="provider-note">Switch accounts when your current account reaches its limit. Conversations stay in Elpis.</p>
      {data.accounts.some(account => account.duplicate) && <p role="alert" className="text-sm text-destructive">Both logins use the same Claude account and share its usage limit. Sign in to Claude 2 with a different account.</p>}
      {(data.accounts.length < 2 || pending) && <div><Button size="sm" variant="outline" disabled={busy || signingIn} onClick={() => void action("login", pending?.id)}>{signingIn ? "Waiting for sign-in…" : pending ? `Sign in to ${pending.label}` : "Add Claude account"}</Button></div>}
      {signingIn && <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void action("code", loginId ?? data.accounts.find(account => account.signingIn)?.id); }}>
        <label className="field">Sign-in code<Input aria-label="Claude sign-in code" type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} placeholder="Paste the code from the Claude page" /></label>
        <div><Button type="submit" size="sm" disabled={busy || !code.trim()}>Complete sign-in</Button></div>
      </form>}
      {data.accounts.filter(account => account.error).map(account => <p key={account.id} role="alert" className="text-sm text-destructive">{account.error}</p>)}
    </>}
  </div>;
}
