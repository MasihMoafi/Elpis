export type DictationSelection = { text: string; start: number; end: number };

export function insertTranscript(current: string, selection: DictationSelection, transcript: string) {
  if (!transcript) return { text: current, caret: current.length };
  const unchanged = current === selection.text;
  const start = unchanged ? selection.start : current.length;
  const end = unchanged ? selection.end : current.length;
  const before = current.slice(0, start); const after = current.slice(end);
  const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${transcript}${after && !/^\s/.test(after) ? ' ' : ''}`;
  return { text: before + insert + after, caret: before.length + insert.length };
}
