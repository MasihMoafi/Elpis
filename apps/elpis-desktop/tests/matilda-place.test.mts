// 13 Nov, Masih: clicking the notification for Matilda's reply "makes the pin icon big again, as though I wanted it
// becoming big". Each window read her saved place once, when it opened; a window brought forward later still showed her
// at its old size. Every window now follows the place he last saved, from any window.
import "./alias.mts";
import test from "node:test";
import assert from "node:assert/strict";

const { FLOAT_KEY, savedPlace, watchSavedPlace } = await import("../components/matilda-place.ts");

/** One window's view of the shared desktop store: another window's save arrives as a change of its key. */
function desktopWindow(values: Record<string, string>) {
  const listeners = new Set<(key: string) => void>();
  const window = {
    elpisDesktop: {
      storage: {
        getItem: (key: string) => values[key] ?? null,
        onChange: (callback: (key: string) => void) => {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    window,
    savedElsewhere(key: string, value: string | null) {
      if (value === null) delete values[key];
      else values[key] = value;
      for (const listen of listeners) listen(key);
    },
    listening: () => listeners.size,
  };
}

test("a window opened earlier shows her at the size he last saved in another window", t => {
  const shared = { [FLOAT_KEY]: JSON.stringify({ right: 16, bottom: 16, size: 200 }) },
    other = desktopWindow(shared);
  Reflect.set(globalThis, "window", other.window);
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  assert.equal(savedPlace().size, 200, "she was big when this window opened");
  const seen: number[] = [];
  const stop = watchSavedPlace(place => seen.push(place.size));
  other.savedElsewhere(FLOAT_KEY, JSON.stringify({ right: 16, bottom: 16, size: 48 }));
  assert.deepEqual(seen, [48], "made small in the other window, small here too");
  stop();
  assert.equal(other.listening(), 0);
});

test("other keys, a removed or unreadable place never change her", t => {
  const other = desktopWindow({ [FLOAT_KEY]: JSON.stringify({ right: 16, bottom: 16, size: 48 }) });
  Reflect.set(globalThis, "window", other.window);
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  const seen: number[] = [];
  const stop = watchSavedPlace(place => seen.push(place.size));
  other.savedElsewhere("elpis-preferences-v1", "{}");
  other.savedElsewhere(FLOAT_KEY, "not a place");
  other.savedElsewhere(FLOAT_KEY, null);
  assert.deepEqual(seen, [], "nothing readable: she stays as she is, not the default size");
  stop();
});
