import type { createRunStorage } from './create-run-storage.mts';
import { randomUUID } from 'node:crypto';
import type { ProgressEntry, ProgressUpdate, PermissionRequest } from './types.mts';

export function createRunProgress({ save, progressTimers }: {
  save: ReturnType<typeof createRunStorage>['save'];
  progressTimers: Map<string, NodeJS.Timeout>
}) {

  const logLine = (record: { id: string; log?: { at: number; text: string }[]; persistenceError?: string }, text: string) => { (record.log ??= []).push({ at: Date.now(), text }); void save(record).catch(error => { record.persistenceError = (error as Error).message; }); };

  const progress = (record: { id: string; persistenceError?: string }, task: { progress?: ProgressEntry[] }, update: ProgressUpdate) => {
    const entries = task.progress ??= [], at = Date.now();
    if ((update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'agent_thought_chunk') && update.content?.type === 'text') {
      const last = entries.at(-1), kind = update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text';
      if (last?.kind === kind && last.messageId === update.messageId) { last.text = (last.text + update.content.text).slice(-8000); last.at = at; }
      else entries.push({ kind, messageId: update.messageId, text: update.content.text.slice(-8000), at });
    } else if ((update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')) {
      let entry = entries.find(row => row.kind === 'tool' && row.id === update.toolCallId);
      if (!entry) entries.push(entry = { kind: 'tool', id: update.toolCallId });
      Object.assign(entry, { at, ...(update.title ? { title: String(update.title).slice(0, 1000) } : {}), ...(update.status ? { status: update.status } : {}) });
    } else return;
    let size = entries.reduce((total, entry) => total + (entry.text?.length ?? 0) + (entry.title?.length ?? 0), 0);
    while (entries.length > 1 && (entries.length > 80 || size > 32000)) { const removed = entries.shift()!; size -= (removed.text?.length ?? 0) + (removed.title?.length ?? 0); }
    if (!progressTimers.has(record.id)) progressTimers.set(record.id, setTimeout(() => {
      progressTimers.delete(record.id); void save(record).catch(error => { record.persistenceError = (error as Error).message; });
    }, 200));
  };

  const permission = async (record: { id: string; round: number }, task: { title: string; progress?: ProgressEntry[]; permissions?: { at: number; round: number; sessionId?: string | undefined; toolCallId?: string | undefined; title: string; optionId: string | null }[] }, request: PermissionRequest) => {
    const options = request.options ?? [];
    const option = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind === 'allow_always');
    const entry = { at: Date.now(), round: record.round, sessionId: request.sessionId, toolCallId: request.toolCall?.toolCallId, title: String(request.toolCall?.title || task.title).slice(0, 1000), optionId: option?.optionId ?? null };
    const log = task.permissions ??= []; log.push(entry); if (log.length > 100) log.shift();
    progress(record, task, { sessionUpdate: 'agent_message_chunk', messageId: `permission-${randomUUID()}`, content: { type: 'text', text: `${option ? 'Allowed' : 'Refused'} automatically: ${entry.title}${option ? ` (${option.name || option.optionId})` : ' (no allow option offered)'}` } });
    await save(record); return entry.optionId;
  };
  return { progress, permission, logLine };
}
