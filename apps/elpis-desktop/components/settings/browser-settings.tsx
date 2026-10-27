"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsHeader, SettingRow, SettingsNotice } from "@/components/settings/rows";
import { useBrowserPins } from "@/lib/browser-pins";

export function BrowserSettings({ onOpen }: { onOpen?: (url?: string) => void }) {
  const [available, setAvailable] = useState(false), [error, setError] = useState("");
  const saved = useBrowserPins(setError);
  useEffect(() => setAvailable(Boolean(window.elpisDesktop?.browser)), []);
  return <>
    <SettingsHeader title="Browser" description="Elpis has its own browser. Sign in to websites there; browser tabs belong to the current chat." />
    <SettingsGroup title="Built-in browser">
      <SettingRow title="Browse with Elpis" description="Agents use Elpis’s native browser tools. A separate ChatGPT browser skill is not required.">
        <Button variant="outline" disabled={!available || !onOpen} onClick={() => onOpen?.()}>Open browser</Button>
      </SettingRow>
    </SettingsGroup>
    {saved.pins.length > 0 && <SettingsGroup title="Pinned websites">
      {saved.pins.map(pin => <SettingRow key={pin.url} title={pin.title} description={pin.url}>
        <Button variant="ghost" disabled={!available || !onOpen} onClick={() => onOpen?.(pin.url)}>Open</Button>
        <Button variant="ghost" onClick={() => void saved.toggle(pin)}>Unpin</Button>
      </SettingRow>)}
    </SettingsGroup>}
    {!available && <SettingsNotice>Open the desktop app to use the built-in browser.</SettingsNotice>}
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
  </>;
}
