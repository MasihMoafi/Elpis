"use strict";
const { tools: toolsImpl, pageOperation: pageOperationImpl, validate }: typeof import("./browser-agent-page.cts") = require("./browser-agent-page.cts");
import type { WebContentsView, InputEvent } from "electron";
export type Args = {
  [key: string]: string | number | boolean;
  selector: string;
  nodeId: string;
  tabId: string;
  url: string;
  action: string;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  timeoutMs: number;
  text: string;
  clear: boolean;
  key: string;
};
type AgentTab = {
  id: string;
  url: string;
  title: string;
  agent: boolean;
  error?: string | null;
  view: WebContentsView;
  identityReady?: Promise<void>;
  navigation?: number;
};
type Log = { level: unknown; message: string; line: unknown; source: string };
export type SchemaProperty = { type: string; enum?: string[]; description?: string };
export type PageElement = HTMLElement & {
  type: string;
  labels: NodeListOf<HTMLLabelElement>;
  disabled: boolean;
  select: () => void;
};
export type PageState = { prefix: string; next: number; ids: WeakMap<Element, string>; nodes: Map<string, PageElement> };
type ToolHandler = (id: string, name: string, args: unknown) => unknown;

const net: typeof import("node:net") = require("node:net");
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const fsSync: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { browserUrl }: typeof import("./browser-policy.cts") = require("./browser-policy.cts");
const { documentTools }: typeof import("./documents.cts") = require("./documents.cts");
const { screenTools }: typeof import("./screen-capture.cts") = require("./screen-capture.cts");

// The person's own tabs: the agent may read them, never navigate them or send them input.
const INPUT = new Set(["browser_navigate", "browser_click", "browser_type", "browser_press", "browser_scroll"]);

