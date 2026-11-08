import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ChatMessage } from "@/components/chat-message";
import { ImageReplyProvider, type ReplyImage } from "@/components/image-reply";
import { MatildaAutoVoice } from "@/components/matilda-auto-voice";
import { SelectionReply } from "@/components/message-reply";
import { ReadAloud } from "@/components/read-aloud";
import { Transcript } from "@/components/transcript";
import { ViewBoundary } from "@/components/view-boundary";
import { agentName, mediaUrl, type Entry, type Thread } from "@/lib/api";
import type { createConversationActions } from "@/lib/conversation-actions";
import { errorText } from "@/lib/error-text.mts";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import type { createMessageActions } from "@/lib/message-actions";
import { entryKey } from "@/lib/submitted-messages";
import {
  editableMessage,
  editBlocked,
  versionControl,
  type MessageVersion,
  type replacementEligibility,
} from "@/lib/turn-replacement";
import { without } from "@/lib/utils";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Handlers = {
  openById: (id: string) => void;
  focusComposer: () => void;
  replaceFrom: ReturnType<typeof createMessageActions>["replaceFrom"];
  forkFrom: ReturnType<typeof createConversationActions>["forkFrom"];
  showVersion: ReturnType<typeof createMessageActions>["showVersion"];
  deleteFrom: ReturnType<typeof createMessageActions>["deleteFrom"];
  setRewindTurn: Setter<string | null>;
  setMessageEdits: Setter<Record<string, string>>;
  setError: Setter<string>;
  beginReply: (entry: Entry, quote?: string) => void;
  beginImageReply: (entry: Entry, image: ReplyImage) => Promise<void>;
};
type Inputs = {
  live: RefObject<Handlers>;
  selected: Thread | null;
  shownEntries: Entry[];
  activeTurn: string | undefined;
  desktop: boolean;
  openChanges: () => void;
  threads: Thread[];
  messageEdits: Record<string, string>;
  pendingDrafts: Record<string, boolean>;
  replaceable: boolean;
  replacementOptions: Map<string, ReturnType<typeof replacementEligibility>>;
  replacementOptionsKey: string;
  readOnlyRun: boolean;
  versionsShown: MessageVersion[] | undefined;
  newestPrompt: string | undefined;
  regenerate: { turnId: string; prompt: string; replyId: string } | null;
  connected: boolean;
  voiceBusy: boolean;
  loveSpotAudioReason: string | undefined;
};

