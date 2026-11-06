/** The request checks the bridge modules share; client.mjs re-exports them under the names they have always had. */
import path from 'node:path';

export class BridgeError extends Error {
  status: number;
  constructor(message?: string | null, status = 400) { super(message as string | undefined); this.status = status; }
}
export function object<T>(value: T, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new BridgeError('Unsupported request fields');
  }
  return value;
}
export function text(value: unknown, label: string, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BridgeError(`Invalid ${label}`);
  return value;
}
export function threadId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new BridgeError('Invalid thread ID');
  return value;
}
/** An optional project folder must be an absolute path; returns it (or undefined) unchanged. */
export function projectFolder<T>(value: T) {
  if (value != null) { const folder = text(value, 'project folder', 4096); if (!path.isAbsolute(folder)) throw new BridgeError('Choose a project folder'); }
  return value;
}
