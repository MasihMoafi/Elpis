"use client";

import { useMood, useHerVoice } from "./matilda-voice";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMatildaMiniChat } from "@/components/matilda-mini-chat";
import { useThemeCharacter } from "@/lib/theme-characters";
import { api, signedIn } from "@/lib/api";
import { MATILDA_CHANGED, MATILDA_CHAT_SHOWN } from "@/lib/matilda";
import { errorText } from "@/lib/error-text.mts";
import type { Companion } from "./matilda-companion-shared";

export function useCompanionState() {
  const [state, setState] = useState<Companion | null>(null);
  const [chatOpen, setChatOpen] = useState(false),
    mini = useMatildaMiniChat(chatOpen);
  const voice = useHerVoice();
  const character = useThemeCharacter();
  const mood = useMood(
    mini.posting || mini.conversation.busy,
    mini.conversation.entries.filter(entry => entry.item.type === "agentMessage").length,
    voice.call,
  );
  const suppressClick = useRef(false),
    faceRef = useRef<HTMLButtonElement>(null),
    floatRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!state?.pinned) setChatOpen(false);
  }, [state?.pinned]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(MATILDA_CHAT_SHOWN, { detail: chatOpen }));
    return () => {
      if (chatOpen) window.dispatchEvent(new CustomEvent(MATILDA_CHAT_SHOWN, { detail: false }));
    };
  }, [chatOpen]);
  // Her chat is part of her, like a pet's (29 Oct: dragging her "broke" the chatbox, which trailed and jumped as a separate
  // popover). Escape closes it and gives her the focus back; a press anywhere else closes it.
  useEffect(() => {
    if (!chatOpen) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setChatOpen(false);
        faceRef.current?.focus();
      }
    };
    const press = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-matilda-character-menu]")) return;
      if (!floatRef.current?.contains(event.target as Node)) setChatOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", press, true);
    };
  }, [chatOpen]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Pinning leaves her board on/off alone; the pinned chat works either way (1 Nov).
  const pin = () => void act("pin");
  const generation = useRef(0),
    working = useRef(false);
  const refresh = useCallback(async () => {
    if (working.current) return;
    const request = ++generation.current;
    try {
      const value = await api<Companion>("/love-spot/companion?page=global");
      if (request === generation.current) {
        setState(value);
        setError("");
      }
    } catch (cause) {
      if (request === generation.current) setError(errorText(cause, "Matilda could not load."));
    }
  }, []);
  useEffect(() => {
    let live = true,
      ready = false;
    // Loads after sign-in; a refused token is the page's one banner, not a second alert here.
    void signedIn(() => live).then(ok => {
      if (ok && live) {
        ready = true;
        void refresh();
      }
    });
    const visible = () => {
      if (ready && document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", visible);
    window.addEventListener(MATILDA_CHANGED, visible);
    return () => {
      live = false;
      generation.current++;
      window.removeEventListener("focus", visible);
      window.removeEventListener(MATILDA_CHANGED, visible);
    };
  }, [refresh]);
  async function act(action: string) {
    if (working.current && action !== "unpin") return;
    const request = ++generation.current;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await api<Companion>("/love-spot/companion", { action, page: "global" });
      if (request === generation.current) setState(value);
    } catch (cause) {
      if (request === generation.current) setError(errorText(cause, "The action could not finish."));
    } finally {
      if (request === generation.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  return {
    state,
    chatOpen,
    setChatOpen,
    mini,
    voice,
    character,
    mood,
    suppressClick,
    faceRef,
    floatRef,
    busy,
    error,
    setError,
    pin,
    act,
  };
}

export type CompanionState = ReturnType<typeof useCompanionState>;
