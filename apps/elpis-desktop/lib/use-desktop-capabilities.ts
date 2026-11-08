"use client";

import { useEffect, useState } from "react";

/** The desktop window's session-window opener: its own, or its parent's when this page is a pane inside it. */
export const sessionWindowApi = () =>
  window.elpisDesktop?.openSessionWindow ??
  (window.parent !== window && new URLSearchParams(location.search).get("pane") === "1"
    ? window.parent.elpisDesktop?.openSessionWindow
    : undefined);

/** What the Electron shell offers this page: a browser (the side panel), session windows, terminals. All false in a plain
 * browser tab and on the first render, so the server-rendered page matches. */
export function useDesktopCapabilities() {
  const [abilities, setAbilities] = useState({ desktop: false, windowAvailable: false, hasTerminal: false });
  useEffect(() => {
    setAbilities({
      desktop: !!window.elpisDesktop?.browser,
      windowAvailable: !!sessionWindowApi(),
      hasTerminal: !!window.elpisDesktop?.terminal,
    });
  }, []);
  return abilities;
}
