"use client";

import { Button } from "@/components/ui/button";
import {
  type ProviderConfigItem as ProviderConfig,
  type ProviderConfigsSnapshot as ProviderConfigs,
} from "@/lib/provider-login";
import { type ConfiguredProvider as Configured } from "@/components/provider-usage";

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
