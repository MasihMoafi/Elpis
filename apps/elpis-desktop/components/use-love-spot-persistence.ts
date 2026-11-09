"use client";

import { useLoveSpotSaveState } from "./use-love-spot-save-state";
import { useLoveSpotBoardSync } from "./use-love-spot-board-sync";

export function useLoveSpotPersistence(props: Parameters<typeof useLoveSpotSaveState>[0]) {
  const {
    initial,
    error,
    setError,
    saveStatus,
    report,
    mounted,
    currentPage,
    save,
    receive,
    sendWithBoard,
    opening,
    placingScreenshot,
    changed,
    cancelScheduledSaves,
  } = useLoveSpotBoardSync(useLoveSpotSaveState(props));
  return {
    initial,
    error,
    setError,
    saveStatus,
    report,
    mounted,
    currentPage,
    save,
    receive,
    sendWithBoard,
    opening,
    placingScreenshot,
    persistChange: changed,
    cancelScheduledSaves,
  };
}
