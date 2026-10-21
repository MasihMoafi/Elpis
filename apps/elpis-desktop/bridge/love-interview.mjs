export const INVALID_INTERVIEW_REPLY = 'The agent sent an invalid interview reply. Retry to ask it again.';
const PREFIX = 'Continue the interview. Conversation:\n';
const line = value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\r\n{}\[\]`]/.test(value);

export function interviewReply(answer, answered) {
  let reply;
  try { reply = JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')); } catch { return null; }
  if (!reply || Array.isArray(reply) || Object.keys(reply).length !== 1) return null;
  if (line(reply.question) && (reply.question.match(/\?/g) ?? []).length <= 1) return { question: reply.question.trim() };
  if (answered && line(reply.task)) return { proposal: reply.task.trim() };
  return null;
}

const promptText = item => item?.type === 'userMessage' && item.content?.length === 1 && item.content[0].type === 'text' && typeof item.content[0].text === 'string' ? item.content[0].text : '';
export function legacyInterview(thread) {
  return typeof thread.name === 'string' && thread.name.startsWith('Love Spot · ') && (typeof thread.preview === 'string' && thread.preview.startsWith(PREFIX.trimEnd()) || thread.turns?.some(turn => turn.items?.some(item => promptText(item).startsWith(PREFIX))));
}

// Old versions saved each internal interview call as a chat. Decode its display without changing the saved session.
export function interviewTurns(turns) {
  return turns.map(turn => {
    const prompt = turn.items?.find(item => promptText(item).startsWith(PREFIX));
    if (!prompt) return turn;
    let messages = [];
    try {
      const saved = JSON.parse(promptText(prompt).slice(PREFIX.length));
      if (Array.isArray(saved) && saved.length <= 40 && saved.every(m => m && ['assistant', 'user'].includes(m.role) && typeof m.text === 'string')) messages = saved;
    } catch { /* Unreadable internal history is never shown as a user message. */ }
    return { ...turn, items: turn.items.flatMap(item => {
      if (item === prompt) return messages.map((m, i) => ({ id: `${item.id}-interview-${i}`, ...(m.role === 'user' ? { type: 'userMessage', content: [{ type: 'text', text: m.text }] } : { type: 'agentMessage', phase: 'final_answer', text: line(m.text) ? m.text : INVALID_INTERVIEW_REPLY }) }));
      if (item.type !== 'agentMessage') return [item];
      const reply = interviewReply(item.text ?? '', messages.some(m => m.role === 'user'));
      return [{ ...item, text: reply?.question ?? (reply?.proposal ? `Proposed task: ${reply.proposal}` : INVALID_INTERVIEW_REPLY) }];
    }) };
  });
}
