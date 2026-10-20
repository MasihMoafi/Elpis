"use client";

import { useEffect } from "react";
import { onArrowKey } from "@/lib/arrow-keys";

/** Arrow keys move between buttons everywhere (lib/arrow-keys.ts): one listener for every window the app opens. */
export function ArrowKeys() {
  useEffect(() => {
    document.addEventListener("keydown", onArrowKey);
    return () => document.removeEventListener("keydown", onArrowKey);
  }, []);
  return null;
}
