"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ProfileFields } from "@/components/profile-fields";
import { savePreferences, usePreferences } from "@/lib/preferences";

/** Asked once, after the window is ready, until the user answers or skips (profileAsked). The name stays editable in Settings → General. */
export function ProfileDialog({ ready }: { ready: boolean }) {
  const { profileAsked } = usePreferences();
  const [name, setName] = useState("");
  return <AlertDialog open={ready && !profileAsked} onOpenChange={() => {}}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>What should Elpis call you?</AlertDialogTitle>
        <AlertDialogDescription>Your name appears at the bottom of the sidebar. You can change it in Settings.</AlertDialogDescription>
      </AlertDialogHeader>
      <form aria-label="Your name" className="grid gap-4" onSubmit={event => { event.preventDefault(); if (name.trim()) savePreferences({ profileName: name.trim(), profileAsked: true }); }}>
        <ProfileFields name={name} onName={setName} autoFocus />
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={() => savePreferences({ profileAsked: true })}>Not now</Button>
          <Button type="submit" disabled={!name.trim()} disabledReason="Enter your name.">Save</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>;
}
