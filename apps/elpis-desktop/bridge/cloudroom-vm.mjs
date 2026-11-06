// CloudRoom VM (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents. that's it. I have a sub there.").
// Elpis talks to CloudRoom's web API itself; the CloudRoom app and its daemons are never installed (27 Oct security review,
// cloudroom-feedback/reports/security-review-2026-10-27.md). The flow follows CloudRoom's own published client
// (cloudroom-gui b5efb8d9): apps/server/src/services/cloudroom/account.ts signIn, client.ts runOnVm, sandboxes.ts wake,
// apps/cli/src/commands/cloudroom.ts vm push/pull.
//
// Sign-in: the browser opens `${website}/desktop?callback&state&challenge`, CloudRoom sends it back to a one-use loopback
// page here with `state` and `code`, and `{ code, verifier }` is redeemed at `${website}/api/desktop/redeem` for the
// account and its connection: a VM's core URL and token, or a token for per-thread sandboxes, or both.
// The connection is kept as provider keys are (provider-keys.mjs): one owner-only file in the Elpis home, written to a
// private temporary file and renamed. Tokens are never returned, logged or put in an error message.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './validate.mts';

export const CLOUDROOM_WEBSITE = 'https://www.cloudroom.dev';
const FILE_NAME = 'cloudroom.json';
const MAX_FILE_BYTES = 32_768;
const SIGN_IN_MS = 30 * 60_000;
/** CloudRoom's CLI refuses one transfer over 16 MiB; every piece here stays well under it (project-copy.ts UPLOAD_PART). */
export const PIECE_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
/** CloudRoom's sandbox accounts: an Elpis thread ID in CloudRoom's own format (packages/domain raw-thread-id.ts). */
const ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
const PERSONAL_PROJECT = 'proj_personal';
/** Where the VM's CLIs usually live; vm/run starts a plain shell. */
const PATHS = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:$PATH"';
const SETTINGS = 'Settings → Models & accounts';

export class CloudroomError extends BridgeError {
  constructor(code, message, status) { super(message, status ?? { not_signed_in: 401, too_big: 413, vm_asleep: 503, cli_missing: 424, cli_signed_out: 424 }[code] ?? 502); this.code = code; }
}
const notSignedIn = () => new CloudroomError('not_signed_in', `Sign in to CloudRoom under ${SETTINGS} first.`);
const expired = () => new CloudroomError('not_signed_in', `CloudRoom no longer accepts this sign-in. Sign in again under ${SETTINGS}.`);
const asleep = seconds => new CloudroomError('vm_asleep', `The CloudRoom VM is asleep or still waking up${seconds ? ` (waited ${seconds} s)` : ''}. Try again in a minute.`);
const tooBig = (bytes, limit) => new CloudroomError('too_big', `This transfer is too big for CloudRoom${bytes ? `: ${mb(bytes)} packed` : ''}, over the ${mb(limit)} limit. Leave large files out (add them to .gitignore) and try again.`);
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A VM path, quoted for its shell. `~` is the VM agent's home (as `room-cli vm` does); other paths stay literal. */
export function vmPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\0\n]/.test(value)) throw new BridgeError('Give a VM path.');
  const [prefix, rest] = value === '~' ? ['"$HOME"', ''] : value.startsWith('~/') ? ['"$HOME"/', value.slice(2)] : ['', value];
  return rest ? `${prefix}${quote(rest)}` : prefix;
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function ownedHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new BridgeError('The Elpis home folder is unknown, so CloudRoom was not saved.', 503);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new BridgeError('The Elpis home folder must be a folder you own, not a link.', 403);
}

