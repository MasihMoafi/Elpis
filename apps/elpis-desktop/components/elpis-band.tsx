import { ElpisMarkIcon } from "@/components/elpis-icons";
import { agentParentId } from "@/lib/agent-runs.mts";
import { agentState } from "@/lib/agents";
import type { Thread } from "@/lib/api";

/**
 * The band at the top of the Elpis chat: its name and, in one line, what his chats are doing. It marks the chat as the
 * assistant's own place (11 Nov, Masih: "a different more attractive look ... so it's different from the rest") with
 * something he would otherwise ask for.
 */
export function ElpisBand({ threads }: { threads: Thread[] }) {
  // His own chats: not the Elpis chat, and not the agents a chat started.
  const chats = threads.filter(thread => !thread.motherAgent && !agentParentId(thread));
  const count = (state: ReturnType<typeof agentState>) => chats.filter(thread => agentState(thread) === state).length;
  const waiting = count("waiting"),
    working = count("working");
  const line = [
    waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : "",
    `${working} working`,
    `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`,
  ].filter(Boolean);
  return (
    <div className="elpis-band" role="status" aria-label="Your chats">
      <ElpisMarkIcon size={16} />
      <strong>Elpis</strong>
      <span>{line.join(" · ")}</span>
    </div>
  );
}
