import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** The Session Manager is always on and has no switch, chat or view (R43, R47). A second after the app connects, and after
 * each finished turn or change to the chats Masih protects, the bridge names chats whose title says nothing and archives the
 * ones that no longer need him (bridge/session-manager.mjs). The engine announces every rename and archive, so the chat list
 * follows by itself. */
export function useSessionManager(ready: boolean, protectedIds: string[], onError: (message: string) => void) {
  const [revision, setRevision] = useState(0);
  const failed = useRef(onError);
  failed.current = onError;
  const key = JSON.stringify([...new Set(protectedIds)].sort());
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void api("/session-manager", { protectedIds: JSON.parse(key) as string[] })
        .catch(cause => failed.current(`The Session Manager could not check the chats: ${cause instanceof Error ? cause.message : String(cause)}`));
    }, 1000);
    return () => clearTimeout(timer);
  }, [ready, key, revision]);
  return useCallback(() => setRevision(value => value + 1), []);
}
