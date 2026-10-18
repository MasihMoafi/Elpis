import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';

const exec = promisify(execFile);
const git = async (cwd, args) => {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Elpis Workflows', '-c', 'user.email=workflows@elpis.local', '--literal-pathspecs', ...args],
    { cwd, timeout: 30000, maxBuffer: 4_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
    return stdout.trimEnd();
  } catch (error) { throw new BridgeError(`Workflow Git operation failed: ${String(error.stderr || error.message).trim().slice(0, 1500)}`, 409); }
};
const files = text => text.split('\0').filter(Boolean);
const inScope = (name, scopes) => scopes.some(scope => scope === '.' || name === scope || name.startsWith(`${scope.replace(/\/$/, '')}/`));

/** Each task sees only committed prerequisites. All candidate commits combine in a separate worktree before a
 * guarded fast-forward touches the source checkout. Failed/conflicting candidates stay available for inspection. */
export async function workflowWorktrees(project, id) {
  const source = await git(project, ['rev-parse', '--show-toplevel']);
  const base = await git(source, ['rev-parse', 'HEAD']);
  const relative = path.relative(source, await fs.realpath(project));
  const home = path.join(path.dirname(source), `${path.basename(source)}-elpis`, 'workflows', id);
  const places = new Map(), commits = new Map();
  await fs.mkdir(home, { recursive: true });
  const create = async key => {
    const root = path.join(home, key), branch = `elpis/${id}/${key}`;
    await git(source, ['worktree', 'add', '-q', '--no-track', '-b', branch, root, base]);
    return { root, branch, cwd: path.join(root, relative), inherited: new Set() };
  };
  const clean = async () => {
    if (await git(source, ['rev-parse', 'HEAD']) !== base || await git(source, ['status', '--porcelain'])) throw new BridgeError(`Not merged: the project changed during the run. Candidate worktrees are kept at ${home}.`, 409);
  };
  return {
    async prepare(task, round) {
      const key = `${task.id}-r${round}`, made = await create(key);
      places.set(key, made);
      const needed = new Set();
      for (const [key, value] of places) {
        const at = Number(key.match(/-r(\d+)$/)?.[1]);
        if (at < round || (at === round && task.dependsOn.includes(key.slice(0, key.lastIndexOf('-r'))))) {
          value.inherited.forEach(key => needed.add(key));
          if (commits.has(key)) needed.add(key);
        }
      }
      for (const [key, sha] of commits) if (needed.has(key)) await git(made.root, ['cherry-pick', '--no-gpg-sign', sha]);
      made.inherited = needed; made.start = await git(made.root, ['rev-parse', 'HEAD']);
      return made.cwd;
    },
    async complete(task, round) {
      const key = `${task.id}-r${round}`, made = places.get(key);
      const changed = [...new Set([...files(await git(made.root, ['diff', '--name-only', '-z', made.start, '--'])),
        ...files(await git(made.root, ['diff', '--cached', '--name-only', '-z', made.start, '--'])),
        ...files(await git(made.root, ['ls-files', '--others', '--exclude-standard', '-z']))])];
      const scopes = task.writeScopes.map(scope => path.posix.join(relative.split(path.sep).join('/'), scope));
      if (changed.some(name => !inScope(name, scopes))) throw new BridgeError(`“${task.title}” changed files outside its write scopes: ${changed.filter(name => !inScope(name, scopes)).join(', ')}. Kept at ${made.root}`, 409);
      // An agent may create a commit itself. Rebuild the candidate's own patch from its prerequisite HEAD, without
      // resetting any checkout or discarding files. This also prevents unrelated agent commits reaching the source.
      if (!changed.length) return;
      await git(made.root, ['add', '--', ...changed]);
      const tree = await git(made.root, ['write-tree']);
      const sha = await git(made.root, ['commit-tree', tree, '-p', made.start, '-m', `Workflows: ${task.title} (round ${round})`]);
      commits.set(key, sha); made.inherited.add(key);
    },
    async integrate(signal) {
      if (!commits.size) return;
      const merged = await create('integration'); places.set('integration', merged);
      for (const sha of commits.values()) await git(merged.root, ['cherry-pick', '--no-gpg-sign', sha]);
      if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
      await clean();
      if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
      await git(source, ['merge', '--ff-only', '--no-edit', merged.branch]);
    },
    paths() { return [...places.values()].map(({ root, branch }) => ({ path: root, branch })); },
  };
}
