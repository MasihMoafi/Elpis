"use strict";
// Quick Entry's page (quick-entry.html) may only send its text, close itself, and hear that it was shown.
const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");
contextBridge.exposeInMainWorld("elpisQuickEntry", {
  submit: (text: string) => ipcRenderer.send("elpis:quick-entry:submit", String(text)),
  dismiss: () => ipcRenderer.send("elpis:quick-entry:dismiss"),
  onShow: (callback: (state: { dark: boolean; draft?: string }) => void) => {
    ipcRenderer.on("elpis:quick-entry:show", (_event, state: { dark?: boolean; draft?: string } | undefined) =>
      callback({ dark: state?.dark === true, ...(typeof state?.draft === "string" ? { draft: state.draft } : {}) }),
    );
  },
});
