import { FILE_NAME, MAX_FILE_BYTES, SIGN_IN_MS, ID_ALPHABET, CloudroomError, ownedHome, handoff } from './cloudroom-contract.mts';
import type { Connection, Saved } from './cloudroom-contract.mts';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './validate.mts';
export function createCloudroomAuth({ home, origin, fetcher, getSandbox, clearSandbox }: {
    home: string | undefined;
    origin: string;
    fetcher: typeof globalThis.fetch;
    getSandbox(): Connection | null;
    clearSandbox(): void;
}) {
    const file = path.join(home as string, FILE_NAME);
    let pending: {
        server: http.Server;
        timer: NodeJS.Timeout;
        claimed: boolean;
    } | null = null, signInError: string | null = null, saving = Promise.resolve();
    function load() {
        let stat;
        try {
            stat = fs.lstatSync(file);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
            throw new BridgeError('The saved CloudRoom sign-in must be a private file you own. Sign out and sign in again.', 403);
        if (stat.size > MAX_FILE_BYTES)
            throw new BridgeError('The saved CloudRoom sign-in is too large.', 413);
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
        }
        catch {
            return null;
        }
    }
    function save(value: Saved | null) {
        const work = saving.catch(() => { }).then(() => {
            ownedHome(home);
            if (value === null) {
                fs.rmSync(file, { force: true });
                return;
            }
            const temporary = path.join(home as string, `.${FILE_NAME}.${randomBytes(6).toString('hex')}`);
            const handle = fs.openSync(temporary, 'wx', 0o600);
            try {
                fs.writeSync(handle, JSON.stringify(value));
                fs.fsyncSync(handle);
            }
            finally {
                fs.closeSync(handle);
            }
            try {
                fs.renameSync(temporary, file);
            }
            catch (error) {
                fs.rmSync(temporary, { force: true });
                throw error;
            }
        });
        saving = work;
        return work;
    }
    /** Every message that leaves this module passes here: no saved token can reach a log, the UI or an agent. */
    function redact(message: unknown) {
        let saved;
        try {
            saved = load();
        }
        catch {
            saved = null;
        }
        let text = String((message as string) ?? '');
        for (const secret of [saved?.connection?.token, saved?.connection?.gateToken, saved?.sandboxToken, getSandbox()?.token])
            if (secret)
                text = text.split(secret).join('…');
        return text;
    }
    const fail = (code: string, message: unknown, status?: number) => new CloudroomError(code, redact(message), status);
    // ---- Sign-in -------------------------------------------------------------------------------------------------------
    function cancelSignIn() {
        if (!pending)
            return;
        clearTimeout(pending.timer);
        pending.server.close();
        pending.server.closeIdleConnections?.();
        pending = null;
    }
    function page(ok: boolean, message: string) {
        const escaped = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Signed in' : 'Sign-in not completed'} · Elpis</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${ok ? 'CloudRoom is connected to Elpis' : 'Sign-in not completed'}</h1><p>${escaped}</p><p>You can close this tab.</p></body></html>`;
    }
    async function signIn() {
        cancelSignIn();
        signInError = null;
        const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('hex');
        const challenge = createHash('sha256').update(verifier).digest('hex');
        let callback = '';
        const server = http.createServer((request, response) => {
            void (async () => {
                const reply = (status: number, message: string) => {
                    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
                    response.end(page(status === 200, message));
                };
                const url = new URL(request.url ?? '/', 'http://127.0.0.1');
                if (request.method !== 'GET' || url.pathname !== '/cloudroom/return' || (request.url ?? '').length > 512 || request.headers.host !== new URL(callback).host)
                    return reply(400, 'This is not a CloudRoom sign-in. Start again from Elpis.');
                const received = url.searchParams.get('state') ?? '', code = url.searchParams.get('code') ?? '';
                if (!/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(state)) || !/^[a-f0-9]{64}$/.test(code) || pending?.server !== server || pending.claimed)
                    return reply(400, 'This sign-in expired or did not come from this Elpis. Start again from Elpis.');
                pending.claimed = true;
                try {
                    let answer;
                    try {
                        answer = await fetcher(`${origin}/api/desktop/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }), redirect: 'error', signal: AbortSignal.timeout(15000) });
                    }
                    catch {
                        throw fail('sign_in_failed', 'Elpis could not reach CloudRoom to finish signing in. Try again.');
                    }
                    if (!answer.ok) {
                        await answer.body?.cancel().catch(() => { });
                        throw fail('sign_in_failed', answer.status === 401 ? 'This sign-in expired or was already used. Try again.' : `CloudRoom could not verify your account (HTTP ${answer.status}). Try again.`);
                    }
                    const raw = await answer.text();
                    if (raw.length > 16384)
                        throw fail('sign_in_failed', 'CloudRoom returned a sign-in Elpis cannot use. Try again.');
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    }
                    catch {
                        parsed = null;
                    }
                    const saved = handoff(parsed), previous = load();
                    clearSandbox();
                    await save({ version: 1, website: origin, ...saved, thread: previous?.account?.id === saved.account.id && previous.thread ? previous.thread : `thr_${[...randomBytes(10)].map(byte => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`, signedInAt: Date.now() });
                    reply(200, `Signed in as ${saved.account.email}. Elpis can now run workflow agents on your CloudRoom VM.`);
                }
                catch (error) {
                    signInError = error instanceof CloudroomError ? error.message : 'Sign-in could not complete. Start again from Elpis.';
                    reply(400, signInError);
                }
                finally {
                    if (pending?.server === server)
                        cancelSignIn();
                }
            })();
        });
        server.requestTimeout = 20000;
        server.headersTimeout = 10000;
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        callback = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/cloudroom/return`;
        const timer = setTimeout(() => { if (pending?.server === server) {
            cancelSignIn();
            signInError = 'Sign-in expired. Try again.';
        } }, SIGN_IN_MS);
        timer.unref();
        pending = { server, timer, claimed: false };
        return { url: `${origin}/desktop?${new URLSearchParams({ callback, state, challenge })}` };
    }
    async function signOut() {
        cancelSignIn();
        signInError = null;
        const saved = (() => { try {
            return load();
        }
        catch {
            return null;
        } })();
        clearSandbox();
        await save(null);
        // Best effort, as CloudRoom's own sign-out (sandboxes.ts revokeDesktopToken): the website forgets the token.
        if (saved?.sandboxToken && saved.account)
            void fetcher(`${saved.website ?? origin}/api/desktop/sign-out`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
                headers: { Authorization: `Basic ${Buffer.from(`${saved.account.id}:${saved.sandboxToken}`).toString('base64')}` } }).then(response => response.body?.cancel(), () => { });
        return { signedIn: false };
    }
    // ---- The VM's core -------------------------------------------------------------------------------------------------
    return { load, redact, fail, signIn, signOut, cancelSignIn, get signingIn() { return Boolean(pending); }, get error() { return signInError; } };
}
