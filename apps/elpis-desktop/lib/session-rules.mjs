// The Session Manager's rules (R43, R47): which chats need a name, and which no longer need Masih. No model, no timer.
const DAY = 86400000;
/** Days without activity before a chat that no longer needs Masih is archived. */
const ARCHIVE_AFTER = { empty: 1, finished: 3, abandoned: 7 };
const REASONS = {
  empty: 'Archived by the Session Manager: empty, unused for a day.',
  finished: 'Archived by the Session Manager: finished, untouched for 3 days.',
  abandoned: 'Archived by the Session Manager: stopped before finishing, untouched for 7 days.',
};

export const sessionTime = value => Number.isFinite(value) && value > 0 ? value < 1e12 ? value * 1000 : value : 0;
const textOf = item => typeof item?.text === 'string' ? item.text : (item?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
const sessionReply = turn => textOf([...(turn?.items ?? [])].reverse().find(item => item.type === 'agentMessage'));

/** Inspect the current turn only: older questions stop waiting when the user replies. */
export function classifySession(thread, turn, approvals = []) {
  const flags = thread.status?.activeFlags ?? [];
  if (flags.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) || approvals.some(row => (row.params?.threadId ?? row.ownerThreadId) === thread.id))
    return 'needs';
  if (turn?.error || turn?.status === 'failed' || thread.status?.type === 'systemError') return 'needs';
  if (thread.status?.type === 'active' || turn?.status === 'inProgress') return 'running';
  if (turn?.status !== 'completed') return 'idle';
  const items = turn.items ?? [], last = [...items].reverse().find(item => ['agentMessage', 'userMessage'].includes(item.type));
  if (last?.type !== 'agentMessage') return 'idle';
  // Examples, quotations and URLs are not requests to the person reading the reply.
  const prose = sessionReply(turn).replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*>.*$/gm, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '').trim();
  const paragraphs = prose.split(/\n\s*\n/).slice(-2).join('\n');
  if (/\b(?:which|what|where|when|who|how|can you|could you|would you|do you|may i|should (?:i|we)|is (?:this|that)|are you|question for you)\b[^?\n]*\?/i.test(paragraphs)
    || /\b(?:i (?:need|am waiting for)|please (?:confirm|choose|provide|share|approve|tell me)|choose \d|approve the spec)\b/i.test(paragraphs)
    || /\b(?:we|i) (?:pause|paused|am waiting|are waiting)(?: here)? (?:until|for) (?:your|you|approval|confirmation|the [^.\n;]{0,50}(?:clear|approved))\b/i.test(paragraphs))
    return 'needs';
  return 'done';
}

const PLACEHOLDER = /^(?:untitled(?: conversation| chat)?|new chat|new conversation)$/i;
const FILLER = /^(?:h+|hi+|hey+|hello+|yo|salam|salaam|سلام|test(?:ing)?|ok(?:ay)?|yes|no|continue|go on|proceed|thanks?|thank you)$/i;
/** A placeholder the app gave the chat, not a name Masih chose. */
export const placeholder = name => PLACEHOLDER.test(name?.trim() ?? '');
/** Worth showing as a title: three letters or more, and not a placeholder or a greeting. */
function meaningful(text) {
  const plain = (text ?? '').replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
  return !PLACEHOLDER.test(plain) && !FILLER.test(plain) && (plain.match(/\p{L}/gu)?.length ?? 0) >= 3;
}
const cleanLine = line => line.replace(/^\s*[#>*-]+\s*/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
/** True when the title the chat list shows (its name, else its first line) says nothing, as "h" does. */
export const needsName = thread => !meaningful(thread.name?.trim() || cleanLine(thread.preview?.split('\n').find(line => line.trim()) ?? ''));

/** A name from the chat's own requests: the first line worth a title, cut at a word within 60 characters. */
export function chatName(prompts) {
  for (const { text } of prompts) {
    if (typeof text !== 'string' || /^\s*(?:you are\b|<|\[system|# AGENTS\.md)/i.test(text)) continue;
    const line = text.split('\n').map(cleanLine).find(meaningful);
    if (!line) continue;
    const name = Array.from(line).length <= 60 ? line : Array.from(line).slice(0, 60).join('').replace(/\s+\S*$/, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return null;
}

const idleDays = (thread, now) => sessionTime(thread.updatedAt) ? (now - Math.max(sessionTime(thread.updatedAt), sessionTime(thread.recencyAt))) / DAY : 0;
/** Quiet long enough for any archive rule; checked from the chat list alone, before reading the chat. */
export const mayArchive = (thread, now) => idleDays(thread, now) >= Math.min(...Object.values(ARCHIVE_AFTER));

/** Why a chat no longer needs Masih, or null. Callers have already left out his named, protected and family chats. */
export function archiveReason(thread, turn, approvals, now) {
  const days = idleDays(thread, now);
  if (!days) return null;
  const state = classifySession(thread, turn, approvals);
  const kind = state === 'idle' && !turn && !thread.preview?.trim() ? 'empty' : { done: 'finished', idle: 'abandoned' }[state];
  return kind && days >= ARCHIVE_AFTER[kind] ? REASONS[kind] : null;
}
