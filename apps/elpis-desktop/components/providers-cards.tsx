"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  openAuthPage,
  type ProviderConfigItem as ProviderConfig,
  type ProviderConfigsSnapshot as ProviderConfigs,
} from "@/lib/provider-login";
import { type ConfiguredProvider as Configured } from "@/components/provider-usage";
import { errorText } from "@/lib/error-text.mts";

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const State = ({ tone, children }: { tone: "ok" | "warn" | "off"; children: React.ReactNode }) => (
  <span className={`settings-badge ${tone}`}>{children}</span>
);

export function Card({
  id,
  name,
  state,
  children,
}: {
  id: string;
  name: string;
  state: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="provider-card settings-card" data-provider={id} aria-label={name}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3>{name}</h3>
        <span className="settings-scope mr-auto">this device</span>
        {state}
      </header>
      {children}
    </section>
  );
}

/** Each key lists the features it can be used for (`uses`), ticked where it is. */
export function ConfiguredList({
  items,
  empty,
  config,
  onEdit,
  uses,
}: {
  items: Configured[];
  empty: string;
  config: ProviderConfigs | null;
  onEdit: (provider: ProviderConfig) => void;
  uses: (provider: ProviderConfig) => React.ReactNode;
}) {
  if (!items.length) return <p className="provider-note">{empty}</p>;
  return (
    <ul className="grid gap-3">
      {items.map(item => {
        const provider = config?.providers.find(provider => provider.id === item.id);
        return (
          <li key={item.id} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 break-all">
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground"> · {item.baseUrl ?? "no base URL"}</span>
              </p>
              {provider && (
                <Button
                  variant="outline"
                  disabled={!config?.write?.available || !provider.editable}
                  onClick={() => onEdit(provider)}
                >
                  Edit {item.name}
                </Button>
              )}
            </div>
            {(item.envKey || provider?.auth.keySet) && (
              <p className="mt-1 text-xs text-muted-foreground">
                API key {item.keySet || provider?.auth.keySet ? "set" : "not set"}
              </p>
            )}
            {provider && uses(provider)}
          </li>
        );
      })}
    </ul>
  );
}

export type Cloudroom = {
  signedIn: boolean;
  signingIn: boolean;
  email?: string;
  kind?: "vm" | "sandbox";
  error?: string | null;
  url?: string;
  vm?: {
    state: "awake" | "asleep" | "signed_out" | "error";
    message?: string;
    claude?: { installed: boolean; signedIn: boolean };
    codex?: { installed: boolean; signedIn: boolean };
  };
};

export const cli = (name: string, value?: { installed: boolean; signedIn: boolean }) =>
  `${name} ${!value?.installed ? "not installed" : value.signedIn ? "signed in" : "not signed in"}`;

/** His CloudRoom VM (1 Nov): workflow agents can run there. Elpis signs in through cloudroom.dev itself; no CloudRoom app. */
export function CloudroomCard() {
  const [data, setData] = useState<Cloudroom | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setData(await api<Cloudroom>("/providers/cloudroom"));
  }, []);
  useEffect(() => {
    void load().catch(e => setError(errorText(e)));
  }, [load]);
  useEffect(() => {
    if (!data?.signingIn) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [data?.signingIn, load]);
  async function action(action: "signIn" | "status" | "signOut") {
    setBusy(true);
    setError("");
    try {
      const next = await api<Cloudroom>("/providers/cloudroom", { action });
      setData(next);
      if (next.url) await openAuthPage(next.url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const vm = data?.vm;
  return (
    <Card
      id="cloudroom"
      name="CloudRoom VM"
      state={
        !data ? (
          <State tone="off">Reading…</State>
        ) : data.signedIn ? (
          <State tone="ok">Signed in</State>
        ) : (
          <State tone="off">Not signed in</State>
        )
      }
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {data.error}
        </p>
      )}
      <p className="provider-note">
        {data?.signedIn
          ? `${data.email}${data.kind === "sandbox" ? " · cloud sandbox" : ""}. Workflows can run their agents here: choose CloudRoom VM under Runs on in the Mother agent panel.`
          : "Sign in with your CloudRoom subscription to run workflow agents on your CloudRoom VM."}
      </p>
      {vm && (
        <p role="status" className="provider-note">
          {vm.state === "awake"
            ? `VM awake · ${cli("Claude Code", vm.claude)} · ${cli("Codex", vm.codex)}`
            : vm.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {data?.signedIn ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void action("status")}>
              {busy ? "Checking…" : "Check status"}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void action("signOut")}>
              Sign out
            </Button>
          </>
        ) : (
          <Button disabled={busy || !data || data.signingIn} onClick={() => void action("signIn")}>
            {data?.signingIn ? "Waiting for sign-in…" : "Sign in"}
          </Button>
        )}
        {data?.signingIn && (
          <span role="status" className="self-center text-sm text-muted-foreground">
            Complete sign-in in the page that opened.
          </span>
        )}
      </div>
    </Card>
  );
}
