// Provider API keys pasted into the desktop, kept where the terminal keeps them: one owner-only
// `provider-keys.json` in the Elpis home, mapping provider ID to key (codex-rs/elpis-gateway/src/keys.rs).
// The gateway reads it on every request, so a saved key works at once in every Elpis process
// using this home. Keys are never returned, logged or put in an error message.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BridgeError } from './client.mjs';

const FILE_NAME = 'provider-keys.json';
const MAX_FILE_BYTES = 16_384;
const MAX_KEY_BYTES = 8_192;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function ownedDirectory(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new BridgeError('The Elpis home folder is unknown, so the key was not saved.', 503);
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new BridgeError('The Elpis home folder must be a folder you own, not a link.', 403);
}

/** The saved keys, or an empty map when there is no file yet. */
export function loadProviderKeys(home) {
  const file = path.join(home, FILE_NAME);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new BridgeError('The saved provider keys file must be a file you own, not a link.', 403);
  if (stat.size > MAX_FILE_BYTES) throw new BridgeError('The saved provider keys file is too large.', 413);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([id, key]) => PROVIDER_ID.test(id) && typeof key === 'string' && key));
}

/** Which providers have a saved key; never the keys themselves. */
export function savedProviderKeyIds(home) {
  try { return new Set(home ? Object.keys(loadProviderKeys(home)) : []); } catch { return new Set(); }
}

export function savedProviderKey(home, id) {
  try { return home ? loadProviderKeys(home)[id] ?? null : null; } catch { return null; }
}

/** Saves one key: validated as the terminal does, written to a private temporary file, then renamed into place. */
export function saveProviderKey(home, id, key) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw new BridgeError('Choose a provider for this key.');
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value || value.length > MAX_KEY_BYTES || ![...value].every(char => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126)) {
    throw new BridgeError('An API key must be 1-8192 visible ASCII characters.');
  }
  ownedDirectory(home);
  const keys = { ...loadProviderKeys(home), [id]: value };
  const temporary = path.join(home, `.${FILE_NAME}.${crypto.randomBytes(6).toString('hex')}`);
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(keys, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  try { fs.renameSync(temporary, path.join(home, FILE_NAME)); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* Already gone. */ } throw error; }
}
