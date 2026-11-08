"use client";

import { lazy, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, X, Copy, Link, Pencil, Volume2, VolumeX } from "lucide-react";
import { PinIcon, PlusIcon } from "@/components/elpis-icons";
import type { MenuAction } from "@/components/action-menu";
import type { BrowserCommand, BrowserState, BrowserTab, DesktopBrowser } from "@/lib/desktop";
import { errorText } from "@/lib/error-text.mts";

/** The desktop's built-in browser: tabs and pages live in the Electron main process. */
export function useBrowser(sessionId: string) {
  const [desktopApi, setApi] = useState<DesktopBrowser | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState("");
  const current = useRef(sessionId);
  current.current = sessionId;
  useLayoutEffect(() => {
    const browser = window.elpisDesktop?.browser;
    if (!browser) return;
    setApi(browser);
    setError("");
    let disposed = false;
    const update = (value: BrowserState) => {
      if (!disposed && (!browser.sessionScoped || value.sessionId === sessionId)) {
        setState(value);
        setError(value.error ?? "");
      }
    };
    const unsubscribe = browser.subscribe(update);
    void browser
      .command(browser.sessionScoped ? "session" : "state", browser.sessionScoped ? { sessionId } : undefined)
      .then(update)
      .catch(e => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sessionId]);
  const api = useMemo<DesktopBrowser | null>(
    () =>
      desktopApi && {
        ...desktopApi,
        command: async (action, data) => {
          const response = await desktopApi.command(action, desktopApi.sessionScoped ? { ...data, sessionId } : data);
          if (current.current !== sessionId) throw Error("This browser session is no longer shown.");
          return response;
        },
        layout: value => desktopApi.layout(desktopApi.sessionScoped ? { ...value, sessionId } : value),
      },
    [desktopApi, sessionId],
  );
  const command = useCallback(
    async (action: string, data?: BrowserCommand) => {
      if (!api) return undefined;
      setError("");
      try {
        return await api.command(action, data);
      } catch (e) {
        if (current.current === sessionId) setError(errorText(e));
        return undefined;
      }
    },
    [api, sessionId],
  );
  const closeSession = useCallback(
    (id: string) => {
      if (desktopApi?.sessionScoped)
        void desktopApi.command("sessionClose", { sessionId: id }).catch(e => setError(e.message));
    },
    [desktopApi],
  );
  const adoptSession = useCallback(
    async (from: string, to: string) => {
      if (desktopApi?.sessionScoped) await desktopApi.command("sessionAdopt", { fromSessionId: from, sessionId: to });
    },
    [desktopApi],
  );
  return {
    api,
    state: desktopApi?.sessionScoped && state?.sessionId !== sessionId ? null : state,
    error,
    command,
    closeSession,
    adoptSession,
    sessionId,
  };
}

export type Browser = ReturnType<typeof useBrowser>;

// Excalidraw is loaded only when Draw is used.
export const BrowserDrawing = lazy(() => import("@/components/browser-drawing"));

export const measure = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(Error("The screenshot could not be read."));
    image.src = src;
  });

/** Page actions share the app's icon menu. Batch operations use only the explicitly selected pages. */
export function browserTabActions(
  browser: Browser,
  tab: BrowserTab,
  options: {
    selected: BrowserTab[];
    close: () => void;
    closeOthers?: () => void;
    closeRight?: () => void;
    rename: () => void;
    pin?: () => void;
    pinned?: boolean;
  },
): MenuAction[] {
  const { selected, close, closeOthers, closeRight, rename, pin, pinned } = options;
  const page = /^https?:/.test(tab.url),
    many = selected.length > 1,
    muted = selected.every(page => page.muted);
  const batch = async (action: string, value?: boolean) => {
    for (const page of selected)
      if (!(await browser.command(action, { id: page.id, ...(value === undefined ? {} : { value }) }))) break;
  };
  return [
    ...(page && pin
      ? [{ id: "pin", label: pinned ? "Unpin from sidebar" : "Pin to sidebar", icon: <PinIcon size={16} />, run: pin }]
      : []),
    {
      id: "new",
      label: "New tab to the right",
      icon: <PlusIcon size={16} />,
      separated: !!pin && page,
      run: () => void browser.command("new", { id: tab.id }),
    },
    {
      id: "reload",
      label: many ? `Reload ${selected.length} tabs` : "Reload",
      icon: <RefreshCw size={16} />,
      run: () => void batch("reload"),
    },
    {
      id: "duplicate",
      label: many ? `Duplicate ${selected.length} tabs` : "Duplicate",
      icon: <Copy size={16} />,
      run: () => void batch("duplicate"),
    },
    ...(page
      ? [
          {
            id: "copy",
            label: "Copy URL",
            icon: <Link size={16} />,
            run: () => void browser.command("copyUrl", { id: tab.id }),
          },
          {
            id: "external",
            label: "Open in external browser",
            icon: <ExternalLink size={16} />,
            run: () => void browser.command("external", { id: tab.id }),
          },
        ]
      : []),
    { id: "rename", label: "Rename", icon: <Pencil size={16} />, separated: true, run: rename },
    {
      id: "mute",
      label: many ? `${muted ? "Unmute" : "Mute"} ${selected.length} tabs` : muted ? "Unmute tab" : "Mute tab",
      icon: muted ? <Volume2 size={16} /> : <VolumeX size={16} />,
      run: () => void batch("mute", !muted),
    },
    {
      id: "close",
      label: many ? `Close ${selected.length} tabs` : "Close tab",
      icon: <X size={16} />,
      separated: true,
      run: close,
    },
    ...(closeOthers ? [{ id: "closeOthers", label: "Close other tabs", icon: <X size={16} />, run: closeOthers }] : []),
    ...(closeRight
      ? [{ id: "closeRight", label: "Close tabs to the right", icon: <X size={16} />, run: closeRight }]
      : []),
  ];
}
