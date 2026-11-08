"use strict";
import type { BrowserWindow, IpcMainInvokeEvent, Shell } from "electron";
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const path: typeof import("node:path") = require("node:path");
const nodeSpawn: typeof import("node:child_process").spawn = require("node:child_process").spawn;
const { trustedBrowserSender }: typeof import("./browser-policy.cts") = require("./browser-policy.cts");
const { installedEditors, editorCommand }: typeof import("./editors.cts") = require("./editors.cts");

function localFilePath(target: unknown) {
  if (typeof target !== "string" || target.length > 4096 || !target.startsWith("/") || target.startsWith("//")) {
    throw Error("Choose an absolute local file path.");
  }
  let file;
  try {
    file = decodeURIComponent(target);
  } catch {
    throw Error("This file path is not valid.");
  }
  if (!path.isAbsolute(file) || file.startsWith("//") || /[\x00-\x1f\x7f]/.test(file))
    throw Error("This file path is not valid.");
  const line = file.match(/:(\d+)$/);
  if (line) {
    if (!Number.isSafeInteger(Number(line[1])) || Number(line[1]) < 1)
      throw Error("This file link has an invalid line number.");
    file = file.slice(0, -line[0].length);
  }
  return file;
}

/** A project's folder: a plain absolute path, as saved in the project list. */
function localFolderPath(target: unknown) {
  if (
    typeof target !== "string" ||
    target.length > 4096 ||
    !path.isAbsolute(target) ||
    target.startsWith("//") ||
    /[\x00-\x1f\x7f]/.test(target)
  ) {
    throw Error("Choose an absolute local folder path.");
  }
  return target;
}

/** The line a clicked file link carries (`/path/a.ts:12`), if any. */
const lineOf = (target: unknown) => {
  const match = typeof target === "string" ? target.match(/:(\d+)$/) : null;
  return match ? Number(match[1]) : undefined;
};

/** Starts `command` apart from the app and waits until the system has started it (or refused). */
function start(spawn: typeof nodeSpawn, { name, command, args }: ReturnType<typeof editorCommand>) {
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch (error) {
      reject(Error(`Could not start ${name}: ${(error as Error).message}`));
      return;
    }
    child.once("error", error => reject(Error(`Could not start ${name}: ${(error as Error).message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function registerFilesImpl({
  host,
  origin,
  ipcMain,
  shell,
  env,
  spawn = nodeSpawn,
}: {
  host: BrowserWindow;
  origin: string;
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;
    removeHandler: (channel: string) => void;
  };
  shell: Pick<Shell, "openPath">;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}) {
  const trusted = (event: IpcMainInvokeEvent) => {
    if (!trustedBrowserSender(event, host.webContents, origin)) throw Error("Elpis application frame required");
  };
  /** The real path of an existing local file or folder named by `toPath`, else an error the page can show. */
  const existing = async (kind: string, toPath: (target: unknown) => string, target: unknown) => {
    let file = toPath(target);
    try {
      file = await fs.realpath(file);
      const stat = await fs.stat(file);
      if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw Error(`Not a ${kind}`);
    } catch {
      throw Error(`This ${kind} is unavailable. Choose an existing local ${kind}.`);
    }
    return file;
  };
  const opener =
    (kind: string, toPath: (target: unknown) => string) => async (event: IpcMainInvokeEvent, target: unknown) => {
      try {
        trusted(event);
        const error = await shell.openPath(await existing(kind, toPath, target));
        if (error) throw Error(`Could not open this ${kind}: ${error}`);
        return { opened: true };
      } catch (error) {
        return { error: (error as Error).message || `Could not open this ${kind}.` };
      }
    };
  ipcMain.handle("elpis:file:open", async (event: IpcMainInvokeEvent, target: unknown) => {
    try {
      trusted(event);
      const file = await existing("file", localFilePath, target);
      host.webContents.send("elpis:file:requested", { path: file, line: lineOf(target) });
      return { opened: true };
    } catch (error) {
      return { error: (error as Error).message || "Could not open this file." };
    }
  });
  ipcMain.handle("elpis:file:external", opener("file", localFilePath));
  ipcMain.handle("elpis:folder:open", opener("folder", localFolderPath));
  ipcMain.handle("elpis:editors:list", (event: IpcMainInvokeEvent) => {
    try {
      trusted(event);
      return Promise.resolve({ editors: installedEditors(env) });
    } catch (error) {
      return Promise.resolve({ error: (error as Error).message });
    }
  });
  ipcMain.handle("elpis:file:edit", async (event: IpcMainInvokeEvent, raw: unknown) => {
    try {
      trusted(event);
      const { target, editor, line } = (raw ?? {}) as { target?: unknown; editor?: unknown; line?: unknown };
      const file = await existing("file", localFilePath, target);
      await start(spawn, editorCommand(editor, file, Number.isInteger(line) ? line : lineOf(target), env));
      return { opened: true };
    } catch (error) {
      return { error: (error as Error).message || "Could not start the editor." };
    }
  });
  return () => {
    for (const name of [
      "elpis:file:open",
      "elpis:file:external",
      "elpis:folder:open",
      "elpis:editors:list",
      "elpis:file:edit",
    ])
      ipcMain.removeHandler(name);
  };
}

export declare const registerFiles: typeof registerFilesImpl;
module.exports = { registerFiles: registerFilesImpl };
