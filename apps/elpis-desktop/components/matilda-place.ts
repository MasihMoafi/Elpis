import { appStorage } from "../lib/projects.ts";

/** Pinned, she floats over the app (28 Oct: "I don't like this to be here", in the title bar): drag her face to move her,
 * her corner to resize her, like Dot. Where and how big are saved as distances from the window's bottom right. */
export const FLOAT_KEY = "elpis-matilda-float-v1";

export type Place = { right: number; bottom: number; size: number };

export const SIZE = { min: 40, max: 256, step: 8 };

export const sized = (size: number) => Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)));

/** Where she was last put, in any window, or null when nothing readable is saved. */
function storedPlace(): Place | null {
  try {
    const p = JSON.parse(appStorage().getItem(FLOAT_KEY) || "null");
    if (p && [p.right, p.bottom, p.size].every(Number.isFinite))
      return { right: p.right, bottom: p.bottom, size: sized(p.size) };
  } catch {}
  return null;
}

// In the corner, clear of the side panel's Done button and the composer's send button.
export const savedPlace = (): Place => storedPlace() ?? { right: 16, bottom: 16, size: 64 };

/** Calls back with her place whenever another window (or this one) saves a new one. Every window shows her as she was
 * last put: a window opened earlier kept the size she had when it opened, and a notification that brought it forward
 * showed her big again after he had made her small (13 Nov). An unreadable or removed value changes nothing. */
export function watchSavedPlace(changed: (place: Place) => void) {
  const read = () => {
    const place = storedPlace();
    if (place) changed(place);
  };
  const stop = window.elpisDesktop?.storage?.onChange?.(key => {
    if (key === FLOAT_KEY) read();
  });
  const storage = (event: StorageEvent) => {
    if (event.key === FLOAT_KEY) read();
  };
  window.addEventListener("storage", storage);
  return () => {
    stop?.();
    window.removeEventListener("storage", storage);
  };
}
