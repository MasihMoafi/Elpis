// Headless `elpis exec` uses the same defaults as a bridged chat. The native
// engine's on-request fallback must not become an automatic agent's policy.
import { spawn } from 'node:child_process';
import { connectAppServer } from './app-server-connection.mjs';
import { defaultPermissionMode, defaultPermissionSettings, permissionSettingsAllowed } from './permission-policy.mjs';
import { PermissionChoices } from './permission-choices.mjs';
import path from 'node:path';

const bin = process.env.ELPIS_ENGINE_BIN;
if (!bin) throw new Error('ELPIS_ENGINE_BIN must name the native engine');
const args = process.argv.slice(2);
const stop = args.indexOf('--'), flags = stop < 0 ? args : args.slice(0, stop);
const overrides = flags.flatMap((arg, i) => arg === '-c' || arg === '--config' ? [flags[i + 1] ?? ''] : arg.startsWith('--config=') ? [arg.slice(9)] : []);
const conn = connectAppServer({ engineBin: bin, name: 'elpis-launcher' });
let defaults = [];
try {
  await conn.ready;
  const read = await conn.call('config/read', { includeLayers: true });
  const requirements = (await conn.call('configRequirements/read', {})).requirements ?? {};
  const resume = args.indexOf('resume'), id = resume >= 0 ? args.slice(resume + 1).find(value => /^[\da-f-]{36}$/i.test(value)) : null;
  const choice = id ? await new PermissionChoices(process.env.ELPIS_HOME || path.join(process.env.HOME, '.elpis-next')).read(id) : null;
  const automatic = !!(process.env.CODEX_THREAD_ID || process.env.ELPIS_PARENT_THREAD || choice?.automatic);
  const settings = choice && !choice.inherit && !choice.automatic ? choice : defaultPermissionSettings(read, automatic);
  const combined = flags.some(arg => /^(?:--full-auto|--yolo|--dangerously-bypass-approvals-and-sandbox)$/.test(arg));
  const approvalChosen = combined || flags.some(arg => /^(?:-a|--ask-for-approval)(?:=|$)/.test(arg)) || overrides.some(arg => /^approval_policy\s*=/.test(arg));
  const sandboxChosen = combined || flags.some(arg => /^(?:-s|--sandbox)(?:=|$)/.test(arg)) || overrides.some(arg => /^(?:default_permissions|sandbox_mode)\s*=/.test(arg));
  const nativeCustom = defaultPermissionMode(read) === 'custom' && (!choice || choice.inherit) && !automatic;
  if (!nativeCustom && settings && (!approvalChosen || !sandboxChosen)) {
    if (!permissionSettingsAllowed({ ...settings, ...(approvalChosen ? { approvalPolicy: undefined } : {}), ...(sandboxChosen ? { permissions: undefined } : {}) }, requirements)) throw new Error('This permission mode is restricted by managed settings. Choose an allowed default in Settings.');
    const sandbox = { ':workspace': 'workspace-write', ':read-only': 'read-only', ':danger-full-access': 'danger-full-access' }[settings.permissions];
    defaults = [...(!approvalChosen ? ['-c', `approval_policy=${JSON.stringify(settings.approvalPolicy)}`, '-c', `approvals_reviewer=${JSON.stringify(settings.approvalsReviewer ?? 'user')}`] : []),
      ...(!sandboxChosen && settings.permissions ? ['-c', `default_permissions=${JSON.stringify(settings.permissions)}`] : []), ...(!sandboxChosen && sandbox ? ['-c', `sandbox_mode=${JSON.stringify(sandbox)}`] : [])];
  }
} catch (error) { process.stderr.write(`${error.message ?? error}\n`); process.exitCode = 1; }
finally { conn.close(); }
if (process.exitCode) process.exit(process.exitCode);
const child = spawn(bin, [...defaults, ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
