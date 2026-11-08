"use strict";
const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");
import type {
  App,
  BrowserWindow as Window,
  GlobalShortcut,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Screen,
} from "electron";
const path: typeof import("node:path") = require("node:path");
const { execFile }: typeof import("node:child_process") = require("node:child_process");
const {
  trustedBrowserSender,
  popupWebPreferences,
  lockPopup,
}: typeof import("./browser-policy.cts") = require("./browser-policy.cts");

// Quick Entry as Claude's desktop app has it on Linux: Ctrl+Alt+Space opens a 606 × 470 frameless, transparent window
// above everything, centred on the main display or where it was last left. Enter sends text longer than two characters
// as a new chat in the main window; Esc, a click outside its bar or another window taking focus dismisses it, and the
// shortcut again closes it.
const DEFAULT_SHORTCUT_VALUE = "Ctrl+Alt+Space";
const SIZE = { width: 606, height: 470 };
const MAX_TEXT = 16384;

// Claude's accelerator check: known keys only, with a modifier unless the key is a function key.
const MODIFIERS = new Set([
  "Command",
  "Cmd",
  "Control",
  "Ctrl",
  "CommandOrControl",
  "CmdOrCtrl",
  "Alt",
  "Option",
  "AltGr",
  "Shift",
  "Super",
  "Meta",
]);
const NAMED = new Set([
  ...MODIFIERS,
  "Plus",
  "Space",
  "Tab",
  "Capslock",
  "Numlock",
  "Scrolllock",
  "Backspace",
  "Delete",
  "Insert",
  "Return",
  "Enter",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
  "Esc",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "MediaPlayPause",
  "PrintScreen",
]);
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const knownKey = (part: string) =>
  NAMED.has(part) ||
  /^[A-Za-z0-9]$/.test(part) ||
  FUNCTION_KEY.test(part) ||
  /^num([0-9]|dec|add|sub|mult|div)$/.test(part) ||
  /^[)!@#$%^&*(:;=<,_\->.?/~`{}\]|[\\'"]$/.test(part);
function validAcceleratorImpl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  const parts = value.split("+");
  return parts.every(knownKey) && (parts.some(part => MODIFIERS.has(part)) || FUNCTION_KEY.test(value));
}

// Claude's words for a shortcut that could not be set.
const PROBLEMS = {
  "in-use": "This shortcut is already in use by another app. Try a different combination.",
  invalid: "This shortcut combination isn’t supported. Try a different combination.",
};
const NO_PORTAL =
  "Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.";
const PORTAL = [
  "org.freedesktop.portal.Desktop",
  "/org/freedesktop/portal/desktop",
  "org.freedesktop.portal.GlobalShortcuts",
  "version",
];
const busctl = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("/usr/bin/busctl", args, { timeout: 3000 }, (error, stdout) =>
      error ? reject(error as Error) : resolve(String(stdout)),
    ),
  );

/** Wayland gives apps global shortcuts only through the GlobalShortcuts desktop portal; Claude asks the session bus the same way. */
async function shortcutSupportImpl({
  env = process.env,
  busctl: run = busctl,
}: { env?: NodeJS.ProcessEnv; busctl?: typeof busctl } = {}) {
  const wayland = env.XDG_SESSION_TYPE ? env.XDG_SESSION_TYPE === "wayland" : !!env.WAYLAND_DISPLAY;
  if (!wayland) return { supported: true };
  try {
    if (/\bu\s+\d+/.test(await run(["--user", "--timeout=2", "get-property", ...PORTAL]))) return { supported: true };
  } catch {
    /* No portal. */
  }
  return { supported: false, reason: NO_PORTAL };
}