/** The handoff CloudRoom's website returns, checked as CloudRoom's own client checks it (account.ts handoffSchema). */
function handoff(value) {
  const bad = () => new CloudroomError('sign_in_failed', 'CloudRoom returned a sign-in Elpis cannot use. Try again.');
  if (!value || typeof value !== 'object') throw bad();
  const { account, connection, sandboxes } = value;
  if (!account || typeof account.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(account.id) || typeof account.email !== 'string' || !account.email.includes('@')) throw bad();
  let saved;
  if (connection) {
    if (typeof connection.url !== 'string' || typeof connection.token !== 'string' || connection.token.length < 32 || /[^\x21-\x7e]/.test(connection.token)) throw bad();
    if (connection.gateToken !== undefined && !/^[a-zA-Z0-9._~-]{1,4096}$/.test(connection.gateToken)) throw bad();
    saved = { url: coreUrl(connection.url), token: connection.token, ...(connection.gateToken ? { gateToken: connection.gateToken } : {}) };
  }
  if (sandboxes !== undefined && !/^[a-f0-9]{64}$/.test(sandboxes?.token ?? '')) throw bad();
  if (!saved && !sandboxes) throw bad();
  return { account: { id: account.id, email: account.email }, ...(saved ? { connection: saved } : {}), ...(sandboxes ? { sandboxToken: sandboxes.token } : {}) };
}

