/** Desktop lifecycle and the opt-in Elpis chat. One controller serializes settings changes and startup. */
import { attachmentInput } from "../attachments.mts";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { DesktopClient } from "../client.mts";
import { BridgeError, object } from "../validate.mts";
import { replacementEligibility } from "../../lib/turn-replacement.ts";
import type { ChatMessage } from "./sources/elpis-chat-history.mts";
import { elpisHome, existingSocket } from "../client-paths.mts";
import { profileEnvironment } from "../profile-env.mts";
import { MotherApp } from "./app.mts";
import { MotherChangeSchema, MotherSettingsFile, type MotherSettings } from "./settings.mts";
import { storedSettingsVersion } from "./app/store.mts";
import { runtimeAdapters, type RuntimeAdapter } from "./executor/adapters.mts";
import { readSettings, type RoleModel } from "./executor/settings.mts";
import { createElpisChatTransport } from "./sources/elpis-chat-transport.mts";
import { modelCatalog } from "./model.mts";
import { createChats } from "./chats.mts";
import { subprocess } from "./subprocess.mts";
import type { ListedThread, ThreadListOptions } from "../client-thread-list.mts";
import { handleMotherHttp } from "./app/http.mts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Health } from "./sources/host.mts";
import { workerSessionId } from "./executor/messages.mts";

interface Options {
  client: DesktopClient;
  home: string;
  socketPath?: string;
  adapters?: () => Promise<RuntimeAdapter[]>;
}
/**
 * What the Elpis chat does with each change the window can ask of a chat (the last part of `/api/threads/<id>/…`).
 * Its messages are the router's, not turns the engine holds, so only what is named here as done goes through; the
 * rest is refused in words, and so is anything this list has never heard of. Nothing passes silently to a chat the
 * engine holds empty (11 Nov, Masih: Edit there failed with "The complete input for this turn is unavailable").
 */
const ELPIS_CHAT_DOES = new Set([
  "turns",
  "steer",
  "interrupt",
  "effort",
  "revert",
  "resume",
  "rename",
  "archive",
  "unarchive",
  "delete",
  "versions",
]);
const ELPIS_CHAT_REFUSES: Record<string, string> = {
  rewind:
    "The Elpis chat is the record of what Elpis did, so it is not rewound. Edit a message to send it again, or delete the chat to clear it.",
  fork: "There is one Elpis, so its chat is not forked. Start a new chat instead.",
  compact: "The Elpis chat needs no compacting: Elpis reads back only what it needs.",
  review: "Ask Elpis for the review in your own words; the review command works in an ordinary chat.",
  continue: "The Elpis chat is always yours to write in.",
  permissions: "Elpis and the chats it starts for work run with Full access; this choice does not apply to its chat.",
  "service-tier": "Fast mode does not apply to the Elpis chat.",
  folder: "The Elpis chat has no folder of its own: name the project in your message.",
  shell: "Shell commands run in an ordinary chat: ask Elpis in words, or open a chat in the project.",
  "side-chat": "A side chat needs an ordinary chat; ask Elpis here.",
  goal: "The Elpis chat keeps no goal of its own: give the goal in your message.",
  "context-files": "Context files are chosen in an ordinary chat.",
};
export function elpisChatRefusal(request: string): string | undefined {
  if (ELPIS_CHAT_DOES.has(request)) return undefined;
  return ELPIS_CHAT_REFUSES[request] ?? "The Elpis chat does not take this; use an ordinary chat.";
}