export function useConversationTranscript({
  live,
  selected,
  shownEntries,
  activeTurn,
  desktop,
  openChanges,
  threads,
  messageEdits,
  pendingDrafts,
  replaceable,
  replacementOptions,
  replacementOptionsKey,
  readOnlyRun,
  versionsShown,
  newestPrompt,
  regenerate,
  connected,
  voiceBusy,
  loveSpotAudioReason,
}: Inputs) {
  // The transcript redraws only when what it shows changes; its handlers read the current render through `live`.
  const conversation = useMemo(
    () => (
      <ViewBoundary label="The conversation" resetKey={selected?.id}>
        {selected && !readOnlyRun && (
          <SelectionReply
            key={selected.id}
            onQuote={(reference, text) => {
              const entry = shownEntries.find(entry => entryKey(entry) === reference);
              if (entry) live.current.beginReply(entry, text);
            }}
          />
        )}
        <Transcript
          entries={shownEntries}
          activeTurnId={activeTurn ?? null}
          wrapItem={(entry, node) => (
            <ImageReplyProvider
              reference={entryKey(entry)}
              {...(selected && !readOnlyRun && !entry.clientPending
                ? {
                    onReply: (image: ReplyImage) => {
                      void live.current.beginImageReply(entry, image);
                    },
                  }
                : {})}
            >
              {node}
            </ImageReplyProvider>
          )}
          {...(desktop && selected ? { onViewChanges: openChanges } : {})}
          mediaOf={e => (selected ? mediaUrl(selected.id, e) : undefined)}
          renderItem={e => {
            const editKey = JSON.stringify([selected?.id, e.turnId, e.item.id]);
            const model = e.item.type === "agentMessage" ? e.model : undefined;
            const onReply =
              selected &&
              !readOnlyRun &&
              !e.clientPending &&
              (e.item.type === "userMessage" || e.item.type === "agentMessage")
                ? () => live.current.beginReply(e)
                : undefined;
            const mediaBase = selected ? mediaUrl(selected.id, e) : undefined;
            const editDraft = messageEdits[editKey];
            const onEdit =
              !e.clientPending &&
              replaceable &&
              e.item.type === "userMessage" &&
              editableMessage(replacementOptions.get(e.turnId), e.item.id)
                ? (text: string) => live.current.replaceFrom(e.turnId, text, editKey)
                : undefined;
            const editBlockedReason =
              replaceable && e.item.type === "userMessage"
                ? editBlocked(replacementOptions.get(e.turnId), e.item.id)
                : undefined;
            const version =
              e.item.type === "userMessage"
                ? versionControl(
                    versionsShown,
                    e.turnId,
                    replacementOptions.get(e.turnId),
                    e.item.id,
                    replaceable,
                    target => {
                      live.current.showVersion(target).catch(error => live.current.setError(String(errorText(error))));
                    },
                  )
                : undefined;
            const time = e.item.type === "userMessage" ? e.startedAtMs : undefined;
            const onFork =
              selected && !readOnlyRun && e.item.type === "agentMessage" && e.turnId !== activeTurn
                ? () => void live.current.forkFrom(selected, e.turnId, e.item.id)
                : undefined;
            const onRewind =
              !e.clientPending && replaceable && e.item.type === "userMessage" && e.item.id !== newestPrompt
                ? () => live.current.setRewindTurn(e.turnId)
                : undefined;
            const onDelete =
              !e.clientPending && replaceable && e.item.type === "userMessage"
                ? {
                    label: e.item.id === newestPrompt ? "Delete message" : "Delete from here",
                    run: () => {
                      live.current.deleteFrom(e.turnId).catch(error => live.current.setError(String(errorText(error))));
                    },
                  }
                : undefined;
            const onRegenerate =
              regenerate && e.item.id === regenerate.replyId
                ? () => {
                    live.current
                      .replaceFrom(regenerate.turnId, regenerate.prompt)
                      .catch(error => live.current.setError(String(errorText(error))));
                  }
                : undefined;
            return (
              <ChatMessage
                key={e.clientKey ?? editKey}
                item={e.item}
                {...(model !== undefined ? { model } : {})}
                readAloud={
                  !e.clientPending &&
                  (e.turnId !== activeTurn || e.completedAtMs !== undefined) &&
                  e.item.status !== "inProgress"
                }
                reference={entryKey(e)}
                {...(onReply ? { onReply } : {})}
                {...(mediaBase !== undefined ? { mediaBase } : {})}
                threads={threads}
                speaker={agentName(selected) || "Elpis"}
                onOpenThread={id => live.current.openById(id)}
                {...(editDraft !== undefined ? { editDraft } : {})}
                editPending={!!pendingDrafts[editKey]}
                onEditDraftChange={value => {
                  live.current.setMessageEdits(previous =>
                    value === null ? without(previous, editKey) : { ...previous, [editKey]: value },
                  );
                  if (value === null) live.current.focusComposer();
                }}
                {...(onEdit ? { onEdit } : {})}
                {...(editBlockedReason !== undefined ? { editBlockedReason } : {})}
                {...(version ? { version } : {})}
                {...(time !== undefined ? { time } : {})}
                {...(onFork ? { onFork } : {})}
                {...(onRewind ? { onRewind } : {})}
                {...(onDelete ? { onDelete } : {})}
                {...(onRegenerate ? { onRegenerate } : {})}
              />
            );
          }}
        />
      </ViewBoundary>
    ),
    [
      shownEntries,
      activeTurn,
      desktop,
      selected,
      openChanges,
      threads,
      messageEdits,
      pendingDrafts,
      replaceable,
      replacementOptionsKey,
      readOnlyRun,
      versionsShown,
      regenerate?.turnId,
      regenerate?.replyId,
      regenerate?.prompt,
    ],
  );
  const available = selected && agentName(selected) === "Matilda" ? LOVE_SPOT_AUDIO.readAloudAvailable : undefined;
  // Keep the conversation's context providers outside composer-only renders.
  return useMemo(
    () => (
      <ReadAloud
        {...(selected ? { threadId: selected.id } : {})}
        enabled={connected && !!selected}
        {...(available !== undefined ? { available } : {})}
        {...(loveSpotAudioReason !== undefined ? { unavailableReason: loveSpotAudioReason } : {})}
      >
        {selected && !loveSpotAudioReason && agentName(selected) === "Matilda" && (
          <MatildaAutoVoice
            key={selected.id}
            threadId={selected.id}
            activeTurnId={activeTurn ?? null}
            entries={shownEntries}
            disabled={!connected || voiceBusy}
          />
        )}
        {conversation}
      </ReadAloud>
    ),
    [selected, connected, activeTurn, shownEntries, voiceBusy, conversation, loveSpotAudioReason],
  );
}
