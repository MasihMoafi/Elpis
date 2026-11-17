import { useEffect, useRef } from "react";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { useLoveActivity } from "@/lib/use-love-activity";
import type { Thread } from "@/lib/api";
import type { View } from "@/lib/workspace-types";

export function useLoveWorkspace(view: View, ready: boolean, selected: Thread | null, getThreads: () => Thread[]) {
  const loveActivity = useLoveActivity(view === "loveSpot", ready, view === "chat" ? selected : null);
  const loveRef = useRef(loveActivity);
  loveRef.current = loveActivity;
  /** A Love Spot chat by id, read at event time. */
  const isLoveChatId = (id: string) =>
    loveRef.current.isLoveChat(getThreads().find(thread => thread.id === id) ?? { id });
  const selectedLoveChat = !!selected && loveActivity.isLoveChat(selected);
  const loveSpotAudioReason =
    selected && !LOVE_SPOT_AUDIO.available
      ? selectedLoveChat
        ? LOVE_SPOT_AUDIO.reason
        : !loveActivity.originsResolved
          ? LOVE_SPOT_AUDIO.pendingReason
          : undefined
      : undefined;
  return { loveActivity, loveRef, isLoveChatId, selectedLoveChat, loveSpotAudioReason };
}

/** Matilda's chat on screen reads every Love Spot reply. */
export function useReadLoveNotifications(
  chatShown: boolean,
  unread: string[],
  autoRead: (id: string) => void,
  isLoveChatId: (id: string) => boolean,
) {
  useEffect(() => {
    if (chatShown && document.visibilityState === "visible" && document.hasFocus())
      unread.filter(isLoveChatId).forEach(autoRead);
  }, [chatShown, autoRead]);
}