/** The global shortcut. `set` returns null, 'invalid' or 'in-use'; on failure the previous shortcut keeps working. Released on quit. */
function createShortcutImpl({
  app,
  globalShortcut,
  onPress,
}: {
  app: Pick<App, "on" | "removeListener">;
  globalShortcut: Pick<GlobalShortcut, "register" | "unregister">;
  onPress: () => void;
}) {
  let current: string | null = null;
  const register = (accelerator: string): "in-use" | "invalid" | null => {
    try {
      return globalShortcut.register(accelerator, onPress) ? null : "in-use";
    } catch {
      return "invalid";
    }
  };
  const release = () => {
    if (current) globalShortcut.unregister(current);
    current = null;
  };
  app.on("will-quit", release);
  return {
    current: () => current,
    set(accelerator: string | null) {
      if (accelerator && !validAcceleratorImpl(accelerator)) return "invalid";
      if (accelerator === current) return null;
      const previous = current;
      release();
      if (!accelerator) return null;
      const problem = register(accelerator);
      if (!problem) {
        current = accelerator;
        return null;
      }
      if (previous && !register(previous)) current = previous;
      return problem;
    },
    dispose() {
      release();
      app.removeListener("will-quit", release);
    },
  };
}

/** The Quick Entry window. `onSubmit` gets the text to open as a new chat. */
type Drafts = { read: () => unknown; save: (text: string) => Promise<unknown> | undefined };
type QuickOptions = {
  BrowserWindow: typeof Window;
  screen: Screen;
  ipcMain: IpcMain;
  dark: () => boolean;
  onSubmit: (text: string) => void;
  drafts?: Drafts | undefined;
};
function createQuickEntryImpl({ BrowserWindow, screen, ipcMain, dark, onSubmit, drafts }: QuickOptions) {
  let window: Window | null = null,
    ready: Promise<void> | null = null,
    position: [number, number] | null = null,
    restoreDraft = false;
  const open = () => !!window && !window.isDestroyed();
  const hide = () => {
    if (open() && window!.isVisible()) window!.hide();
  };
  function centre(): [number, number] {
    const { workArea } = screen.getPrimaryDisplay();
    return [
      Math.round(workArea.x + (workArea.width - SIZE.width) / 2),
      Math.round(workArea.y + (workArea.height - SIZE.height) / 2),
    ];
  }
  function create() {
    const [x, y] = position ?? centre();
    window = new BrowserWindow({
      ...SIZE,
      x,
      y,
      show: false,
      title: "Elpis Quick Entry",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: popupWebPreferences(preloadPath("quick-entry-preload")),
    });
    lockPopup(window);
    const own = window;
    restoreDraft = true;
    own.on("blur", hide);
    own.on("hide", () => {
      position = own.getPosition() as [number, number];
    });
    own.on("closed", () => {
      if (window === own) {
        window = null;
        ready = null;
      }
    });
    ready = new Promise<void>(resolve => own.once("ready-to-show", resolve));
    void own.loadFile(path.join(__dirname, "quick-entry.html"), { query: { theme: dark() ? "dark" : "light" } });
  }
  async function toggle() {
    if (open() && window!.isVisible()) {
      hide();
      return;
    }
    if (!open()) create();
    const shown = window!;
    await ready;
    if (window !== shown || shown.isDestroyed()) return;
    shown.setPosition(...(position ?? centre()));
    const draft = restoreDraft ? drafts?.read() : undefined;
    shown.webContents.send("elpis:quick-entry:show", {
      dark: dark(),
      ...(typeof draft === "string" && draft ? { draft } : {}),
    });
    restoreDraft = false;
    shown.show();
    shown.focus();
  }
  const fromQuickEntry = (event: IpcMainEvent) => open() && event.sender === window!.webContents;
  const submit = (event: IpcMainEvent, text: unknown) => {
    if (!fromQuickEntry(event)) return;
    hide();
    if (typeof text === "string" && text.trim().length > 2) onSubmit(text.slice(0, MAX_TEXT));
  };
  const dismiss = (event: IpcMainEvent) => {
    if (fromQuickEntry(event)) hide();
  };
  ipcMain.on("elpis:quick-entry:submit", submit);
  ipcMain.on("elpis:quick-entry:dismiss", dismiss);
  return {
    toggle,
    hide,
    async flush() {
      if (!open()) return;
      await ready;
      const text = await window!.webContents.executeJavaScript(
        'document.documentElement.inert = true; document.querySelector("textarea").value',
      );
      if (!drafts) {
        if (text) throw Error("Keep Quick Entry open and copy its unsent text before quitting.");
        return;
      }
      await drafts.save(text);
    },
    async cancelQuit() {
      if (open()) await window!.webContents.executeJavaScript("document.documentElement.inert = false; true");
    },
    dispose() {
      ipcMain.removeListener("elpis:quick-entry:submit", submit);
      ipcMain.removeListener("elpis:quick-entry:dismiss", dismiss);
      if (open()) window!.destroy();
      window = null;
    },
  };
}

