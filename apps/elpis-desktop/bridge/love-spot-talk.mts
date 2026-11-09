import { createLiveConversation } from "./love-spot-talk-live.mts";
import { findModel, messageAttachments, validateSendBody, type Attachment, type SendBody } from "./love-spot-talk-send.mts";
import { finalAnswers, paintingsToRepair } from "./love-spot-talk-history.mts";
import { createSpeechFeed } from "./love-spot-speech.mts";
import { INSTRUCTIONS, drawing, SUBSCRIPTION_MODEL, SUBSCRIPTION_BLOCKED } from "./love-spot-talk-prompt.mts";
export { SUBSCRIPTION_BLOCKED } from "./love-spot-talk-prompt.mts";
import type {
  Store,
  Page,
  Client,
  Item,
  Entry,
  SpeechFeed,
  Writing,
  Thread,
  HeartReaction,
  EngineEvent,
} from "./love-spot-talk-types.mts";
import { BridgeError, object, text } from "./validate.mts";
import { agentColor } from "../lib/love-spot.ts";
import { splitPainting, withoutPainting } from "./love-spot-painting.cts";
import { createSentenceBuffer } from "./speech-buffer.mts";
import { LOVE_SPOT_AUDIO } from "../lib/love-spot-audio.mts";
import { replyPortrait } from "./matilda-face.cts";

