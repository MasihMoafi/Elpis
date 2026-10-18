// The inline chat entry names an attempt and call; exact texts stay in the core's audit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError, elpisHome } from './client.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
async function confined(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new BridgeError('Invalid Smart Prune artifact', 400);
  const [base, target] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, relative))]);
  if (!target.startsWith(base + path.sep)) throw new BridgeError('Invalid Smart Prune artifact', 400);
  return JSON.parse(await fs.readFile(target, 'utf8'));
}
function output(item) {
  const value = item?.output;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => part.type === 'input_text' && typeof part.text === 'string')) return value.map(part => part.text).join('\n');
  throw new BridgeError('Smart Prune text is unavailable', 404);
}

export async function smartPruneDetail(home = elpisHome(), threadId, attemptId, callId) {
  if (!id(attemptId) || typeof callId !== 'string' || !callId || callId.length > 1000) throw new BridgeError('Invalid Smart Prune record', 400);
  try {
    const root = path.join(home, 'logs', 'smart-prune');
    const attempt = await confined(root, `attempts/${attemptId}.json`);
    if (attempt.attempt_id !== attemptId || (attempt.thread_id ?? attempt.session_id) !== threadId) throw new BridgeError('Smart Prune record not found in this chat', 404);
    const candidate = JSON.parse(attempt.input).items?.find(item => item.call_id === callId);
    if (!candidate) throw new BridgeError('Smart Prune tool output not found', 404);
    let compact = null;
    if (attempt.status === 'admitted') {
      if (!id(attempt.admission_id)) throw new BridgeError('Committed Smart Prune output is unavailable', 404);
      const dir = `admissions/${attempt.admission_id}`;
      const manifest = await confined(root, `${dir}/manifest.json`);
      const item = manifest.items?.find(item => item.call_id === callId);
      if (!item) throw new BridgeError('Committed Smart Prune output is unavailable', 404);
      compact = output(await confined(root, `${dir}/${item.admitted_artifact}`));
    }
    return { original: output(candidate.source_output), compact };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('Cannot read Smart Prune evidence from this runtime', 404);
  }
}