/** A core URL: HTTPS, or HTTP on this computer (tests), without credentials, query or fragment (client.ts). */
function coreUrl(value) {
  let url; try { url = new URL(value); } catch { throw new CloudroomError('sign_in_failed', 'CloudRoom returned an invalid VM address.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new CloudroomError('sign_in_failed', 'CloudRoom returned an invalid VM address.');
  return url.href.replace(/\/$/, '');
}

/** The CloudRoom website: its real address, or a loopback server (tests), as CloudRoom's own client allows. */
function websiteOrigin(value) {
  const url = new URL(value);
  if (url.origin !== CLOUDROOM_WEBSITE && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port)) throw new BridgeError('Use the CloudRoom website.');
  return url.origin;
}

/**
 * @param home the Elpis home, where `cloudroom.json` is kept.
 * @param website CloudRoom's website (tests: a loopback fake).
 * @param wakeWaitMs how long a run waits for a sleeping VM or sandbox; `retryMs` the first pause between tries.
 * @param pollMs how often a running agent on the VM is checked.
 */
export function createCloudroomVm({ home, website = CLOUDROOM_WEBSITE, fetch: fetcher = globalThis.fetch, wakeWaitMs = 180_000, retryMs = 2000,
  pollMs = 5000, pieceBytes = PIECE_BYTES, maxTransferBytes = MAX_TRANSFER_BYTES, tmpDir = os.tmpdir() } = {}) {
  const origin = websiteOrigin(website);
  const file = path.join(home, FILE_NAME);
  let pending = null, signInError = null, sandbox = null, saving = Promise.resolve();

  function load() {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new BridgeError('The saved CloudRoom sign-in must be a private file you own. Sign out and sign in again.', 403);
    if (stat.size > MAX_FILE_BYTES) throw new BridgeError('The saved CloudRoom sign-in is too large.', 413);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  function save(value) {
    const work = saving.catch(() => {}).then(() => {
      ownedHome(home);
      if (value === null) { fs.rmSync(file, { force: true }); return; }
      const temporary = path.join(home, `.${FILE_NAME}.${randomBytes(6).toString('hex')}`);
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    });
    saving = work; return work;
  }
  /** Every message that leaves this module passes here: no saved token can reach a log, the UI or an agent. */
  function redact(message) {
    let saved; try { saved = load(); } catch { saved = null; }
    let text = String(message ?? '');
    for (const secret of [saved?.connection?.token, saved?.connection?.gateToken, saved?.sandboxToken, sandbox?.token]) if (secret) text = text.split(secret).join('…');
    return text;
  }
  const fail = (code, message, status) => new CloudroomError(code, redact(message), status);

  // ---- Sign-in -------------------------------------------------------------------------------------------------------
  function cancelSignIn() {
    if (!pending) return;
    clearTimeout(pending.timer); pending.server.close(); pending.server.closeIdleConnections?.(); pending = null;
  }
  function page(ok, message) {
    const escaped = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Signed in' : 'Sign-in not completed'} · Elpis</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${ok ? 'CloudRoom is connected to Elpis' : 'Sign-in not completed'}</h1><p>${escaped}</p><p>You can close this tab.</p></body></html>`;
  }
  async function signIn() {
    cancelSignIn(); signInError = null;
    const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('hex');
    const challenge = createHash('sha256').update(verifier).digest('hex');
    let callback = '';
    const server = http.createServer(async (request, response) => {
      const reply = (status, message) => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        response.end(page(status === 200, message));
      };
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== '/cloudroom/return' || (request.url ?? '').length > 512 || request.headers.host !== new URL(callback).host) return reply(400, 'This is not a CloudRoom sign-in. Start again from Elpis.');
      const received = url.searchParams.get('state') ?? '', code = url.searchParams.get('code') ?? '';
      if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(state)) || !/^[a-f0-9]{64}$/.test(code) || pending?.server !== server || pending.claimed) return reply(400, 'This sign-in expired or did not come from this Elpis. Start again from Elpis.');
      pending.claimed = true;
      try {
        let answer;
        try {
          answer = await fetcher(`${origin}/api/desktop/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
        } catch { throw fail('sign_in_failed', 'Elpis could not reach CloudRoom to finish signing in. Try again.'); }
        if (!answer.ok) { await answer.body?.cancel().catch(() => {}); throw fail('sign_in_failed', answer.status === 401 ? 'This sign-in expired or was already used. Try again.' : `CloudRoom could not verify your account (HTTP ${answer.status}). Try again.`); }
        const raw = await answer.text();
        if (raw.length > 16_384) throw fail('sign_in_failed', 'CloudRoom returned a sign-in Elpis cannot use. Try again.');
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = null; }
        const saved = handoff(parsed), previous = load();
        sandbox = null;
        await save({ version: 1, website: origin, ...saved, thread: previous?.account?.id === saved.account.id && previous.thread ? previous.thread : `thr_${[...randomBytes(10)].map(byte => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`, signedInAt: Date.now() });
        reply(200, `Signed in as ${saved.account.email}. Elpis can now run workflow agents on your CloudRoom VM.`);
      } catch (error) {
        signInError = error instanceof CloudroomError ? error.message : 'Sign-in could not complete. Start again from Elpis.';
        reply(400, signInError);
      } finally { if (pending?.server === server) cancelSignIn(); }
    });
    server.requestTimeout = 20_000; server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    callback = `http://127.0.0.1:${server.address().port}/cloudroom/return`;
    const timer = setTimeout(() => { if (pending?.server === server) { cancelSignIn(); signInError = 'Sign-in expired. Try again.'; } }, SIGN_IN_MS);
    timer.unref();
    pending = { server, timer, claimed: false };
    return { url: `${origin}/desktop?${new URLSearchParams({ callback, state, challenge })}` };
  }
  async function signOut() {
    cancelSignIn(); signInError = null;
    const saved = (() => { try { return load(); } catch { return null; } })();
    sandbox = null;
    await save(null);
    // Best effort, as CloudRoom's own sign-out (sandboxes.ts revokeDesktopToken): the website forgets the token.
    if (saved?.sandboxToken && saved.account) void fetcher(`${saved.website ?? origin}/api/desktop/sign-out`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Basic ${Buffer.from(`${saved.account.id}:${saved.sandboxToken}`).toString('base64')}` } }).then(response => response.body?.cancel(), () => {});
    return { signedIn: false };
  }

  // ---- The VM's core -------------------------------------------------------------------------------------------------
  const saved = () => { const value = load(); if (!value?.account || (!value.connection && !value.sandboxToken)) throw notSignedIn(); return value; };
  const basic = value => `Basic ${Buffer.from(`${value.account.id}:${value.sandboxToken}`).toString('base64')}`;
  /** A sandbox account has no one VM: Elpis keeps one CloudRoom thread, and its sandbox is woken for work (sandboxes.ts). */
  async function wakeSandbox(value, wake) {
    let response;
    try {
      response = await fetcher(`${value.website ?? origin}/api/desktop/sandboxes`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', Authorization: basic(value) }, body: JSON.stringify({ action: wake ? 'wake' : 'register', thread: value.thread, project: PERSONAL_PROJECT }) });
    } catch { throw Object.assign(asleep(), { retry: true }); }
    const view = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) throw expired();
    if (!response.ok) throw Object.assign(fail('vm_asleep', typeof view.error === 'string' ? `CloudRoom could not start the sandbox: ${view.error}` : `CloudRoom could not start the sandbox (HTTP ${response.status}).`), { retry: response.status >= 500 || response.status === 409 });
    if (view.state === 'awake' && typeof view.origin === 'string' && typeof view.token === 'string') return { url: coreUrl(view.origin), token: view.token };
    if (view.state === 'failed') throw fail('vm_asleep', `The CloudRoom sandbox did not start${view.issue ? `: ${view.issue}` : ''}.`);
    throw Object.assign(asleep(), { retry: true, state: view.state });
  }
  async function connection(wake = true) {
    const value = saved();
    if (value.connection) return value.connection;
    if (!sandbox) sandbox = await wakeSandbox(value, wake);
    return sandbox;
  }
  /** One vm/run request (client.ts runOnVm): JSON with hex stdin, hex stdout and stderr. */
  async function runOnce(command, { cwd, stdin, signal } = {}) {
    const core = await connection(true);
    let response;
    try {
      response = await fetcher(`${core.url}/v1/vm/run`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${core.token}`, 'X-Cloudroom-Token': core.token, ...(core.gateToken ? { Cookie: `_port_auth=${core.gateToken}` } : {}), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, stdin: stdin === undefined ? '' : Buffer.from(stdin).toString('hex'), ...(cwd ? { cwd } : {}) }) });
    } catch (error) {
      if (signal?.aborted) throw error;
      sandbox = null; throw Object.assign(asleep(), { retry: true });
    }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); sandbox = null; if (saved().connection) throw expired(); throw Object.assign(asleep(), { retry: true }); }
    if (response.status === 413) { await response.body?.cancel().catch(() => {}); throw tooBig(stdin?.length, pieceBytes); }
    // A sleeping VM answers through CloudRoom's gateway while it starts.
    if ([502, 503, 504].includes(response.status)) { await response.body?.cancel().catch(() => {}); sandbox = null; throw Object.assign(asleep(), { retry: true }); }
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) throw fail('vm_error', typeof value?.error === 'string' ? `CloudRoom refused the command: ${value.error}` : `CloudRoom refused the command (HTTP ${response.status}).`);
    return { code: value.code ?? null, stdout: Buffer.from(String(value.stdout ?? ''), 'hex'), stderr: Buffer.from(String(value.stderr ?? ''), 'hex'), truncated: value.truncated === true };
  }
  /** Runs a shell command on the VM as its agent account. A sleeping VM is waited for, up to `wakeWaitMs`. */
  async function run(command, { cwd, stdin, signal, wait = wakeWaitMs } = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new BridgeError('Give a command to run on the VM.');
    const started = Date.now();
    for (let tries = 0; ; tries++) {
      try { return await runOnce(command, { cwd, stdin, signal }); }
      catch (error) {
        if (!error.retry || signal?.aborted) throw error;
        const left = started + wait - Date.now();
        if (left <= 0) throw asleep(Math.round((Date.now() - started) / 1000));
        await pause(Math.min(retryMs * 2 ** Math.min(tries, 4), 15_000, left));
      }
    }
  }
  /** Fails with the command's error output unless it succeeded. */
  async function must(command, options) {
    const result = await run(command, options);
    if (result.truncated) throw tooBig(0, pieceBytes);
    if (result.code !== 0) throw fail('vm_error', `The VM command failed: ${result.stderr.toString().trim().slice(-600) || `exit ${result.code}`}`);
    return result.stdout;
  }

  // ---- Copying files -------------------------------------------------------------------------------------------------
  const exec = (command, args, options = {}) => new Promise((resolve, reject) => execFile(command, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', ...options }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  /** Packs a local folder: in a Git checkout its tracked and unignored files (as a workflow worktree holds them), else everything but `.git`. */
  async function pack(localDir, archive) {
    const listed = await exec('git', ['-C', localDir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => null);
    const names = listed === null ? null : listed.toString().split('\0').filter(name => name && fs.existsSync(path.join(localDir, name)));
    await new Promise((resolve, reject) => {
      const args = names ? ['--no-xattrs', '-czf', archive, '--null', '-T', '-'] : ['--no-xattrs', '-czf', archive, '--exclude=./.git', '.'];
      const tar = spawn('tar', args, { cwd: localDir, stdio: ['pipe', 'ignore', 'pipe'] });
      let error = ''; tar.stderr.on('data', data => { error += data; });
      tar.on('error', reject).on('close', code => code === 0 ? resolve() : reject(new BridgeError(`Could not pack ${localDir}: ${error.trim().slice(-300)}`)));
      tar.stdin.end(names ? names.map(name => `${name}\0`).join('') : '');
    });
    return (await fsp.stat(archive)).size;
  }
  async function scratch() {
    await fsp.mkdir(tmpDir, { recursive: true });
    return fsp.mkdtemp(path.join(tmpDir, 'elpis-cloudroom-'));
  }
  /** Sends a local file to `remote` (relative to the VM home) in pieces; a resent piece replaces itself (project-copy.ts). */
  async function upload(local, remote, size, signal) {
    const handle = await fsp.open(local);
    try {
      if (!size) await must(`mkdir -p -- "$(dirname -- ${quote(remote)})" && : > ${quote(remote)}`, { signal });
      for (let offset = 0; offset < size; offset += pieceBytes) {
        const length = Math.min(pieceBytes, size - offset), { buffer } = await handle.read(Buffer.alloc(length), 0, length, offset);
        await must(`mkdir -p -- "$(dirname -- ${quote(remote)})" && truncate -s ${offset} ${quote(remote)} && cat >> ${quote(remote)}`, { stdin: buffer, signal });
      }
    } finally { await handle.close(); }
  }
  /** Fetches `remote` (`size` bytes) in pieces to a local file. */
  async function download(remote, size, local, signal) {
    const handle = await fsp.open(local, 'w', 0o600);
    try {
      for (let offset = 0; offset < size; offset += pieceBytes) {
        const length = Math.min(pieceBytes, size - offset);
        const bytes = await must(`tail -c +${offset + 1} -- ${quote(remote)} | head -c ${length}`, { signal });
        if (bytes.length !== length) throw fail('vm_error', 'A piece of the copy from the VM went missing. Try again.');
        await handle.write(bytes, 0, bytes.length, offset);
      }
    } finally { await handle.close(); }
  }
  async function unpack(archive, localDir) {
    await fsp.mkdir(localDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', archive, '-C', localDir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; tar.stderr.on('data', data => { error += data; });
      tar.on('error', reject).on('close', code => code === 0 ? resolve() : reject(new BridgeError(`Could not unpack the files from the VM: ${error.trim().slice(-300)}`)));
    });
  }
  const remoteTemp = () => `.cache/elpis/transfer-${randomUUID()}.tgz`;
  /** Copies a local folder's contents into `vmDir` on the VM. */
  async function push(localDir, vmDir, { signal } = {}) {
    saved();
    if (!path.isAbsolute(localDir ?? '') || !fs.statSync(localDir).isDirectory()) throw new BridgeError('Choose a folder on this computer to copy.');
    const target = vmPath(vmDir), folder = await scratch(), archive = path.join(folder, 'push.tgz'), remote = remoteTemp();
    try {
      const size = await pack(localDir, archive);
      if (size > maxTransferBytes) throw tooBig(size, maxTransferBytes);
      await upload(archive, remote, size, signal);
      await must(`mkdir -p -- ${target} && tar -xzf ${quote(remote)} -C ${target}; code=$?; rm -f -- ${quote(remote)}; exit $code`, { signal });
      return { bytes: size, pieces: Math.max(1, Math.ceil(size / pieceBytes)) };
    } finally {
      await fsp.rm(folder, { recursive: true, force: true });
      await run(`rm -f -- ${quote(remote)}`, { wait: 0 }).catch(() => {});
    }
  }
  /** Packs `command`'s archive on the VM, then fetches and unpacks it into `localDir`. */
  async function fetchArchive(packCommand, remote, localDir, signal) {
    const folder = await scratch(), archive = path.join(folder, 'pull.tgz');
    try {
      const size = Number((await must(`mkdir -p .cache/elpis && ${packCommand} && wc -c < ${quote(remote)}`, { signal })).toString().trim());
      if (!Number.isSafeInteger(size)) throw fail('vm_error', 'The VM did not report the copy size.');
      if (size > maxTransferBytes) throw tooBig(size, maxTransferBytes);
      await download(remote, size, archive, signal);
      await unpack(archive, localDir);
      return { bytes: size, pieces: Math.max(1, Math.ceil(size / pieceBytes)) };
    } finally {
      await fsp.rm(folder, { recursive: true, force: true });
      await run(`rm -f -- ${quote(remote)}`, { wait: 0 }).catch(() => {});
    }
  }
  /** Copies a VM file or folder into `localDir` (as `room-cli vm pull`, in pieces). */
  async function pull(vmFile, localDir, { signal } = {}) {
    saved();
    if (!path.isAbsolute(localDir ?? '')) throw new BridgeError('Choose a folder on this computer to copy into.');
    const source = vmPath(vmFile), remote = remoteTemp();
    return fetchArchive(`p=${source}; tar -czf ${quote(remote)} -C "$(dirname -- "$p")" -- "$(basename -- "$p")"`, remote, localDir, signal);
  }

  // ---- What the VM can run -------------------------------------------------------------------------------------------
  /** Which agent CLIs the VM has and whether each is signed in, as its shell sees them. */
  async function probe(options = {}) {
    const script = [PATHS,
      'for c in claude codex; do p=$(command -v "$c" 2>/dev/null) && echo "$c=$p"; done',
      '{ [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || [ -s "$HOME/.claude/.credentials.json" ] || { command -v claude >/dev/null 2>&1 && claude auth status >/dev/null 2>&1; }; } && echo claude_login=1',
      'command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1 && echo codex_login=1', 'true'].join('\n');
    const out = (await must(script, options)).toString();
    const has = name => new RegExp(`^${name}=`, 'm').test(out);
    return { claude: { installed: has('claude'), signedIn: has('claude_login') }, codex: { installed: has('codex'), signedIn: has('codex_login') } };
  }
  async function status({ check = false } = {}) {
    let value;
    try { value = load(); } catch (error) { return { signedIn: false, signingIn: Boolean(pending), error: error.message }; }
    const base = { signedIn: Boolean(value?.account && (value.connection || value.sandboxToken)), signingIn: Boolean(pending), error: signInError,
      ...(value?.account ? { email: value.account.email, kind: value.connection ? 'vm' : 'sandbox' } : {}) };
    if (!check || !base.signedIn) return base;
    try { return { ...base, vm: { state: 'awake', ...await probe({ wait: Math.min(wakeWaitMs, 20_000) }) } }; }
    catch (error) { return { ...base, vm: { state: error.code === 'vm_asleep' ? 'asleep' : error.code === 'not_signed_in' ? 'signed_out' : 'error', message: redact(error.message) } }; }
  }

  // ---- Running a workflow agent there --------------------------------------------------------------------------------
  /** The CLI an agent's provider needs: Claude Code for Claude models, Codex for ChatGPT models. */
  function agentCommand({ provider, model, effort }, meta) {
    if (!['claude', 'openai'].includes(provider)) throw new CloudroomError('cli_missing', `The CloudRoom VM runs Claude Code and Codex agents only. Give this agent a Claude or ChatGPT model, or run the workflow on this computer.`);
    const bare = String(model ?? '').replace(/^(claude|openai)\//, '');
    if (bare && !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(bare)) throw new BridgeError('Invalid model for the CloudRoom VM.');
    if (provider === 'claude') return { cli: 'claude', name: 'Claude Code', answer: `${meta}/out`,
      line: `claude -p --dangerously-skip-permissions --output-format text${bare ? ` --model ${quote(bare)}` : ''}` };
    if (provider === 'openai') return { cli: 'codex', name: 'Codex', answer: `${meta}/answer`,
      // `$M`: the run's folder, set by its script (the agent runs inside the copied worktree).
      line: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never -o "$M/answer"${bare ? ` -m ${quote(bare)}` : ''}${/^(minimal|low|medium|high|xhigh)$/.test(effort ?? '') ? ` -c model_reasoning_effort=${quote(effort)}` : ''} -` };
  }
  /**
   * One workflow agent on the VM: copy `localDir` there, run the provider's CLI on `prompt` in it, then bring its
   * changes (new, changed and deleted files) back into `localDir`. `onStatus(text)` hears each step.
   */
  async function runAgent({ localDir, key, provider, model, effort, prompt, signal, timeoutMs = 30 * 60_000, onStatus = () => {} }) {
    saved();
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(key ?? '')) throw new BridgeError('Invalid CloudRoom run name.');
    const work = `elpis-runs/${key}`, meta = `.cache/elpis/runs/${key}`;
    const agent = agentCommand({ provider, model, effort }, meta);
    const clis = await probe({ signal });
    if (!clis[agent.cli].installed) throw new CloudroomError('cli_missing', `${agent.name} is not installed on the CloudRoom VM. Install it there (\`${agent.cli === 'claude' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex'}\`) or run the workflow on this computer.`);
    if (!clis[agent.cli].signedIn) throw new CloudroomError('cli_signed_out', `${agent.name} on the CloudRoom VM is not signed in. Sign it in on your CloudRoom account (or run \`${agent.cli === 'claude' ? 'claude' : 'codex login'}\` on the VM), then try again.`);
    onStatus('Copying the worktree to the CloudRoom VM…');
    await must(`rm -rf -- ${quote(work)} ${quote(meta)} && mkdir -p -- ${quote(work)} ${quote(meta)}`, { signal });
    const sent = await push(localDir, work, { signal });
    // What was there before the agent ran: deletions are what is missing afterwards, changes what is newer than `start`.
    await must(`cd -- ${quote(work)} && find . -type f ! -path './.git/*' -print0 > "$HOME"/${quote(`${meta}/manifest`)} && touch -- "$HOME"/${quote(`${meta}/start`)}`, { signal });
    await must(`cat > ${quote(`${meta}/prompt`)}`, { stdin: Buffer.from(prompt), signal });
    const script = ['#!/bin/sh', PATHS, `M="$HOME"/${quote(meta)}`, 'echo $$ > "$M/pid"', `cd -- "$HOME"/${quote(work)} || { echo 1 > "$M/code"; exit 1; }`,
      `${agent.line} < "$M/prompt" > "$M/out" 2> "$M/err"`, 'echo $? > "$M/code.part" && mv "$M/code.part" "$M/code"'].join('\n');
    await must(`cat > ${quote(`${meta}/run.sh`)}`, { stdin: Buffer.from(script), signal });
    onStatus(`Running ${agent.name} on the CloudRoom VM (${mb(sent.bytes)} copied)…`);
    // Detached, so a long agent outlives one request; its exit code is polled.
    await must(`if command -v setsid >/dev/null 2>&1; then setsid -f sh ${quote(`${meta}/run.sh`)} >/dev/null 2>&1 </dev/null; else nohup sh ${quote(`${meta}/run.sh`)} >/dev/null 2>&1 </dev/null & fi`, { signal });
    const stop = () => run(`p=$(cat ${quote(`${meta}/pid`)} 2>/dev/null) && { kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p"; }; true`, { wait: 0 }).catch(() => {});
    const ends = Date.now() + timeoutMs;
    let code;
    try {
      for (;;) {
        if (signal?.aborted) throw new BridgeError('Workflow cancelled', 409);
        if (Date.now() > ends) throw new BridgeError(`${agent.name} on the CloudRoom VM ran past its time limit and was stopped.`, 408);
        const read = (await must(`cat ${quote(`${meta}/code`)} 2>/dev/null; true`, { signal })).toString().trim();
        if (/^\d+$/.test(read)) { code = Number(read); break; }
        await new Promise(resolve => { const timer = setTimeout(resolve, pollMs); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
    } catch (error) { await stop(); throw error; }
    const answer = (await must(`head -c 1048576 -- ${quote(agent.answer)} 2>/dev/null; true`, { signal })).toString();
    if (code !== 0) {
      const err = (await must(`tail -c 4000 -- ${quote(`${meta}/err`)} 2>/dev/null; tail -c 2000 -- ${quote(`${meta}/out`)} 2>/dev/null; true`, { signal })).toString().trim();
      if (code === 127) throw new CloudroomError('cli_missing', `${agent.name} is not installed on the CloudRoom VM.`);
      if (/please run \/login|not logged in|invalid api key|login required|unauthori[sz]ed/i.test(err)) throw new CloudroomError('cli_signed_out', `${agent.name} on the CloudRoom VM is not signed in. Sign it in on your CloudRoom account, then try again.`);
      throw fail('agent_failed', `${agent.name} on the CloudRoom VM failed (exit ${code}): ${err.slice(-1500) || 'no output'}`, 409);
    }
    onStatus('Copying the changes back from the CloudRoom VM…');
    const remote = `${meta}/changes.tgz`;
    const back = await fetchArchive(`cd -- "$HOME"/${quote(work)} && find . -type f ! -path './.git/*' -newer "$HOME"/${quote(`${meta}/start`)} -print0 > "$HOME"/${quote(`${meta}/changed`)}`
      + ` && xargs -0 -r sh -c 'for f; do [ -e "$f" ] || [ -L "$f" ] || printf "%s\\0" "$f"; done' sh < "$HOME"/${quote(`${meta}/manifest`)} > "$HOME"/${quote(`${meta}/deleted`)}`
      + ` && tar -czf "$HOME"/${quote(remote)} --null -T "$HOME"/${quote(`${meta}/changed`)} && cd "$HOME"`, remote, localDir, signal);
    const changed = (await must(`cat -- ${quote(`${meta}/changed`)}`, { signal })).toString().split('\0').filter(Boolean);
    const deleted = (await must(`cat -- ${quote(`${meta}/deleted`)}`, { signal })).toString().split('\0').filter(Boolean);
    const root = path.resolve(localDir);
    for (const name of deleted) {
      const relative = path.posix.normalize(name.replace(/^\.\//, ''));
      if (!relative || relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative) || relative.split('/')[0] === '.git') continue;
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`)) continue;
      await fsp.rm(target, { force: true });
    }
    await run(`rm -rf -- ${quote(work)} ${quote(meta)}`, { wait: 0 }).catch(() => {});
    return { answer, changed: changed.length, deleted: deleted.length, sent, received: back };
  }

  return { signIn, signOut, status, run, push, pull, probe, runAgent, redact, close: cancelSignIn,
    /** Whether a run may target the VM now: signed in, without waking it. */
    ready() { saved(); return true; } };
}
