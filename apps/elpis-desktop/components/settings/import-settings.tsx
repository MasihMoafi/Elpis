"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, unreadable } from "@/lib/api";
import { SettingRow, SettingsEmpty, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

type Listing = { days: number; atATime: number; sources: { id: string; name: string; chats: number }[] };
type Outcome = { source: string; imported: number; skipped: string[] };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Settings → Import chats, as in Cloudroom: Claude Code chats become chats of Elpis, with their history; the originals stay untouched. */
export function ImportSettings({ onImported }: { onImported?: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(""), [outcome, setOutcome] = useState<Outcome | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await api<Listing>("/import-chats");
      if (!Array.isArray(data.sources)) throw unreadable("the chats to import");
      setListing(data); setError("");
    } catch (cause) { setError(message(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function run(id: string, name: string) {
    setBusy(id); setOutcome(null); setError("");
    try {
      const result = await api<{ imported: number; skipped: string[] }>("/import-chats", { source: id });
      setOutcome({ source: name, imported: result.imported, skipped: result.skipped ?? [] });
      if (result.imported) onImported?.();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(""); await load(); }
  }
  return <>
    <SettingsHeader title="Import chats" description="Bring your Claude Code chats over as Elpis chats. They keep their full history, and your originals stay untouched." />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {listing && (listing.sources.length ? <SettingsGroup>
      {listing.sources.map(source => <SettingRow key={source.id} title={source.name} description={`${plural(source.chats, "chat")} from the last ${listing.days} days${source.chats > listing.atATime ? `; ${listing.atATime} at a time` : ""}.`}>
        <Button variant="outline" aria-label={`Import ${source.name} chats`} disabled={!!busy} onClick={() => void run(source.id, source.name)}>{busy === source.id ? "Importing…" : `Import ${Math.min(source.chats, listing.atATime)}`}</Button>
      </SettingRow>)}
    </SettingsGroup> : !outcome && <SettingsEmpty title="No chats to import">{`No new Claude Code chats from the last ${listing.days} days.`}</SettingsEmpty>)}
    {outcome && <SettingsNotice tone={outcome.imported || !outcome.skipped.length ? "status" : "alert"}>
      {`Imported ${plural(outcome.imported, "chat")} from ${outcome.source}.${outcome.skipped.length ? ` ${outcome.skipped.length} skipped: ${outcome.skipped[0]}` : ""}`}
    </SettingsNotice>}
  </>;
}
