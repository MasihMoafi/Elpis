"use client";

import { AVATARS, avatarSrc } from "@/lib/avatars";
import { Input } from "@/components/ui/input";
import { PROFILE_NAME_MAX } from "@/lib/preferences";

/** The name Elpis uses for the user and the avatar beside it; shared by the first-launch prompt and Settings → General. */
export function ProfileFields({ name, avatar, onName, onAvatar, onNameCommit, autoFocus }: {
  name: string; avatar: string; onName: (name: string) => void; onAvatar: (avatar: string) => void; onNameCommit?: () => void; autoFocus?: boolean;
}) {
  return <div className="grid gap-3">
    <Input aria-label="Your name" placeholder="Your name" maxLength={PROFILE_NAME_MAX} value={name} autoFocus={autoFocus} onChange={event => onName(event.target.value)} onBlur={onNameCommit} />
    <div role="radiogroup" aria-label="Your avatar" className="flex flex-wrap gap-2">
      {AVATARS.map(item => <button key={item.id} type="button" role="radio" aria-checked={avatar === item.id} aria-label={item.label} title={item.label} data-avatar={item.id}
        className="avatar-choice" onClick={() => onAvatar(avatar === item.id ? "" : item.id)}>
        <img src={avatarSrc(item.id)} alt="" width={44} height={44} loading="lazy" decoding="async" />
      </button>)}
    </div>
  </div>;
}