// The engine names an unknown thread in these ways; thread/read of a purged one answers only "rejected the operation (-32600)".
const MISSING = /thread not (found|loaded)|no rollout found|rejected the operation \(-32600\)/i;
export function createLoveSpotTalk({
  client,
  store,
  companion,
  audio = LOVE_SPOT_AUDIO,
  standalone = process.env.LOVE_SPOT_APP === "1",
}: {
  client: Client;
  store: Store;
  companion?: { command: (text: string, session: string) => Promise<unknown> } | undefined;
  audio?: { available: boolean; reason?: string };
  standalone?: boolean;
}) {
  let threadId: string | null = null,
    thread: Thread | null = null,
    entries: Entry[] = [],
    activeTurnId: string | null = null,
    finishedTurnId: string | null = null,
    error = "",
    loaded = false,
    sending = false,
    closed = false,
    stale: string | null | undefined;
  let work = Promise.resolve(),
    loading: Promise<void> | null | undefined,
    sendingPage: Page | undefined;
  let matilda: { replies: boolean; model: string | null; provider: string | null } = {
    replies: true,
    model: null,
    provider: null,
  };
  let muted = false,
    available = false,
    voiceReason: string | undefined = "",
    voiceError = "",
    writing: Writing | undefined,
    speechFeed: SpeechFeed | undefined;
  const finished = new Set<string>();
  const listeners = new Set<(value: ReturnType<typeof snapshot> & { heartReaction?: HeartReaction }) => void>(),
    parts = new Map<string, Map<string, Item>>(),
    turnPages = new Map<string, Page | undefined>(),
    fastAsked = new Set<string>(),
    seen = new Map<string, string>();
  /** The panel shows her note, not the block she paints with. */
  const shown = (entry: Entry) => {
    const buffer = writing?.id === entry.turnId && writing.items.get(entry.item.id)?.buffer;
    return entry.item.type === "agentMessage"
      ? {
          ...entry,
          item: {
            ...entry.item,
            portrait: replyPortrait(entry.item.text).expression,
            text: buffer && !writing!.done ? buffer.text() : withoutPainting(entry.item.text ?? ""),
          },
        }
      : entry;
  };
  const voice = () => ({ enabled: available && !muted, available, reason: voiceReason, error: voiceError });
  const snapshot = () => ({
    thread,
    entries: entries.map(shown),
    busy: sending || !!activeTurnId,
    error,
    voice: voice(),
    matilda,
  });
  const publish = (heartReaction?: HeartReaction) => {
    if (!closed) for (const listen of listeners) listen(heartReaction ? { ...snapshot(), heartReaction } : snapshot());
  };
  async function refreshVoice() {
    if (!audio.available) {
      available = false;
      voiceReason = audio.reason;
      voiceError = "";
      speechFeed?.emit({ type: "stop" });
      return voice();
    }
    try {
      muted = await store.voice();
    } catch {
      available = false;
      voiceReason = "Voice settings could not be read. Writing can continue.";
      speechFeed?.emit({ type: "stop" });
      return voice();
    }
    try {
      available = (await client.voiceStatus()).available;
      voiceReason = available ? "" : "Connect ChatGPT in Settings → Connections.";
    } catch {
      available = false;
      voiceReason = "ChatGPT voice is unavailable. Check Settings → Connections.";
    }
    if (!available) speechFeed?.emit({ type: "stop" });
    return voice();
  }
  function newSpeechFeed() {
    speechFeed?.emit({ type: "stop" });
    speechFeed = createSpeechFeed(
      threadId,
      () => voice().enabled && !voiceError,
      message => {
        voiceError = message;
        publish();
      },
    );
    return speechFeed;
  }
  function cancelWriting() {
    if (!writing) return;
    clearTimeout(writing.timer!);
    for (const item of writing.items.values()) item.buffer.cancel();
  }
  function begin(turnId: string | null) {
    if (writing?.id === turnId && !writing.done) return;
    cancelWriting();
    writing = { id: turnId, items: new Map(), page: sendingPage, timer: null, done: false };
    voiceError = "";
    newSpeechFeed();
  }
  function streamed(turnId: string, item: Item, delta?: string) {
    if (finished.has(turnId) || (item.phase && item.phase !== "final_answer")) return;
    if (!writing || writing.done) begin(turnId);
    if (!writing!.id) writing!.id = turnId;
    if (writing!.id !== turnId) return;
    let stream = writing!.items.get(item.id);
    if (!stream) {
      let separator = writing!.items.size ? "\n\n" : "";
      for (const previous of writing!.items.values()) previous.buffer.finish();
      stream = {
        raw: "",
        buffer: createSentenceBuffer(chunk => {
          speechFeed?.emit({ type: "text", text: separator + chunk });
          separator = "";
        }),
      };
      writing!.items.set(item.id, stream);
    }
    const next = delta ?? (item.text?.startsWith(stream.raw) ? item.text.slice(stream.raw.length) : "");
    stream.raw += next;
    stream.buffer.push(next);
    if (!writing!.timer) {
      const current = writing!;
      current.timer = setTimeout(() => {
        current.timer = null;
        if (current.done) return;
        const note = [...current.items.values()].map(item => item.buffer.text()).join("\n\n");
        work = work
          .catch(() => {})
          .then(() =>
            store.reply(turnId, note, agentColor, current.page ?? turnPages.get(turnId), [], { preview: true }),
          )
          .catch(cause => {
            error = cause.message;
            publish();
          });
      }, 300).unref();
    }
  }
  function upsert(turnId: string, item: Item) {
    const at = entries.findIndex(e => e.turnId === turnId && e.item.id === item.id);
    const entry = { turnId, item };
    entries = at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e));
  }
  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      await refreshVoice();
      matilda = await store.matildaSettings();
      threadId = await store.chat();
      // A chat deleted from the sidebar is gone for good once Elpis quits; the next message starts a new one.
      const result =
        threadId &&
        (await client.readThread(threadId, { limit: 100 }).catch(cause => {
          if (!MISSING.test(cause?.message ?? "")) throw cause;
          stale = threadId;
          threadId = null;
          return null;
        }));
      if (result) {
        thread = result.thread;
        entries = [...result.data].reverse() as Entry[];
        const { scene } = await store.read();
        await store.repairPaintings(await paintingsToRepair(client, threadId!, scene, { entries, nextCursor: result.nextCursor }));
        const resumed = await client.resume(threadId, {});
        activeTurnId = resumed.activeTurnId ?? null;
      }
      loaded = true;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }
  const event = (value: EngineEvent) => {
    if (closed || value.type !== "message") return;
    const { method, params } = value.data;
    if (params.threadId !== threadId) return;
    let heartReaction;
    if (method === "turn/started") {
      activeTurnId = params.turn.id;
      error = "";
      if (!writing || writing.done) begin(params.turn.id);
      else writing.id ??= params.turn.id;
    }
    if (method === "item/started" && params.item?.type === "agentMessage") upsert(params.turnId, params.item);
    if (method === "item/completed" && ["userMessage", "agentMessage"].includes(params.item?.type as string)) {
      if (params.item.type === "userMessage")
        entries = entries.filter(e => e.turnId !== params.turnId || !e.item.id.startsWith("love-prompt-"));
      upsert(params.turnId, params.item);
      if (params.item.type === "agentMessage") {
        streamed(params.turnId, params.item);
        if (writing?.id === params.turnId) writing!.items.get(params.item.id)?.buffer.finish();
        const turnParts = parts.get(params.turnId) ?? new Map();
        turnParts.set(params.item.id, params.item);
        parts.set(params.turnId, turnParts);
      }
    }
    if (method === "item/agentMessage/delta") {
      const previous = entries.find(e => e.turnId === params.turnId && e.item.id === params.itemId)?.item;
      const item = {
        ...previous,
        id: params.itemId,
        type: "agentMessage",
        text: (previous?.text ?? "") + params.delta,
      };
      upsert(params.turnId, item);
      streamed(params.turnId, item, params.delta);
    }
    if (method === "turn/completed") {
      const turn = params.turn;
      if (finished.has(turn.id)) return;
      finishedTurnId = turn.id;
      activeTurnId = null;
      const completed = turn.status === "completed" && !turn.error;
      const recorded = [...(parts.get(turn.id)?.values() ?? [])];
      const messages = (
        turn.items?.length
          ? turn.items
          : recorded.length
            ? recorded
            : entries.filter(entry => entry.turnId === turn.id).map(entry => entry.item)
      ).filter(item => item.type === "agentMessage");
      for (const item of messages) {
        upsert(turn.id, item);
        if (completed) streamed(turn.id, item);
      }
      const partial =
        writing?.id === turn.id
          ? [...writing!.items.values()]
              .map(item => item.buffer.text())
              .join("\n\n")
              .trim()
          : "";
      if (writing?.id === turn.id) {
        writing!.done = true;
        clearTimeout(writing!.timer!);
        for (const item of writing!.items.values()) {
          if (completed) item.buffer.finish();
          else item.buffer.cancel();
        }
      }
      speechFeed?.emit({ type: completed ? "done" : "stop" });
      finished.add(turn.id);
      if (finished.size > 100) finished.delete(finished.values().next().value!);
      const answers = finalAnswers(messages);
      const final = answers
        .map(item => item.text ?? "")
        .join("\n\n")
        .trim();
      const affectionate = (completed &&
        answers.findLast(item => ["kissSoft", "kissPuckered"].includes(replyPortrait(item.text).expression))) as
        Item | undefined;
      if (affectionate?.id && threadId)
        heartReaction = { threadId, itemId: affectionate.id, portrait: replyPortrait(affectionate.text).expression };
      parts.delete(turn.id);
      error = turn.error?.message || (turn.status === "failed" ? "Love Spot could not get a reply. Try again." : "");
      const { note, shapes } = splitPainting(final);
      if (turn.status === "completed" && !turn.error && (note || shapes.length)) {
        const page = turnPages.get(turn.id) ?? sendingPage;
        work = work
          .catch(() => {})
          .then(() => store.reply(turn.id, note, agentColor, page, shapes))
          .catch(cause => {
            error = cause.message || "The reply could not be added to the board.";
            publish();
          });
      } else if (!completed && partial) {
        const page = turnPages.get(turn.id) ?? sendingPage;
        work = work
          .catch(() => {})
          .then(() => store.reply(turn.id, partial, agentColor, page))
          .catch(cause => {
            error = cause.message;
            publish();
          });
      }
      turnPages.delete(turn.id);
    }
    if (method === "error" && !params.willRetry) {
      error = params.error?.message || params.message || "Love Spot could not get a reply.";
      speechFeed?.emit({ type: "stop" });
      cancelWriting();
    }
    publish(heartReaction);
  };
  client.on("event", event);
  async function startFresh(input: Record<string, unknown>) {
    object(input, ["threadId", "model", "provider", "cwd", "permissions", "persona"]);
    const sourceId = text(input.threadId, "thread ID", 200);
    const model = input.model === undefined ? undefined : text(input.model, "model", 200);
    const provider = input.provider === undefined ? undefined : text(input.provider, "provider", 200);
    const persona = input.persona === undefined ? "" : text(input.persona, "persona", 4000);
    await load();
    await work;

    const currentId = await store.chat();
    if (sending || (activeTurnId && threadId === currentId))
      throw new BridgeError("Love Spot is already replying. Wait for this turn.", 409);
    for (const id of new Set([currentId, sourceId].filter(Boolean))) {
      if (id === stale) continue;
      const live = await client.resume(id, {});
      if (live.activeTurnId) throw new BridgeError("Love Spot is already replying. Wait for this turn.", 409);
    }

    let made: Awaited<ReturnType<Client["createThread"]>> | undefined;
    const nextId = await store.chat(async directory => {
      made = await client.createThread({
        cwd: input.cwd ?? thread?.cwd ?? directory,
        name: "Love Spot",
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(input.permissions ? { permissions: input.permissions } : {}),
        instructions: `${INSTRUCTIONS}\n\nCurrent persona from Who you are.txt:\n${persona}`,
        automatic: true,
      });
      return made.thread.id;
    }, currentId ?? stale);
    const created = made as Awaited<ReturnType<Client["createThread"]>> | undefined;
    if (!created || nextId !== created.thread.id)
      throw new BridgeError("Love Spot changed in another window. Try again.", 409);

    speechFeed?.emit({ type: "stop" });
    cancelWriting();
    threadId = nextId;
    thread = created.thread;
    entries = [];
    activeTurnId = null;
    finishedTurnId = null;
    error = "";
    stale = undefined;
    loaded = true;
    writing = undefined;
    sendingPage = undefined;
    publish();
    return { thread, permissions: created.permissions ?? input.permissions };
  }
  return {
    busy: () => sending || !!activeTurnId,
    startFresh,
    /** Replies off: the reply she is writing stops, and her voice with it. */
    /** The one Matilda setting: on or off, and her model. Off also stops the reply she is writing. */
    async setMatilda(body: Record<string, unknown>) {
      object(body, ["replies", "model", "provider"]);
      if (body.replies !== undefined && typeof body.replies !== "boolean")
        throw new BridgeError("Invalid Matilda setting");
      for (const key of ["model", "provider"])
        if (body[key] !== undefined && body[key] !== null) text(body[key], key, 200);
      matilda = await store.matildaSettings(body);
      if (!matilda.replies) await this.stop();
      publish();
      return snapshot();
    },
    async matilda() {
      matilda = await store.matildaSettings();
      return matilda;
    },
    async stop() {
      await load();
      speechFeed?.emit({ type: "stop" });
      if (threadId && activeTurnId) await client.interrupt(threadId, { turnId: activeTurnId });
      return snapshot();
    },
    async read() {
      await load();
      return snapshot();
    },
    async voice() {
      await load();
      return refreshVoice();
    },
    async setVoice(body: Record<string, unknown>) {
      object(body, ["enabled"]);
      if (typeof body.enabled !== "boolean") throw new BridgeError("Invalid Voice preference");
      if (!audio.available) throw new BridgeError(audio.reason, 403);
      await load();
      if (!body.enabled) speechFeed?.emit({ type: "stop" });
      for (const item of writing?.items.values() ?? []) item.buffer.discard();
      await store.voice(!body.enabled);
      await refreshVoice();
      if (body.enabled && available && writing && !writing.done) {
        for (const item of writing.items.values()) item.buffer.discard();
        voiceError = "";
        newSpeechFeed();
      }
      publish();
      return voice();
    },
    async speech() {
      await load();
      if (!available) throw new BridgeError(voiceReason, 403);
      if (muted) throw new BridgeError("Matilda Voice is off.", 409);
      if (voiceError) throw new BridgeError(voiceError, 409);
      if (!speechFeed) throw new BridgeError("Matilda has no new reply to speak.", 409);
      return speechFeed;
    },
    async conversation(persona = "") {
      if (persona) text(persona, "persona", 4000);
      await refreshVoice();
      if (!available) throw new BridgeError(voiceReason, 403);
      if (muted) throw new BridgeError("Matilda Voice is off.", 409);
      const board = await store.read();
      return createLiveConversation({
        scene: board.scene,
        persona,
        store,
        silenced: () => muted || closed,
        saveReply: (turnId, words, preview) => {
          work = work
            .catch(() => {})
            .then(() => store.reply(turnId, words, agentColor, board.scene.page, [], { preview }))
            .catch(cause => {
              error = cause.message;
              publish();
            });
        },
      });
    },
    async send(raw: Record<string, unknown>) {
      let body = raw as unknown as SendBody;
      validateSendBody(body);
      matilda = await store.matildaSettings();
      // Off quiets her on the board; her pinned chat always works (Masih, 1 Nov: "disabling it shouldn't disrupt me from using
      // the pinned version").
      if (!matilda.replies && body.pinned !== true)
        throw new BridgeError("Matilda is off. Turn her on to talk to her.", 409);
      const { pinned: _pinned, drawingOnly, pageSession, ...rest } = body;
      body = rest;
      body = {
        ...body,
        model: body.model ?? matilda.model ?? undefined,
        provider: body.provider ?? matilda.provider ?? undefined,
      };
      if (sending) throw new BridgeError("Love Spot is already replying. Wait for this turn.", 409);
      sending = true;
      error = "";
      publish();
      try {
        await load();
        await work;
        await refreshVoice();
        if (activeTurnId) throw new BridgeError("Love Spot is already replying. Wait for this turn.", 409);
        const settings = await client.settings(),
          model = body.model || settings.main.model;
        if (standalone && SUBSCRIPTION_MODEL.test(model ?? "")) throw new BridgeError(SUBSCRIPTION_BLOCKED, 403);
        const selected = await findModel(client, body.provider, model ?? undefined);
        // Masih, 23 Oct: "I can't change her model!" A chat keeps its provider, so a model from another connection starts her a
        // new Love Spot chat; the board, which is where you talk, stays as it is.
        const provider = body.provider ?? settings.main.provider;
        if (threadId && thread && provider && thread.modelProvider && provider !== thread.modelProvider) {
          stale = threadId;
          threadId = null;
          thread = null;
          entries = [];
        }
        const board = await store.read();
        if (pageSession !== undefined && board.scene.page.session !== pageSession)
          throw new BridgeError("The Love Spot page changed. The pending note will wait for its page.", 409);
        const drawn = drawing(board.scene),
          unchanged = !!threadId && seen.get(threadId) === drawn;
        const action = await companion?.command(body.text, board.scene.page.session);
        const attachments: Attachment[] = messageAttachments(board.scene, unchanged, action, body.persona);
        // The board sends the revision it exported and must match it; the small chat elsewhere sends none and gets the
        // picture only while it still shows the drawing.
        // A picture of the drawing she last saw is checked as before but stays out of the chat.
        const exported = !selected?.inputModalities?.includes("image")
          ? null
          : body.revision === undefined
            ? await store.currentPicture()
            : await store.boardPicture(body.revision);
        const picture = unchanged ? null : exported;
        if (picture)
          attachments.push({
            id: "love-spot-picture",
            name: "view.png",
            type: "image",
            mimeType: "image/png",
            dataUrl: `data:image/png;base64,${picture}`,
          });
        // A synthetic drawing notice without a new picture gives her nothing new to look at. Wait silently;
        // actual written messages still go through, and the next changed picture can be sent normally.
        if (!picture && drawingOnly && body.text.trim() === "I drew something on the board.")
          return { ...snapshot(), busy: false, turn: null, waitingForPicture: true };
        if (!threadId) {
          threadId = await store.chat(
            async cwd => {
              const made = await client.createThread({
                cwd,
                name: "Love Spot",
                model,
                ...(body.provider ? { provider: body.provider } : {}),
                instructions: INSTRUCTIONS,
                automatic: true,
              });
              thread = made.thread;
              return made.thread.id;
            },
            stale as string | undefined,
          );
          if (!thread) thread = (await client.readThread(threadId)).thread;
        }
        // Masih, 23 Oct: "set her thinking to low so it be faster, and set her to /fast as well". Fast is asked for once per
        // chat; a model or account without it still answers, at normal speed.
        if (!fastAsked.has(threadId!)) {
          fastAsked.add(threadId!);
          await client
            .setServiceTier(threadId, { enabled: true })
            .catch(cause => console.warn(`Love Spot stays at normal speed: ${cause.message}`));
        }
        sendingPage = board.scene.page;
        begin(null);
        const result = (await client.send(threadId, {
          text: body.text,
          model,
          effort: "low",
          attachments,
          automatic: true,
        })) as { turn: { id: string } };
        if (picture) seen.set(threadId!, drawn);
        writing!.id ??= result.turn.id;
        turnPages.set(result.turn.id, sendingPage);
        // Some local providers finish before send returns; do not revive their completed turn.
        if (finishedTurnId !== result.turn.id) activeTurnId = result.turn.id;
        if (!entries.some(e => e.turnId === result.turn.id && e.item.type === "userMessage"))
          upsert(result.turn.id, {
            id: `love-prompt-${result.turn.id}`,
            type: "userMessage",
            content: [{ type: "text", text: body.text }],
          });
        return { ...snapshot(), busy: !!activeTurnId, turn: result.turn };
      } catch (cause) {
        error = (cause as Error).message;
        speechFeed?.emit({ type: "stop" });
        throw cause;
      } finally {
        sending = false;
        sendingPage = undefined;
        publish();
      }
    },
    async watch(listen: (value: ReturnType<typeof snapshot> & { heartReaction?: HeartReaction }) => void) {
      await load();
      listeners.add(listen);
      listen(snapshot());
      return () => listeners.delete(listen);
    },
    idle: () => work,
    close() {
      closed = true;
      speechFeed?.emit({ type: "stop" });
      cancelWriting();
      client.off("event", event);
      listeners.clear();
    },
  };
}
