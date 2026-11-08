import { CloudroomError, tooBig, vmPath, quote } from './cloudroom-contract.mts';
import type { Saved, RunOptions } from './cloudroom-contract.mts';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './validate.mts';
export function createVmTransfers({ saved, must, run, fail, tmpDir, pieceBytes, maxTransferBytes }: {
    saved(): Saved;
    must(command: string, options?: RunOptions): Promise<Buffer>;
    run(command: string, options?: RunOptions): Promise<unknown>;
    fail(code: string, message: unknown, status?: number): CloudroomError;
    tmpDir: string;
    pieceBytes: number;
    maxTransferBytes: number;
}) {
    const exec = (command: string, args: string[], options: object = {}) => new Promise<Buffer>((resolve, reject) => execFile(command, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', ...options }, (error, stdout) => error ? reject(error as Error) : resolve(stdout)));
    /** Packs a local folder: in a Git checkout its tracked and unignored files (as a workflow worktree holds them), else everything but `.git`. */
    async function pack(localDir: string, archive: string) {
        const listed = await exec('git', ['-C', localDir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).catch(() => null);
        const names = listed === null ? null : listed.toString().split('\0').filter(name => name && fs.existsSync(path.join(localDir, name)));
        await new Promise<void>((resolve, reject) => {
            const args = names ? ['--no-xattrs', '-czf', archive, '--null', '-T', '-'] : ['--no-xattrs', '-czf', archive, '--exclude=./.git', '.'];
            const tar = spawn('tar', args, { cwd: localDir, stdio: ['pipe', 'ignore', 'pipe'] });
            let error = '';
            tar.stderr.on('data', data => { error += data; });
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
    async function upload(local: string, remote: string, size: number, signal?: AbortSignal) {
        const handle = await fsp.open(local);
        try {
            if (!size)
                await must(`mkdir -p -- "$(dirname -- ${quote(remote)})" && : > ${quote(remote)}`, { signal });
            for (let offset = 0; offset < size; offset += pieceBytes) {
                const length = Math.min(pieceBytes, size - offset), { buffer } = await handle.read(Buffer.alloc(length), 0, length, offset);
                await must(`mkdir -p -- "$(dirname -- ${quote(remote)})" && truncate -s ${offset} ${quote(remote)} && cat >> ${quote(remote)}`, { stdin: buffer, signal });
            }
        }
        finally {
            await handle.close();
        }
    }
    /** Fetches `remote` (`size` bytes) in pieces to a local file. */
    async function download(remote: string, size: number, local: string, signal?: AbortSignal) {
        const handle = await fsp.open(local, 'w', 0o600);
        try {
            for (let offset = 0; offset < size; offset += pieceBytes) {
                const length = Math.min(pieceBytes, size - offset);
                const bytes = await must(`tail -c +${offset + 1} -- ${quote(remote)} | head -c ${length}`, { signal });
                if (bytes.length !== length)
                    throw fail('vm_error', 'A piece of the copy from the VM went missing. Try again.');
                await handle.write(bytes, 0, bytes.length, offset);
            }
        }
        finally {
            await handle.close();
        }
    }
    async function unpack(archive: string, localDir: string) {
        await fsp.mkdir(localDir, { recursive: true });
        await new Promise<void>((resolve, reject) => {
            const tar = spawn('tar', ['-xzf', archive, '-C', localDir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
            let error = '';
            tar.stderr.on('data', data => { error += data; });
            tar.on('error', reject).on('close', code => code === 0 ? resolve() : reject(new BridgeError(`Could not unpack the files from the VM: ${error.trim().slice(-300)}`)));
        });
    }
    async function cleanupTransfer(folder: string, remote: string) {
        await fsp.rm(folder, { recursive: true, force: true });
        await run(`rm -f -- ${quote(remote)}`, { wait: 0 }).catch(() => { });
    }
    const remoteTemp = () => `.cache/elpis/transfer-${randomUUID()}.tgz`;
    /** Copies a local folder's contents into `vmDir` on the VM. */
    async function push(localDir: string | undefined, vmDir: string, { signal }: {
        signal?: AbortSignal | undefined;
    } = {}) {
        saved();
        if (!path.isAbsolute(localDir ?? '') || !fs.statSync(localDir as string).isDirectory())
            throw new BridgeError('Choose a folder on this computer to copy.');
        const target = vmPath(vmDir), folder = await scratch(), archive = path.join(folder, 'push.tgz'), remote = remoteTemp();
        try {
            const size = await pack(localDir as string, archive);
            if (size > maxTransferBytes)
                throw tooBig(size, maxTransferBytes);
            await upload(archive, remote, size, signal);
            await must(`mkdir -p -- ${target} && tar -xzf ${quote(remote)} -C ${target}; code=$?; rm -f -- ${quote(remote)}; exit $code`, { signal });
            return { bytes: size, pieces: Math.max(1, Math.ceil(size / pieceBytes)) };
        }
        finally {
            await cleanupTransfer(folder, remote);
        }
    }
    /** Packs `command`'s archive on the VM, then fetches and unpacks it into `localDir`. */
    async function fetchArchive(packCommand: string, remote: string, localDir: string, signal?: AbortSignal) {
        const folder = await scratch(), archive = path.join(folder, 'pull.tgz');
        try {
            const size = Number((await must(`mkdir -p .cache/elpis && ${packCommand} && wc -c < ${quote(remote)}`, { signal })).toString().trim());
            if (!Number.isSafeInteger(size))
                throw fail('vm_error', 'The VM did not report the copy size.');
            if (size > maxTransferBytes)
                throw tooBig(size, maxTransferBytes);
            await download(remote, size, archive, signal);
            await unpack(archive, localDir);
            return { bytes: size, pieces: Math.max(1, Math.ceil(size / pieceBytes)) };
        }
        finally {
            await cleanupTransfer(folder, remote);
        }
    }
    /** Copies a VM file or folder into `localDir` (as `room-cli vm pull`, in pieces). */
    async function pull(vmFile: string, localDir: string, { signal }: {
        signal?: AbortSignal | undefined;
    } = {}) {
        saved();
        if (!path.isAbsolute(localDir ?? ''))
            throw new BridgeError('Choose a folder on this computer to copy into.');
        const source = vmPath(vmFile), remote = remoteTemp();
        return fetchArchive(`p=${source}; tar -czf ${quote(remote)} -C "$(dirname -- "$p")" -- "$(basename -- "$p")"`, remote, localDir as string, signal);
    }
    return { push, pull, remoteTemp, fetchArchive };
}