/** Quick Entry, its shortcut, and what Settings → General shows about it. `start` registers the saved shortcut. */
function startQuickEntryImpl({
  app,
  globalShortcut,
  BrowserWindow,
  screen,
  ipcMain,
  dark,
  onSubmit,
  drafts,
  support = shortcutSupportImpl(),
}: QuickOptions & {
  app: Pick<App, "on" | "removeListener">;
  globalShortcut: Pick<GlobalShortcut, "register" | "unregister">;
  support?: Promise<{ supported: boolean; reason?: string }>;
}) {
  const quick = createQuickEntryImpl({ BrowserWindow, screen, ipcMain, dark, onSubmit, drafts });
  const shortcut = createShortcutImpl({ app, globalShortcut, onPress: () => void quick.toggle() });
  let problem: string | null = null; // Why the saved shortcut is not working, until a new one is set.
  async function change(accelerator: unknown) {
    const { supported, reason } = await support;
    if (!supported) return { error: reason };
    const result = shortcut.set(typeof accelerator === "string" ? accelerator : "");
    if (result) return { error: PROBLEMS[result] };
    problem = null;
    return { shortcut: shortcut.current() ?? "" };
  }
  async function status() {
    const { supported, reason } = await support;
    return { supported, ...(reason ? { reason } : {}), shortcut: shortcut.current() ?? "", problem };
  }
  return {
    toggle: quick.toggle,
    flush: quick.flush,
    cancelQuit: quick.cancelQuit,
    status,
    change,
    async start(saved: unknown) {
      const result = await change(saved);
      problem = result.error ?? null;
    },
    /** Settings → General's calls; only the app's own page may make them. */
    attach({
      host,
      origin,
      ipcMain: windowIpc = ipcMain,
    }: {
      host: Window;
      origin: string;
      ipcMain?: {
        handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
        removeHandler: (channel: string) => void;
      };
    }) {
      const trusted = (event: IpcMainInvokeEvent) => trustedBrowserSender(event, host.webContents, origin);
      windowIpc.handle("elpis:quick-entry:status", (event: IpcMainInvokeEvent) =>
        trusted(event) ? status() : { error: "Elpis application frame required" },
      );
      windowIpc.handle("elpis:quick-entry:shortcut", (event: IpcMainInvokeEvent, accelerator: unknown) =>
        trusted(event) ? change(accelerator) : { error: "Elpis application frame required" },
      );
      return () => {
        windowIpc.removeHandler("elpis:quick-entry:status");
        windowIpc.removeHandler("elpis:quick-entry:shortcut");
      };
    },
    dispose() {
      shortcut.dispose();
      quick.dispose();
    },
  };
}

export declare const DEFAULT_SHORTCUT: typeof DEFAULT_SHORTCUT_VALUE;
export declare const validAccelerator: typeof validAcceleratorImpl;
export declare const shortcutSupport: typeof shortcutSupportImpl;
export declare const createShortcut: typeof createShortcutImpl;
export declare const createQuickEntry: typeof createQuickEntryImpl;
export declare const startQuickEntry: typeof startQuickEntryImpl;
module.exports = {
  DEFAULT_SHORTCUT: DEFAULT_SHORTCUT_VALUE,
  validAccelerator: validAcceleratorImpl,
  shortcutSupport: shortcutSupportImpl,
  createShortcut: createShortcutImpl,
  createQuickEntry: createQuickEntryImpl,
  startQuickEntry: startQuickEntryImpl,
};
