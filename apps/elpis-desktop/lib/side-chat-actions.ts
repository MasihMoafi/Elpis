import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SideChatState } from "@/lib/use-composer-panels";
import type { useConversationSession } from "@/lib/use-conversation-session";

type Inputs = {
  session: ReturnType<typeof useConversationSession>;
  readOnlyRun: boolean;
  sideRequests: RefObject<number>;
  setSideChat: Dispatch<SetStateAction<SideChatState>>;
  setError: Dispatch<SetStateAction<string>>;
};

export function createSideChatActions({ session, readOnlyRun, sideRequests, setSideChat, setError }: Inputs) {
  const { selected, entries } = session;
  function askSideQuestion(question?: string) {
    if (readOnlyRun) return;
    if (!selected) {
      setError("Start a conversation before asking a side question.");
      return;
    }
    setSideChat({ parentId: selected.id, open: true, question: { id: ++sideRequests.current, text: question ?? "" } });
  }
  function recapConversation() {
    if (!selected || readOnlyRun) return;
    if (!entries.length) {
      setError("There is no conversation history to recap.");
      return;
    }
    setSideChat({
      parentId: selected.id,
      open: true,
      question: {
        id: ++sideRequests.current,
        kind: "recap",
        text: "Recap the conversation so far for the person returning to it. Briefly state the goal, key decisions, completed work, what is still open, and the next useful step. Use only the existing conversation. Do not use tools or perform the work.",
      },
    });
  }
  return { askSideQuestion, recapConversation };
}