export class MotherAgent {
  private readonly file: MotherSettingsFile;
  private readonly options: Options;
  private app: MotherApp | undefined;
  private active = false;
  private queue: Promise<unknown> = Promise.resolve();
  private error: string | undefined;
  private closed = false;
  private archived = false;
  /** The turn the window was told of while the router works; nothing while it rests. */
  private workingTurn: string | undefined;
  private readonly pulse: ReturnType<typeof setInterval>;
  /** The router's own Sessions seen so far: they run in its state folder and the sidebar never shows them. */
  private readonly sessions = new Set<string>();
  private roles: { dispatch: RoleModel; worker: RoleModel } | undefined;
  constructor(options: Options) {
    this.options = options;
    this.file = new MotherSettingsFile(options.home);
    this.pulse = setInterval(() => this.beat(), 1000);
    this.pulse.unref();
  }
  /**
   * Shows the Working mark in the Elpis chat while the router or one of its workers is at work for him, as any chat
   * shows it while its turn runs. The Elpis chat has no turn of its own: the router works in its hidden session and
   * writes its replies in. So the window is told of a turn that starts when work starts and ends when it ends
   * (11 Nov, Masih: "shows 0 progress bar, that animation lacks").
   */
  private beat(): void {
    const busy = this.active && !!this.app?.working();
    if (busy === !!this.workingTurn) return;
    const threadId = this.file.read().threadId;
    if (!threadId) return;
    const id = busy ? `router-${randomUUID()}` : this.workingTurn;
    this.workingTurn = busy ? id : undefined;
    this.options.client.emit("event", {
      type: "message",
      data: {
        method: busy ? "turn/started" : "turn/completed",
        params: { threadId, turn: { id, status: busy ? "inProgress" : "completed", items: [] } },
      },
    });
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  snapshot(): MotherSettings {
    const snapshot = this.file.snapshot(),
      settings = this.app?.store.settings() ?? readSettings(this.options.home);
    const revision =
      this.app?.store.settingsHistory(1)[0]?.revision ??
      storedSettingsVersion(join(this.options.home, "router", "orchestrator.sqlite"))?.revision ??
      0;
    const version = createHash("sha256")
      .update(JSON.stringify([snapshot.version, revision]))
      .digest("hex");
    return {
      ...snapshot,
      version,
      ...(settings ? { roles: { dispatch: settings.eval.model, worker: settings.executor.model } } : {}),
      ...(this.error ? { error: this.error } : {}),
      health: this.health(),
    };
  }
  private health(): Record<string, Health> {
    const config = this.file.read();
    const runtime: Health = this.closed
      ? { state: "paused", detail: "Elpis is stopped" }
      : !config.enabled
        ? { state: "paused", detail: "Elpis is off" }
        : !this.options.client.connected
          ? { state: "error", detail: "Elpis is disconnected from the runtime" }
          : this.error
            ? { state: "error", detail: this.error }
            : this.archived
              ? { state: "paused", detail: "The Elpis chat is archived" }
              : !this.active
                ? { state: "paused", detail: "Elpis is stopped" }
                : this.app?.store.settings().paused
                  ? { state: "paused", detail: "Processing is paused" }
                  : (this.app?.health.runtime ?? { state: "ready", detail: "Elpis is running" });
    return {
      ...Object.fromEntries(
        Object.entries(this.app?.health ?? {}).map(([name, entry]) => [
          name,
          !this.active && entry.state === "starting" ? runtime : entry,
        ]),
      ),
      runtime,
    };
  }
  owns(id: string): boolean {
    return this.file.read().threadId === id;
  }
  sessionLinks() {
    const { enabled, threadId } = this.file.read();
    const store = this.app?.store;
    const tickets = (store?.tickets.list() ?? []).flatMap(ticket => {
      const session = store?.session(workerSessionId(ticket.id)) as { threadId?: unknown } | undefined;
      return typeof session?.threadId === "string" ? [{ title: ticket.title, threadId: session.threadId }] : [];
    });
    return { enabled, threadId, tickets };
  }
  decorate<T extends { id: string }>(thread: T): T & { motherAgent?: boolean } {
    const config = this.file.read();
    // A worker the router started is its own chat, never a subagent of Elpis: in DSH each Executor Session is an ordinary
    // Session (specs/router-chats.md R2; Masih, 10 Nov: "not a subagent!").
    if (config.threadId !== thread.id)
      return (thread as { parentThreadId?: string | null }).parentThreadId === config.threadId
        ? { ...thread, parentThreadId: null }
        : thread;
    const model =
      this.app?.store.settings().eval.model ??
      readSettings(this.options.home).eval.model ??
      this.roles?.dispatch ??
      config.roles.dispatch;
    return {
      ...thread,
      name: "Elpis",
      motherAgent: true,
      ...(model
        ? {
            model: model.model,
            modelProvider: model.provider,
            ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          }
        : {}),
    };
  }
  /** The Elpis chat works like any other chat: its model and effort choices become the router's own. */
  async chooseRouter(choice: { model?: unknown; effort?: unknown }): Promise<void> {
    const current = this.snapshot(),
      dispatch = current.roles.dispatch;
    const model = typeof choice.model === "string" && choice.model ? choice.model : dispatch?.model;
    if (!model) return;
    const reasoningEffort =
      typeof choice.effort === "string" && choice.effort ? choice.effort : dispatch?.reasoningEffort;
    if (model === dispatch?.model && reasoningEffort === dispatch?.reasoningEffort) return;
    const subscription = model.startsWith("claude/") ? "claude" : model.startsWith("agy/") ? "gemini" : null;
    const provider =
      subscription ?? (dispatch && !["claude", "gemini"].includes(dispatch.provider) ? dispatch.provider : "openai");
    await this.save({
      version: current.version,
      roles: { ...current.roles, dispatch: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } },
    });
  }
  /** Reopening the chat reports the model it was created with; Elpis's chat shows the model that routes it now. */
  resumed<T extends { thread?: { id: string } }>(id: string, live: T): T {
    if (!live.thread || !this.owns(id)) return live;
    // Reopening the chat while the router works keeps the Working mark.
    return { ...live, thread: this.decorate(live.thread), ...(this.workingTurn ? { activeTurnId: this.workingTurn } : {}) };
  }
  /**
   * Whether a live update is about one of the router's own Sessions. The list leaves them out; on 11 Nov one that
   * started while the window was open still arrived as a live update and showed as a second "Elpis" row with the
   * router's raw messages.
   */
  hides(event: { type?: string; data?: unknown }): boolean {
    if (event.type !== "message") return false;
    const params = (event.data as { params?: { threadId?: unknown; thread?: { id?: unknown; cwd?: unknown } } })?.params;
    const thread = params?.thread;
    if (typeof thread?.id === "string" && thread.cwd === join(this.options.home, "router")) this.sessions.add(thread.id);
    const id = typeof thread?.id === "string" ? thread.id : params?.threadId;
    return typeof id === "string" && this.sessions.has(id);
  }
  /** Native lists omit chats without a native preview; Elpis owns her history in the bridge. */
  async list(
    threads: ListedThread[],
    query: ThreadListOptions,
    excluded: (id: string) => boolean = () => false,
  ): Promise<ListedThread[]> {
    const id = this.file.read().threadId;
    // Every router session runs in the router's state folder, current and replaced ones alike. The sidebar shows one Elpis.
    const routerDirectory = join(this.options.home, "router");
    for (const thread of threads) if (thread.cwd === routerDirectory) this.sessions.add(thread.id);
    const rows = threads
      .filter(thread => thread.cwd !== routerDirectory && !excluded(thread.id))
      .map(thread => this.decorate(thread));
    if (
      !id ||
      excluded(id) ||
      query.archived ||
      query.cursor ||
      query.ancestorThreadId ||
      rows.some(thread => thread.id === id)
    )
      return rows;
    if (typeof query.searchTerm === "string" && !"elpis".includes(query.searchTerm.toLowerCase())) return rows;
    try {
      const thread = await this.options.client.readThreadMetadata(id);
      if (!thread.archived) rows.unshift(this.decorate(thread));
    } catch {
      /* A deleted or unavailable Elpis chat remains visible as a startup error in Settings. */
    }
    return rows;
  }
  /** Called once at bridge startup and again on reconnection; disabled settings start no runtime. */
  start(): Promise<void> {
    return this.serialized(async () => {
      try {
        await this.reconcile();
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Elpis could not start";
      }
    });
  }
  save(input: unknown): Promise<MotherSettings> {
    return this.serialized(async () => {
      if (this.closed) throw new BridgeError("Elpis is stopping", 409);
      const data = MotherChangeSchema.parse(input);
      if (data.version !== this.snapshot().version)
        throw new BridgeError("Elpis settings changed elsewhere. Reload before saving.", 409);
      const before = this.file.read(),
        roles = data.roles;
      if (roles) {
        const app = this.passive();
        app.store.atomic(() => {
          const current = app.store.settings();
          const settings = {
            ...current,
            eval: { ...current.eval, model: roles.dispatch },
            executor: { ...current.executor, model: roles.worker },
          };
          for (const block of ["eval", "executor"] as const)
            app.store.saveSettings(settings, {
              source: "panel",
              block,
              policyVersion: "",
              policyChanged: false,
              notified: [],
            });
          this.file.write({
            ...before,
            enabled: data.enabled ?? before.enabled,
            roles: { dispatch: null, worker: null },
          });
        });
      } else this.file.write({ ...before, enabled: data.enabled ?? before.enabled });
      await this.stop();
      this.error = undefined;
      try {
        await this.reconcile();
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Elpis could not start";
      }
      this.options.client.emit("event", {
        type: "message",
        data: { method: "thread/name/updated", params: { threadId: this.file.read().threadId, name: "Elpis" } },
      });
      return this.snapshot();
    });
  }
  private async reconcile(): Promise<void> {
    let config = this.file.read();
    if (this.closed || !config.enabled || !this.options.client.connected) return;
    const { client, home } = this.options,
      settings = await client.settings();
    // The router decides what every worker does, so it follows the main model, never the cheap background one.
    const inherited = settings.main;
    const fallback: RoleModel = {
      provider: inherited.provider ?? settings.main.provider ?? "",
      model: inherited.model ?? "",
    };
    const saved = this.app?.store.settings() ?? readSettings(home);
    const roles = {
      dispatch: saved.eval.model ?? config.roles.dispatch ?? fallback,
      worker: saved.executor.model ?? config.roles.worker ?? fallback,
    };
    if (Object.values(roles).some(role => !role.provider || !role.model)) {
      await this.stop();
      throw new Error("Choose a model in Settings → Configuration before enabling Elpis.");
    }
    if (this.active && JSON.stringify(this.roles?.dispatch) === JSON.stringify(roles.dispatch)) {
      this.roles = roles;
      return;
    }
    await this.stop();
    this.roles = roles;
    if (!config.threadId) {
      if (config.creating)
        throw new Error(
          "Elpis chat creation was interrupted. Bind the existing chat in router/mother.json before enabling it again.",
        );
      await client.models();
      this.file.write({ ...config, creating: true });
      const created = await client.createThread({
        model: this.roles.dispatch.model,
        provider: this.roles.dispatch.provider,
      });
      config = this.file.write({ ...config, creating: false, threadId: created.thread.id });
    }
    const threadId = config.threadId;
    if (!threadId) throw new Error("Elpis has no chat");
    this.archived = !!(await client.readThreadMetadata(threadId)).archived;
    if (this.archived) return;
    await client.renameThread(threadId, { name: "Elpis" });
    const env = profileEnvironment(home, resolve(home) === elpisHome() ? process.env : {});
    const adapters = await (this.options.adapters?.() ??
      runtimeAdapters({ url: `ws+unix://${existingSocket(this.options.socketPath, env)}:/` }));
    let app: MotherApp | undefined;
    try {
      app = new MotherApp({
        home,
        threadId,
        adapters,
        subprocess,
        transport: createElpisChatTransport(client),
        chats: createChats(client),
        settings: () => {
          const value = readSettings(home);
          return {
            ...value,
            eval: { ...value.eval, model: this.roles!.dispatch },
            executor: { ...value.executor, model: this.roles!.worker },
          };
        },
        models: modelCatalog(client),
        routerModelChanged: () => {
          void this.start();
        },
      });
      const current = app.store.settings();
      if (!current.eval.model || !current.executor.model)
        app.store.saveSettings({
          ...current,
          eval: { ...current.eval, model: current.eval.model ?? this.roles.dispatch },
          executor: { ...current.executor, model: current.executor.model ?? this.roles.worker },
        });
      if (config.roles.dispatch || config.roles.worker)
        this.file.write({ ...config, roles: { dispatch: null, worker: null } });
      await app.start();
      this.app = app;
      this.active = true;
      this.error = undefined;
    } catch (error) {
      if (app) await app.close();
      else for (const adapter of adapters) adapter.close();
      throw error;
    }
  }
  /** Stop in the Elpis chat: the jobs he asked for there stop. The chat has no turn of its own to interrupt. */
  interrupt(): Promise<{ interrupted: boolean }> {
    return this.serialized(() => Promise.resolve({ interrupted: (this.app?.stopChatWork() ?? 0) > 0 }));
  }
  /** Sidebar lifecycle stops sessions while retaining tickets, receipts and work history. */
  mutate<T>(id: string, operation: string, work: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const owned = this.owns(id),
        lifecycle = ["archiveThread", "unarchiveThread", "deleteThread", "trashThread"].includes(operation);
      if (owned && lifecycle) await this.stop();
      let result: T;
      try {
        result = await work();
      } catch (error) {
        if (owned && lifecycle) {
          try {
            await this.reconcile();
          } catch (restart) {
            this.error = restart instanceof Error ? restart.message : "Elpis could not restart";
          }
        }
        throw error;
      }
      // Deleting the Elpis chat clears it: the router carries on at once in a fresh one. The sidebar's Delete puts a
      // chat in the trash (`trashThread`: archived now, Undo brings it back as an ordinary chat). On 11 Nov he could
      // not clear it: the router stayed tied to the trashed chat and the Elpis tab was dead until the app restarted.
      if (owned && (operation === "deleteThread" || operation === "trashThread")) {
        this.file.write({ ...this.file.read(), threadId: null, creating: false });
        try {
          await this.reconcile();
        } catch (restart) {
          this.error = restart instanceof Error ? restart.message : "Elpis could not restart";
        }
      }
      if (owned && operation === "unarchiveThread") await this.reconcile();
      return result;
    });
  }
  async send(id: string, raw: unknown) {
    this.writable(id);
    const input = object(raw, [
      "text",
      "model",
      "effort",
      "mode",
      "attachments",
      "mentions",
      "expectedTurnId",
    ]) as Record<string, unknown>;
    return this.deliver(id, input, () => attachmentInput(input.text, input.attachments, input.mentions));
  }
  /**
   * An edited message of the Elpis chat goes to Elpis as a new message, with what the first one carried (pictures,
   * files, mentions). Nothing above it changes: the chat is the record of what Elpis did with the first wording, and
   * work it handed out carries on. The engine holds no turn of this chat to replace.
   */
  async resend(id: string, raw: unknown) {
    this.writable(id);
    const input = object(raw, ["beforeTurnId", "text", "model", "effort"]) as Record<string, unknown>;
    const turnId = typeof input.beforeTurnId === "string" ? input.beforeTurnId : "";
    const original = await this.entry(id, turnId);
    const first = replacementEligibility(original ? [original] : [], turnId, { historyComplete: true });
    if (!first.allowed)
      throw new BridgeError("That message is no longer in the Elpis chat, so it cannot be sent again.", 409);
    if (typeof input.text !== "string" || !input.text.trim()) throw new BridgeError("Write a message");
    const text = input.text;
    const sent = await this.deliver(id, input, () => [
      ...attachmentInput(text),
      ...(first.kept as NonNullable<ChatMessage["content"]>),
    ]);
    return { ...sent, kept: true };
  }
  private writable(id: string): void {
    if (this.closed || !this.file.read().enabled)
      throw new BridgeError("Turn Elpis on in Settings → Configuration to send a goal.", 409);
    if (!this.owns(id)) throw new BridgeError("This is not the Elpis chat", 409);
  }
  /** One message of the Elpis chat, by its turn. */
  private async entry(id: string, turnId: string) {
    let cursor: string | undefined;
    for (let pages = 0; turnId && pages < 50; pages++) {
      const page = await this.options.client.readThread(id, { limit: 100, ...(cursor ? { cursor } : {}) });
      const found = page.data.find(entry => entry.turnId === turnId);
      if (found || !page.nextCursor) return found;
      cursor = page.nextCursor;
    }
    return undefined;
  }
  private async deliver(
    id: string,
    input: Record<string, unknown>,
    blocks: () => NonNullable<ChatMessage["content"]>,
  ) {
    await this.chooseRouter(input);
    await this.start();
    const app = this.app;
    if (!app) throw new BridgeError(this.error ?? "Elpis is unavailable", 503);
    const content = blocks();
    const message =
      content
        .flatMap(block =>
          block.type === "text" ? [block.text] : block.type === "mention" ? [`${block.name}: ${block.path}`] : [],
        )
        .join("\n") || "[Image attachment]";
    const entry = await this.options.client.appendUser(id, { id: randomUUID(), text: message, content });
    // Intake is durable before acknowledgement; the pass loop performs inference in the background.
    void app.pump().catch(error => {
      this.error = error instanceof Error ? error.message : "Elpis routing failed";
    });
    return { turn: { id: entry.turnId }, routed: true };
  }
  /** The panel can configure a disabled Elpis without starting a session, worker, poll or model call. */
  private passive(): MotherApp {
    if (!this.app) {
      const config = this.file.read(),
        initial = readSettings(this.options.home);
      this.app = new MotherApp({
        home: this.options.home,
        threadId: config.threadId ?? "",
        adapters: [],
        subprocess,
        settings: () => ({
          ...initial,
          eval: { ...initial.eval, model: config.roles.dispatch ?? initial.eval.model },
          executor: { ...initial.executor, model: config.roles.worker ?? initial.executor.model },
        }),
        transport: createElpisChatTransport(this.options.client),
        chats: createChats(this.options.client),
        models: modelCatalog(this.options.client),
        routerModelChanged: () => {
          void this.start();
        },
      });
    }
    return this.app;
  }
  async handle(request: IncomingMessage, response: ServerResponse, port: string): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) throw new BridgeError("Elpis is stopping", 409);
      await handleMotherHttp(
        {
          ...this.passive().http(),
          health: this.health(),
          configured: () => this.active && this.options.client.connected,
        },
        request,
        response,
        Number(port),
      );
    });
  }

  private async stop(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    this.active = false;
    await app?.close();
  }
  close(): Promise<void> {
    this.closed = true;
    clearInterval(this.pulse);
    return this.serialized(() => this.stop());
  }
}
