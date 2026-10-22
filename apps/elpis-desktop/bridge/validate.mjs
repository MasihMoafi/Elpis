/** The request checks the bridge modules share; client.mjs re-exports them under the names they have always had. */
import path from 'node:path';

export class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new BridgeError('Unsupported request fields');
  }
  return value;
}
export function text(value, label, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BridgeError(`Invalid ${label}`);
  return value;
}
export function threadId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new BridgeError('Invalid thread ID');
  return value;
}
/** An optional project folder must be an absolute path; returns it (or undefined) unchanged. */
export function projectFolder(value) {
  if (value != null) { text(value, 'project folder', 4096); if (!path.isAbsolute(value)) throw new BridgeError('Choose a project folder'); }
  return value;
}
