import { receiptName } from './renderer-evidence-validation.mts';
import type { Inventory, PlanFile, Plan } from './renderer-evidence-types.mts';
import { baselineCommit, retainedUpdates, retiredPaths } from './renderer-evidence-pins.mts';
import type { Pin } from './renderer-evidence-pins.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInventory, discoverTests } from './test-gate.mts';
// The saved-workspace regression; its .cjs name survives in older baselines (moved to TypeScript on 7 Nov).
export const stateTests = ['desktop/state.test.cts', 'desktop/state.test.cjs'];
export const isStateTest = (name: string) => stateTests.includes(name);
export const appPrefix = 'apps/elpis-desktop/';
export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
export const gitBuffer = (root: string, args: string[], options: {
    stdio?: [
        'pipe',
        'pipe',
        'pipe'
    ];
    maxBuffer?: number;
} = {}) => execFileSync('git', args, { cwd: root, encoding: 'buffer', ...options });
export const blob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export const trackedFiles = (root: string, commit: string, paths: string[]) => new Map<string, string>(git(root, ['ls-tree', '-r', '--full-tree', commit, '--', ...paths]).trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/);
    assert(match?.[1] && match[2], `Unexpected tracked source entry: ${line}`);
    return [match[2].slice(appPrefix.length), match[1]];
}));
// Resolve a retired test against the checkpoint, where it may still have its old JS/TS extension.
export function retiredAtBaseline(baseline: string, files: ReadonlyMap<string, string>) {
    const testStem = (name: string) => name.replace(/\.[cm]?[jt]sx?$/, '');
    const checkpointPaths = [...files.keys()].filter(file => typeof file === 'string');
    return (retiredPaths[baseline] ?? []).map(name => {
        const stem = testStem(name);
        const matches = checkpointPaths.filter(file => file === name || (file !== stem && testStem(file) === stem));
        const [match] = matches;
        assert(matches.length === 1 && match, `Expected one retired checkpoint path for ${name}`);
        return match;
    });
}
export function assertSourceCommit(root: string, commit: string) {
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), commit, 'Source HEAD changed during installation');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during installation');
}
/** A clean working tree alone cannot detect a source mutation copied into a package and then reverted. */
export async function verifyPackagedSources({ root = appRoot, destination, commit }: {
    root?: string;
    destination: string;
    commit: string;
}) {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert(manifest.schemaVersion === 1 && Array.isArray(manifest.files), 'Invalid desktop package manifest');
    const sourceIdentity = JSON.parse(git(root, ['show', `${commit}:${appPrefix}package.json`]));
    const identity = JSON.parse(await fs.readFile(path.join(destination, 'app/package.json'), 'utf8'));
    const expectedIdentity = { name: sourceIdentity.name, productName: sourceIdentity.productName || 'Elpis',
        desktopName: sourceIdentity.desktopName, version: sourceIdentity.version, main: 'desktop/main.cts', private: true, type: 'module' };
    for (const [key, value] of Object.entries(expectedIdentity)) {
        assert.deepEqual(identity[key], value, `Packaged desktop identity differs from source commit: ${key}`);
    }
    const tracked = trackedFiles(root, commit, [appPrefix]), checked = new Set();
    for (const file of manifest.files) {
        assert(typeof file.path === 'string' && !path.isAbsolute(file.path) && !file.path.split('/').includes('..'), 'Invalid packaged path');
        const source = file.path.startsWith('app/') ? file.path.slice(4) : null;
        // Identity is checked above; package.json dependencies are generated from the bundled packages.
        if (!source || source === 'package.json' || !tracked.has(source))
            continue;
        assert(!checked.has(source), `Duplicate packaged source: ${source}`);
        const packaged = path.join(destination, file.path);
        assert((await fs.lstat(packaged)).isFile(), `Packaged source must be a regular file: ${source}`);
        assert.equal(blob(await fs.readFile(packaged)), tracked.get(source), `Packaged production bytes differ from source commit: ${source}`);
        checked.add(source);
    }
    assert(checked.has('desktop/main.cts'), 'Desktop package manifest omits its tracked entry point');
    assert(checked.has('desktop/state.cts'), 'Desktop package manifest omits tracked desktop/state.cts');
}
export async function treeFiles(root: string, relative = ''): Promise<string[]> {
    const files: string[] = [];
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory())
            files.push(...await treeFiles(root, name));
        else {
            assert(entry.isFile(), `Unexpected renderer/test symlink: ${name}`);
            files.push(name);
        }
    }
    return files;
}
export async function rendererHash(out: string) {
    const hash = createHash('sha256');
    for (const name of await treeFiles(out)) {
        if (name === receiptName)
            continue;
        const bytes = await fs.readFile(path.join(out, name));
        hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    }
    return hash.digest('hex');
}
/** Resolve an immutable replacement, including a not-yet-staged repair with exactly the pinned bytes. */
export async function retainedUpdate(root: string, name: string, pin: Pin) {
    assert(/^tests\/[^\0]+$/.test(name) && !name.split('/').includes('..'), `Invalid retained path: ${name}`);
    assert(/^[a-f0-9]{40}$/.test(pin.blob) && /^[a-f0-9]{40}$/.test(pin.approval) && pin.reason, `Invalid retained pin: ${name}`);
    let bytes;
    try {
        bytes = gitBuffer(root, ['cat-file', 'blob', pin.blob], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    catch {
        bytes = await fs.readFile(path.join(root, name));
    }
    assert.equal(blob(bytes), pin.blob, `Changed pinned retained regression: ${name}`);
    return bytes;
}
/** The immutable baseline owns retained tests; candidate source owns implementations. */
export async function planSuite(root = appRoot, baseline = baselineCommit, updates: Record<string, Pin> = retainedUpdates[baseline] ?? {}): Promise<Plan> {
    const retained: Inventory = JSON.parse(git(root, ['show', `${baseline}:${appPrefix}test-inventory.json`]));
    const inventory: Inventory = JSON.parse(await fs.readFile(path.join(root, 'test-inventory.json'), 'utf8'));
    checkInventory(inventory, await discoverTests(root));
    const oldFiles = trackedFiles(root, baseline, [`${appPrefix}tests/`, ...stateTests.map(name => appPrefix + name)]);
    for (const [name, pin] of Object.entries(updates))
        oldFiles.set(name, blob(await retainedUpdate(root, name, pin)));
    for (const name of retiredAtBaseline(baseline, oldFiles))
        oldFiles.delete(name);
    const currentFiles = new Map(await Promise.all((await treeFiles(path.join(root, 'tests'))).map(async (name) => [`tests/${name}`, blob(await fs.readFile(path.join(root, 'tests', name)))] as [
        string,
        string
    ])));
    for (const name of stateTests) {
        try {
            currentFiles.set(name, blob(await fs.readFile(path.join(root, name))));
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
        }
    }
    const testNames = new Set([...Object.values(retained).flat(), ...Object.values(inventory).flat()]);
    const supportHash = (files: Map<string, string>) => digest(JSON.stringify([...files].filter(([name]) => !testNames.has(name)).sort()));
    const support = { baseline: supportHash(oldFiles), candidate: supportHash(currentFiles) };
    const item = (source: PlanFile['source'], name: string, files: Map<string, string>): PlanFile => {
        assert((name.startsWith('tests/') || isStateTest(name)) && !name.split('/').includes('..'), `Invalid regression path: ${name}`);
        assert(files.has(name), `Missing ${source} UI regression: ${name}`);
        const hash = files.get(name);
        assert(hash !== undefined, `Missing ${source} UI regression: ${name}`);
        return { source, name, blob: hash };
    };
    assert(retained.ui.length > 0 && inventory.ui.length > 0, 'The UI inventory must not be empty');
    assert(retained.desktop.some(isStateTest), 'The checkpoint must retain the saved-workspace regression');
    // 2 Nov, Masih: "radically delete and reduce the time builds take". Old copies of current tests ran a second
    // time and only re-checked expectations he had since changed; the current tests alone are the regression suite.
    const files = [...inventory.desktop.filter(isStateTest), ...inventory.ui].map(name => item('candidate', name, currentFiles));
    return { baseline, support, files };
}