// The agent works only in tabs it opened (tab.agent), in the background: it never selects a tab or moves focus,
// so the person keeps using his own tab, with his keyboard, at the same time.
function createBrowserAgentImpl({
  tabs,
  open,
  origin,
  emit,
  prepare,
}: {
  tabs: Map<string, AgentTab>;
  open: (url: string, options: { agent: boolean }) => string;
  origin: string;
  emit: () => void;
  prepare: (id: string) => void;
}) {
  let enabled = true,
    tabId: string | null = null,
    epoch = 0,
    disposed = false,
    queue: Promise<unknown> = Promise.resolve();
  const logs = new Map<string, Log[]>();
  const state = () => ({ enabled, tabId });
  const guard = (generation: number) => {
    if (disposed) throw Error("Browser is closed.");
    if (!enabled || generation !== epoch)
      throw Error("The user has taken over the browser. Wait for them to allow agent control.");
  };
  const stop = () => {
    const tab = tabs.get(tabId as string),
      wc = tab?.view.webContents;
    if (tab?.navigation !== undefined) tab.navigation++;
    epoch++;
    enabled = false;
    tabId = null;
    if (wc && !wc.isDestroyed()) wc.stop();
    emit();
  };
  const allow = () => {
    epoch++;
    enabled = true;
    tabId = null;
    emit();
  };
  const observe = (tab: AgentTab) => {
    const messages: Log[] = [];
    logs.set(tab.id, messages);
    tab.view.webContents.on(
      "console-message",
      (
        _event: Electron.Event,
        details: Electron.ConsoleMessageEvent | number,
        message?: string,
        line?: number,
        source?: string,
      ) => {
        const entry =
          typeof details === "object" ? details : { level: details, message, lineNumber: line, sourceId: source };
        messages.push({
          level: entry.level,
          message: String(entry.message ?? "").slice(0, 4000),
          line: (entry as { lineNumber?: number }).lineNumber,
          source: String(entry.sourceId ?? "").slice(0, 1000),
        });
        if (messages.length > 200) messages.shift();
      },
    );
    tab.view.webContents.once("destroyed", () => {
      logs.delete(tab.id);
      if (tabId === tab.id) {
        tabId = null;
        emit();
      }
    });
  };
  async function run(name: string, args: Args, generation: number) {
    guard(generation);
    validate(name, args);
    if (name === "browser_tabs")
      return {
        tabs: [...tabs.values()].map(tab => ({ id: tab.id, url: tab.url, title: tab.title, agent: !!tab.agent })),
        control: state(),
      };
    if (name === "browser_open") {
      const url = browserUrl(args.url, origin);
      tabId = open(url, { agent: true });
      emit();
      return { tabId, url };
    }
    const tab = tabs.get(args.tabId),
      wc = tab?.view.webContents;
    if (!wc || wc.isDestroyed()) throw Error("This browser tab is closed.");
    if (INPUT.has(name) && !tab.agent)
      throw Error(
        "This is the person’s tab: you may read it, not navigate it or send it input. Open your own tab with browser_open.",
      );
    if (tab.identityReady) {
      await tab.identityReady;
      guard(generation);
      if (wc.isDestroyed()) throw Error("This browser tab is closed.");
    }
    browserUrl(wc.getURL() || tab.url, origin);
    if (name === "browser_navigate" && (!args.action || args.action === "goto")) browserUrl(args.url, origin);
    if (
      name === "browser_click" &&
      !(args.selector || args.nodeId) &&
      (!Number.isFinite(args.x) || !Number.isFinite(args.y))
    )
      throw Error("Choose a selector, nodeId or x/y.");
    if (name === "browser_click" && (args.selector || args.nodeId) && (args.x !== undefined || args.y !== undefined))
      throw Error("Choose a target or coordinates.");
    if (tab.agent) {
      tabId = tab.id;
      prepare(tab.id);
      emit();
    }
    const dom = async (action: string) => {
      guard(generation);
      const result = await wc.executeJavaScriptInIsolatedWorld(999, [
        { code: `(${pageOperationImpl.toString()})(${JSON.stringify(action)},${JSON.stringify(args)})` },
      ]);
      guard(generation);
      return result;
    };
    const press = (key: string) => {
      const parts = key.split("+"),
        raw = parts.pop()!,
        modifiers = parts.map(
          part =>
            (
              ({
                ctrl: "control",
                control: "control",
                meta: "meta",
                cmd: "meta",
                alt: "alt",
                shift: "shift",
              }) as Record<string, string>
            )[part.toLowerCase()],
        );
      const aliases = {
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        ArrowDown: "Down",
        Escape: "Escape",
        Space: "Space",
        Enter: "Enter",
        Tab: "Tab",
        Backspace: "Backspace",
        Delete: "Delete",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
      };
      const keyCode =
        (aliases as Record<string, string>)[raw] || (/^(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(raw) ? raw : null);
      if (!keyCode || modifiers.some(value => !value))
        throw Error("Unsupported key. Use a key name or chord such as Control+A.");
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers as NonNullable<InputEvent["modifiers"]> });
      // Electron keyDown does not insert a printable character by itself.
      if ((raw.length === 1 || raw === "Space") && !modifiers.some(value => value !== "shift"))
        wc.sendInputEvent({
          type: "char",
          keyCode: raw === "Space" ? " " : raw,
          modifiers: modifiers as NonNullable<InputEvent["modifiers"]>,
        });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers as NonNullable<InputEvent["modifiers"]> });
    };
    switch (name) {
      case "browser_navigate": {
        const action = args.action || "goto",
          history = wc.navigationHistory;
        if (action === "goto") await wc.loadURL(browserUrl(args.url, origin));
        else if (action === "reload") wc.reload();
        else if (action === "back" && history.canGoBack()) history.goBack();
        else if (action === "forward" && history.canGoForward()) history.goForward();
        else throw Error(`Cannot go ${action}.`);
        break;
      }
      case "browser_snapshot":
        return dom("snapshot");
      case "browser_click": {
        const point = args.selector || args.nodeId ? await dom("point") : args,
          zoom = wc.getZoomFactor();
        guard(generation);
        const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
        wc.sendInputEvent({ type: "mouseMove", ...position });
        wc.sendInputEvent({ type: "mouseDown", ...position, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", ...position, button: "left", clickCount: 1 });
        break;
      }
      case "browser_type":
        if (args.selector || args.nodeId) await dom(args.clear === false ? "focus" : "focus-select");
        guard(generation);
        if (args.clear !== false) wc.selectAll(); // An edit command: a select-all key chord is lost when the window lacks OS focus (CI, 2 Nov).
        await wc.insertText(args.text);
        break;
      case "browser_press":
        if (args.selector || args.nodeId) await dom("focus");
        guard(generation);
        press(args.key);
        break;
      case "browser_scroll":
        return dom("scroll");
      case "browser_screenshot": {
        // DOM updates can precede Chromium's displayed frame (as with annotation captures).
        await new Promise(resolve => setTimeout(resolve, 150));
        guard(generation);
        const image = await wc.capturePage();
        guard(generation);
        if (!image || image.isEmpty()) throw Error("The browser returned an empty screenshot.");
        const scaled = image.getSize?.().width > 1600 ? image.resize({ width: 1600 }) : image;
        return { content: [{ type: "image", mimeType: "image/jpeg", data: scaled.toJPEG(80).toString("base64") }] };
      }
      case "browser_console":
        return { messages: logs.get(tab.id) || [] };
      case "browser_wait": {
        const deadline = Date.now() + (args.timeoutMs ?? 10000);
        for (;;) {
          guard(generation);
          if (wc.isDestroyed()) throw Error("This browser tab is closed.");
          if (args.selector || args.nodeId ? await dom("ready") : !wc.isLoading()) {
            if (tab.error) throw Error(tab.error);
            return { ready: true };
          }
          if (Date.now() >= deadline) throw Error("Browser wait timed out.");
          await new Promise(resolve => setTimeout(resolve, 75));
        }
      }
    }
    guard(generation);
    return { tabId: tab.id, url: wc.getURL() };
  }
  return {
    state,
    stop,
    allow,
    observe,
    dispose() {
      disposed = true;
      epoch++;
      logs.clear();
    },
    call(name: string, args: unknown = {}) {
      const generation = epoch,
        result = queue.then(() => run(name, args as Args, generation));
      queue = result.catch(() => {});
      return result;
    },
  };
}

