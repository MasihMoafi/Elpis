"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { preloadPath }: typeof import("./preload-path.cts") = require("./preload-path.cts");

type QuickBridge = {
  submit: (text: string) => void;
  onShow: (callback: (state: { dark: boolean; draft?: string }) => void) => void;
};
type ScreenshotBridge = {
  choose: () => void;
  onShow: (callback: (shot: { image: string; count: number }) => void) => void;
};

function execute(name: string) {
  const messages: unknown[][] = [],
    handlers = new Map<string, (event: unknown, value: unknown) => void>();
  let exposed: unknown;
  const electron = {
    ipcRenderer: {
      send: (...args: unknown[]) => messages.push(args),
      on: (channel: string, handler: (event: unknown, value: unknown) => void) => handlers.set(channel, handler),
    },
    contextBridge: {
      exposeInMainWorld: (_name: string, value: unknown) => {
        exposed = value;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(preloadPath(name), "utf8"), { require: () => electron });
  return { messages, handlers, exposed };
}

test("generated sandbox preloads preserve their page and IPC behavior", () => {
  const quick = execute("quick-entry-preload");
  const quickBridge = quick.exposed as QuickBridge;
  quickBridge.submit("hello");
  assert.deepEqual(quick.messages[0], ["elpis:quick-entry:submit", "hello"]);
  let draft = "";
  quickBridge.onShow(state => {
    draft = state.draft ?? "";
  });
  quick.handlers.get("elpis:quick-entry:show")?.(null, { dark: true, draft: "saved" });
  assert.equal(draft, "saved");

  const screenshot = execute("screenshot-popup-preload");
  const screenshotBridge = screenshot.exposed as ScreenshotBridge;
  screenshotBridge.choose();
  assert.deepEqual(screenshot.messages[0], ["elpis:screenshot-popup:choose"]);
  let count = 0;
  screenshotBridge.onShow(shot => {
    count = shot.count;
  });
  screenshot.handlers.get("elpis:screenshot-popup:show")?.(null, { count: -1 });
  assert.equal(count, 1);
});

test("preload paths reject names outside the shipped set", () => {
  assert.throws(() => preloadPath("../other"), /preload/i);
});
