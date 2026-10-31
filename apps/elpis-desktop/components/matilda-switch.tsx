"use client";
import { Switch } from "@/components/ui/switch";
import type { MatildaSettings } from "@/lib/matilda-settings";

/** The single Matilda on/off, shown wherever she can answer (the board's bar and the small chat). Off means she answers
 * nowhere and stops what she is writing. */
export function MatildaSwitch({ settings, onChange }: { settings: MatildaSettings | null; onChange: (on: boolean) => void }) {
  const on = settings?.replies !== false;
  return <label className="matilda-switch" title={on ? "Matilda answers on the board and in chat. Turn off to work undisturbed." : "Matilda is off everywhere. Turn on and she answers again."}>
    Matilda<Switch aria-label="Matilda" checked={on} disabled={!settings} onCheckedChange={onChange} />
  </label>;
}
