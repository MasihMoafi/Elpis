"use client";

import { Input } from "@/components/ui/input";
import { PROFILE_NAME_MAX } from "@/lib/preferences";

/** The name Elpis uses for the user; shared by the first-launch prompt and Settings → General. */
export function ProfileFields({ name, onName, onNameCommit, autoFocus }: { name: string; onName: (name: string) => void; onNameCommit?: () => void; autoFocus?: boolean }) {
  return <Input aria-label="Your name" placeholder="Your name" maxLength={PROFILE_NAME_MAX} value={name} autoFocus={autoFocus} onChange={event => onName(event.target.value)} onBlur={onNameCommit} />;
}
