/**
 * A voice chat hands what Masih said to the agent as a user message that is only a <realtime_delegation> envelope (the
 * engine's realtime_delegation.rs). It is the call's plumbing, not something he typed, so the chat, its prompt list and
 * its export leave it out (Masih, 23 Oct: "we don't want this in the chat"). A typed message that mentions the tag stays.
 * @param {{ type?: string, content?: Array<{ type?: string, text?: string }> }} item
 */
function isVoiceHandoff(item) {
  if (item?.type !== 'userMessage' || !Array.isArray(item.content) || item.content.length !== 1) return false;
  const part = item.content[0], text = part?.type === 'text' && typeof part.text === 'string' ? part.text.trim() : '';
  return text.startsWith('<realtime_delegation>') && text.endsWith('</realtime_delegation>');
}

module.exports = { isVoiceHandoff };
