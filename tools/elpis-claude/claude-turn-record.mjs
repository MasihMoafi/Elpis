import { open } from "node:fs/promises";

// A native terminal message is useful only after this turn's inputs, never a previous
// answer, a subagent's answer, a tool result, or a partly written JSONL record.
export async function recordedClaudeEnd(file, offset, inputs) {
  let handle;
  try {
    handle = await open(file, "r");
    if ((await handle.stat()).size <= offset) return null;
    let pending = "", users = "", last = null;
    for await (const chunk of handle.createReadStream({ start: offset, encoding: "utf8", autoClose: false })) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { return null; }
        if (row.isSidechain || !["user", "assistant"].includes(row.type)) continue;
        last = row;
        if (row.type === "user") users += "\n" + messageText(row.message?.content);
      }
    }
    if (pending.trim() || last?.type !== "assistant" || last.message?.stop_reason !== "end_turn") return null;
    let after = 0;
    for (const input of inputs.filter(text => text.trim())) {
      const at = users.indexOf(input.trim(), after);
      if (at === -1) return null;
      after = at + input.trim().length;
    }
    const text = messageText(last.message.content);
    return text.trim() ? { text, id: last.uuid ?? last.message.id } : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}

function messageText(content) {
  return typeof content === "string" ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
}