async function startBrowserAgentSocketImpl({ connectionFile }: { connectionFile?: string } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-browser-agent-"));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, "browser.sock"),
    connections = new Set<import("node:net").Socket>(),
    scopes = new Map<string, string>(),
    tokens = new Map<string, string>();
  let resolveAgent: (
      id: string,
    ) =>
      | Promise<{ call: (name: string, args: unknown) => unknown } | null>
      | { call: (name: string, args: unknown) => unknown }
      | null = () => null,
    documents: ToolHandler | null = null,
    screenCapture: ToolHandler | null = null;
  if (connectionFile) {
    try {
      const previous = JSON.parse(await fs.readFile(connectionFile, "utf8"));
      for (const [token, id] of Object.entries(previous.scopes || {}))
        if (typeof id === "string") {
          scopes.set(token, id);
          tokens.set(id, token);
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error("Could not read the private browser connection record.");
    }
  }
  function persist() {
    if (!connectionFile) return;
    fsSync.mkdirSync(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
    const pending = `${connectionFile}.${process.pid}.pending`;
    fsSync.writeFileSync(pending, JSON.stringify({ socketPath, scopes: Object.fromEntries(scopes) }), { mode: 0o600 });
    fsSync.renameSync(pending, connectionFile);
  }
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(35000, () => socket.destroy());
    let buffer = "",
      accepted = false;
    socket.on("data", data => {
      if (accepted) return;
      buffer += data.toString("utf8");
      if (Buffer.byteLength(buffer) > 65536) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      accepted = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          const owner = scopes.get(request.capability);
          if (!owner) throw Error("A valid browser session capability is required.");
          // The MCP host overwrites _meta.threadId on every call, including inherited agent connections.
          // Tool arguments cannot choose this value. Without host metadata, a capability stays with its owner.
          const id = request.sessionId ?? owner;
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
            throw Error("Invalid browser session metadata.");
          let result;
          if (screenTools.some(tool => tool.name === request.name)) {
            if (!screenCapture) throw Error("Screen capture is unavailable in this desktop.");
            result = await screenCapture(id, request.name, request.arguments);
          } else if (documentTools.some(tool => tool.name === request.name)) {
            if (!documents) throw Error("Shared document editing is unavailable in this desktop.");
            result = await documents(id, request.name, request.arguments);
          } else {
            const agent = await resolveAgent(id);
            if (!agent) throw Error("This session browser is unavailable.");
            result = await agent.call(request.name, request.arguments);
          }
          socket.end(JSON.stringify({ result }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: (error as Error).message }) + "\n");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  persist();
  return {
    path: socketPath,
    connectionFile,
    setResolver(value: typeof resolveAgent) {
      resolveAgent = value;
    },
    setDocuments(value: ToolHandler) {
      documents = value;
    },
    setScreenCapture(value: ToolHandler) {
      screenCapture = value;
    },
    scope(id: string) {
      if (!tokens.has(id)) {
        const token = randomUUID();
        tokens.set(id, token);
        scopes.set(token, id);
        persist();
      }
      return tokens.get(id);
    },
    rebind(from: string, to: string) {
      const token = tokens.get(from);
      if (token) {
        tokens.delete(from);
        tokens.set(to, token);
        scopes.set(token, to);
        persist();
      }
    },
    revoke(id: string) {
      tokens.delete(id);
      for (const [token, owner] of scopes) if (owner === id) scopes.delete(token);
      persist();
    },
    async close() {
      resolveAgent = () => null;
      documents = null;
      screenCapture = null;
      scopes.clear();
      tokens.clear();
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await fs.rmdir(directory);
    },
  };
}
export declare const tools: typeof toolsImpl;
export declare const createBrowserAgent: typeof createBrowserAgentImpl;
export declare const startBrowserAgentSocket: typeof startBrowserAgentSocketImpl;
export declare const pageOperation: typeof pageOperationImpl;
module.exports = {
  tools: toolsImpl,
  createBrowserAgent: createBrowserAgentImpl,
  startBrowserAgentSocket: startBrowserAgentSocketImpl,
  pageOperation: pageOperationImpl,
};
