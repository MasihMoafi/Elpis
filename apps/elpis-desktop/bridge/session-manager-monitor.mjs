// The always-on Session Manager (Masih, 20–21 October): it reviews the chats by itself when three or more of his chats
// run at once, or three were started within about twenty minutes. The engine's chat list is the only source of truth:
// on each chat or turn start the monitor reads it, so a missed or duplicated event cannot miscount.

export const REVIEW_THRESHOLD = 3;
export const REVIEW_WINDOW_MS = 20 * 60 * 1000;
const TRIGGERS = new Set(['thread/started', 'turn/started', 'thread/status/changed']);

/** The review a chat list calls for, or null: `key` names the exact set so an unchanged set is reviewed once. */
export function reviewReason(threads, { isManager, now, threshold = REVIEW_THRESHOLD, windowMs = REVIEW_WINDOW_MS }) {
  const chats = threads.filter(thread => !thread.parentThreadId && !thread.ephemeral && !isManager(thread.id));
  const running = chats.filter(thread => thread.status?.type === 'active').map(thread => thread.id).sort();
  if (running.length >= threshold) return { key: `running:${running.join(',')}`, text: `${running.length} chats are running at once` };
  const since = (now - windowMs) / 1000;
  const recent = chats.filter(thread => Number(thread.createdAt) >= since).map(thread => thread.id).sort();
  if (recent.length >= threshold) return { key: `created:${recent.join(',')}`, text: `${recent.length} chats were started in the last ${Math.round(windowMs / 60000)} minutes` };
  return null;
}

/** Watches engine messages and calls `review(reason)` once per new set; a review asked for while one runs waits. */
export function createSessionManagerMonitor({ list, isManager, review, now = Date.now, debounceMs = 1500, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, lastKey = '', running = false, waiting = null, closed = false;
  async function run(reason) {
    if (running) { waiting = reason; return; }
    running = true;
    try { await review(reason); }
    catch (error) { log(`Session Manager review failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally {
      running = false;
      const next = waiting; waiting = null;
      if (next && !closed) await run(next);
    }
  }
  async function check() {
    timer = null;
    if (closed) return;
    let threads;
    try { threads = (await list()).data ?? []; }
    catch (error) { log(`Session Manager could not read the chats: ${error instanceof Error ? error.message : String(error)}`); return; }
    const reason = reviewReason(threads, { isManager, now: now() });
    if (!reason || reason.key === lastKey) return;
    lastKey = reason.key;
    await run(reason);
  }
  return {
    observe(message) {
      if (closed || !TRIGGERS.has(message?.method)) return;
      if (message.method === 'thread/status/changed' && message.params?.status?.type !== 'active') return;
      if (isManager(message.params?.threadId ?? message.params?.thread?.id)) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => { void check(); }, debounceMs);
    },
    check,
    close() { closed = true; if (timer) clearTimer(timer); timer = null; },
  };
}

/** What the manager is asked when the monitor wakes it; the manager's own instructions keep the approval rules. */
export const reviewPrompt = reason => `Automatic review: ${reason.text}. Use session_list. Propose short task names for unnamed or unclear chats, group related chats, and list chats that look finished and safe to archive, each with its reason. Rename or archive only through your tools' approvals.`;
