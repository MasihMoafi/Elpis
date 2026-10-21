import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BridgeError, object } from './client.mjs';
import { attachmentInput } from './attachments.mjs';
import { verifyImprovement } from './improve-check.mjs';
const exec = promisify(execFile);
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const git = async (cwd, ...args) => (await exec('git', [...SAFE, ...args], { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
export const IMPROVE_INSTRUCTIONS = `You are improving Elpis in your own isolated git worktree. Work only in this worktree.
Tests first: reproduce each requested behaviour with a focused test that fails before the change. Use real keys and mouse events for UI behaviour.
Make the smallest sound change, reuse the existing components and styles, then build and run the relevant tests. Report exact commands and results, and any unchecked behaviour.
Dependencies may be linked from the source checkout; never edit them or install packages. Do not package, install, push, merge or launch the real Elpis app. Do not change the user's real profile.
Delete with gio trash. Never use git add -A, git add ., reset --hard, clean or stash. Stage named files only, inspect git diff --cached --stat and commit your change. Keep unrelated files untouched.
The app independently checks your committed result. Finish with a short result and trade-offs; the user can Try it or mark it ready for the coordinator.`;

export async function createImprovements({ client, sourceRoot, stateDir = process.env.ELPIS_IMPROVE_HOME || path.join(os.homedir(), '.cache/elpis-improve'), sourceMap, verify = verifyImprovement } = {}) {
  const records = new Map(), checking = new Map();
  const sourceFile = path.join(stateDir, 'source.json');
  let chosenSource;
  async function source() {
    const saved = await fs.readFile(sourceFile, 'utf8').then(JSON.parse).catch(() => null);
    const candidate = chosenSource || sourceRoot || saved?.path || process.env.ELPIS_SOURCE_REPO || path.resolve(appRoot, '../..');
    const root = typeof candidate === 'string' && path.isAbsolute(candidate) ? await git(candidate, 'rev-parse', '--show-toplevel').catch(() => null) : null;
    return { path: root, configured: !!root };
  }
  async function setSource(body) {
    object(body, ['path']);
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) throw new BridgeError('Choose a local Elpis source folder');
    const root = await git(body.path, 'rev-parse', '--show-toplevel').catch(() => null);
    const identity = root && await fs.readFile(path.join(root, 'apps/elpis-desktop/package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!root || identity?.name !== 'elpis-desktop') throw new BridgeError('This folder is not an Elpis source checkout. Choose the folder containing apps/elpis-desktop.');
    await fs.writeFile(`${sourceFile}.tmp`, JSON.stringify({ path: root }), { mode: 0o600 });
    await fs.rename(`${sourceFile}.tmp`, sourceFile);
    chosenSource = root;
    return { path: root, configured: true };
  }

  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(stateDir)) {
    if (!name.endsWith('.json')) continue;
    const row = await fs.readFile(path.join(stateDir, name), 'utf8').then(JSON.parse).catch(() => null);
    if (row?.id === name.slice(0, -5) && row.cwd && row.branch) {
      if (row.status === 'checking') {
        row.status = 'needs-check'; row.checks = null; row.error = 'The previous check was interrupted. Run build and tests again.';
        await save(row);
      }
      records.set(row.id, row);
    }
  }
  async function map() {
    return sourceMap ?? JSON.parse(await fs.readFile(new URL('../out/elpis-source-map.json', import.meta.url), 'utf8').catch(() => fs.readFile(new URL('../public/elpis-source-map.json', import.meta.url), 'utf8')));
  }
  async function save(row) {
    const file = path.join(stateDir, `${row.id}.json`), temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(row), { mode: 0o600 }); await fs.rename(temp, file); return row;
  }
  async function linkDependencies(root, cwd) {
    // Older worktrees retain their original checkout in this link, even if the selected source moved.
    const bin = await fs.realpath(path.join(cwd, 'apps/elpis-desktop/node_modules/.bin')).catch(() => null);
    const original = bin && path.resolve(bin, '../../../..');
    const identity = original && await fs.readFile(path.join(original, 'apps/elpis-desktop/package.json'), 'utf8').then(JSON.parse).catch(() => null);
    const roots = [...new Set([identity?.name === 'elpis-desktop' ? original : null, root].filter(Boolean))];
    // Share existing packages, keeping generated outputs and caches in the candidate worktree.
    for (const project of ['apps/elpis-desktop', 'tools/elpis-claude']) {
      let deps;
      for (const candidate of roots) {
        const directory = path.join(candidate, project, 'node_modules');
        if (await fs.stat(directory).then(() => true, () => false)) { deps = directory; break; }
      }
      if (!deps) continue;
      const local = path.join(cwd, project, 'node_modules'), packages = await fs.realpath(deps);
      await fs.mkdir(local, { recursive: true });
      for (const name of await fs.readdir(deps)) {
        await fs.symlink(path.join(packages, name), path.join(local, name)).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
    }
  }
  const find = id => { const row = records.get(id); if (!row) throw new BridgeError('Unknown Elpis change', 404); return row; };
  async function review(row) {
    const [head, dirty, diff] = await Promise.all([git(row.cwd, 'rev-parse', 'HEAD'), git(row.cwd, 'status', '--porcelain', '--untracked-files=normal'), git(row.cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', row.base)]);
    return { ...row, head, dirty: !!dirty, diff: diff.slice(0, 350000), truncated: diff.length > 350000 };
  }
  async function start(body) {
    object(body, ['request', 'target']); object(body.target, ['id', 'label', 'image']);
    if (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 16000) throw new BridgeError('Describe the change in 1–16000 characters');
    const sources = await map(), selected = sources[body.target.id];
    if (!selected || !Object.hasOwn(sources, body.target.id)) throw new BridgeError('Choose a component from this build’s source map');
    if (typeof body.target.image !== 'string' || !body.target.image.startsWith('data:image/png;base64,')) throw new BridgeError('A region screenshot is required; use the desktop app');
    const attachments = [{ id: 'pointed-region', type: 'image', name: 'Elpis region.png', mimeType: 'image/png', dataUrl: body.target.image }];
    attachmentInput('Screenshot', attachments); // Validate the native image before creating anything.
    const { path: root } = await source();
    if (!root) throw new BridgeError('Choose your Elpis source folder in this dialog before starting a change.', 409);
    await client.models(); // Register the subscription model on this bridge connection before creating a chat.
    const label = typeof body.target.label === 'string' ? body.target.label.slice(0, 300) : '';
    const request = body.request.trim(), id = randomUUID();
    const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'change';
    const branch = `improve/${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${slug}-${id.slice(0, 8)}`;
    const base = await git(root, 'rev-parse', 'HEAD');
    const cwd = path.join(stateDir, 'worktrees', id); await fs.mkdir(path.dirname(cwd), { recursive: true });
    await git(root, 'worktree', 'add', '-b', branch, cwd, base);
    const row = { id, cwd, branch, base, request, target: selected, status: 'starting', thread: null, checks: null };
    records.set(id, row); await save(row);
    await linkDependencies(root, cwd);
    try {
      const { thread } = await client.createThread({ cwd, model: 'gpt-6-luna', name: `Improve Elpis · ${request.slice(0, 90)}`, instructions: IMPROVE_INSTRUCTIONS, permissions: 'full' });
      row.thread = thread; row.status = 'working'; await save(row);
      try { await client.send(thread.id, { text: `Improve Elpis: ${request}\n\nPointed component: ${selected.component}\nElpis source file: ${selected.file}\nVisible label: ${label}\nThe attached image shows the pointed region. Follow the isolated-worktree instructions and commit the result.`, attachments }); }
      catch (error) { row.status = 'send-error'; row.error = `First message was not confirmed: ${error.message}. Inspect this chat before resending.`; await save(row); }
      return row;
    } catch (error) { row.status = 'failed'; row.error = error.message; await save(row); throw new BridgeError(`Could not start the improvement chat. Worktree retained at ${cwd}: ${error.message}`, 409); }
  }
  async function check(id) {
    if (checking.has(id)) return checking.get(id);
    const row = find(id);
    const job = (async () => {
      const before = await review(row);
      if (before.dirty || before.head === row.base) throw new BridgeError('Commit the change and leave the worktree clean before running checks', 409);
      row.status = 'checking'; row.checks = null; delete row.error; await save(row);
      try {
        await linkDependencies((await source()).path, row.cwd);
        const result = await verify(path.join(row.cwd, 'apps/elpis-desktop'));
        const after = await review(row);
        row.checks = { ...result, head: before.head, passed: result.passed && before.head === after.head && !after.dirty, at: new Date().toISOString() };
        row.status = row.checks.passed ? 'review' : 'checks-failed';
      } catch (error) { row.status = 'checks-failed'; row.error = error.message; }
      await save(row); return review(row);
    })();
    checking.set(id, job);
    try { return await job; } finally { checking.delete(id); }
  }
  async function verified(id) {
    const row = await review(find(id));
    if (!row.checks?.passed) throw new BridgeError('Build and test checks must pass before trying or keeping this change', 409);
    if (row.dirty || row.checks.head !== row.head) throw new BridgeError('The worktree changed since its checks; commit it and run checks again', 409);
    return row;
  }
  async function keep(id) {
    const checked = await verified(id), row = find(id);
    const note = path.join(stateDir, `${id}.ready.md`);
    await fs.writeFile(note, `# Ready for coordinator review\n\nRequest: ${row.request}\nBranch: ${row.branch}\nCommit: ${checked.head}\nBase: ${row.base}\nWorktree: ${row.cwd}\nChecks: passed at ${row.checks.at}\n\n${row.checks.commands.map(command => `- ${command.command}: exit ${command.code}`).join('\n')}\n\nUser selected Keep. Coordinator: review and merge this branch through the normal integration flow. Nothing was installed or merged.\n`, { mode: 0o600 });
    row.status = 'ready'; row.note = note; await save(row); return review(row);
  }
  const completed = event => {
    if (event.type !== 'message' || event.data?.method !== 'turn/completed') return;
    const row = [...records.values()].find(row => row.thread?.id === event.data.params?.threadId);
    if (row) void check(row.id).catch(async error => { row.status = 'needs-check'; row.error = error.message; await save(row); });
  };
  client.on('event', completed);
  return { source, setSource, start, check, keep, verified, get: async id => review(find(id)), list: () => [...records.values()].map(({ id, thread, status }) => ({ id, threadId: thread?.id, status })), close: () => client.removeListener('event', completed) };
}
