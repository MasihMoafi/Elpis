"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { notificationPermission, playChime, requestNotificationPermission, sendTestNotification, type NotificationPermissionState } from "@/lib/notifications";
import { savePreferences, usePreferences, type Preferences } from "@/lib/preferences";
import { Choice, Segmented, SettingRow, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

const PERMISSION: Record<NotificationPermissionState, { label: string; tone: string; description: string }> = {
  granted: { label: "Allowed", tone: "ok", description: "Elpis can show system notifications." },
  default: { label: "Not allowed yet", tone: "warn", description: "Allow notifications so Elpis can alert you." },
  denied: { label: "Blocked", tone: "warn", description: "Notifications are blocked. Allow them for Elpis in your system or browser settings." },
  unsupported: { label: "Unavailable", tone: "", description: "This window cannot show notifications." },
};

export function NotificationSettings() {
  const preferences = usePreferences();
  const [permission, setPermission] = useState<NotificationPermissionState>("unsupported");
  const [notice, setNotice] = useState("");
  useEffect(() => { setPermission(notificationPermission()); }, []);
  const save = (patch: Partial<Preferences>) => { setNotice(""); try { savePreferences(patch); } catch (cause) { setNotice(`Could not save this preference: ${cause instanceof Error ? cause.message : String(cause)}`); } };
  const state = PERMISSION[permission];
  return <div aria-label="Notifications">
    <SettingsHeader title="Notifications" description="Alerts for chats in this app. Saved on this device." />
    <SettingsGroup title="Desktop notifications">
      <SettingRow title="Notification permission" description={state.description}>
        <span className={`settings-badge ${state.tone}`}>{state.label}</span>
        {permission === "default" && <Button size="sm" onClick={() => void requestNotificationPermission().then(setPermission)}>Allow</Button>}
        {permission === "granted" && <Button variant="outline" size="sm" onClick={() => { if (!sendTestNotification()) setNotice("The test notification could not be shown."); }}>Send test</Button>}
      </SettingRow>
      <SettingRow title="Turn completion notifications" description="Set when Elpis alerts you that a chat finished.">
        <Choice label="Turn completion notifications" value={preferences.turnNotifications} options={[{ value: "never", label: "Never" }, { value: "unfocused", label: "Only when unfocused" }, { value: "always", label: "Always" }]} onChange={turnNotifications => save({ turnNotifications })} />
      </SettingRow>
      <SettingRow title="Approval and question notifications" description="Alert you when a chat needs approval or an answer while Elpis is in the background.">
        <Switch aria-label="Approval and question notifications" checked={preferences.inputNotifications} onCheckedChange={inputNotifications => save({ inputNotifications })} />
      </SettingRow>
      <SettingRow title="Notification sound" description="Sound for finished chats, approvals and questions.">
        <Segmented label="Notification sound" value={preferences.notificationSound ? "chime" : "none"} options={[{ value: "none", label: "None" }, { value: "chime", label: "Chime" }]} onChange={value => { save({ notificationSound: value === "chime" }); if (value === "chime") playChime(); }} />
      </SettingRow>
    </SettingsGroup>
    {notice && <SettingsNotice tone="alert">{notice}</SettingsNotice>}
  </div>;
}
