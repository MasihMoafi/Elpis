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
export async function workflowCandidateChanged(review) {
  return await git(review.path, ['rev-parse', 'HEAD']) !== review.commit || Boolean(await git(review.path, ['status', '--porcelain']));
}

/** A saved review is sufficient to integrate after a bridge restart; no model is restarted. */
export async function checkWorkflowReview(review, signal) {
  const { source, base, branch, commit } = review;
  if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
  if (await git(source, ['rev-parse', branch]) !== commit) throw new BridgeError('Not merged: the reviewed candidate changed', 409);
  const head = await git(source, ['rev-parse', 'HEAD']);
  if (![base, commit].includes(head) || await git(source, ['status', '--porcelain'])) throw new BridgeError(`Not merged: the project changed during the run. Candidate worktrees are kept at ${review.path}.`, 409);
  return head === commit;
}
export async function mergeWorkflowReview(review, signal) {
  const merged = await checkWorkflowReview(review, signal);
  if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
  if (!merged) await git(review.source, ['merge', '--ff-only', '--no-edit', review.branch]);
  return { ...review, status: 'merged', mergedAt: Date.now() };
}

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
      if (!changed.length) return { commits: [], diff: '', stat: '' };
      const original = await git(made.root, ['log', '--format=%H %s', `${made.start}..HEAD`]);
      await git(made.root, ['add', '--', ...changed]);
      const tree = await git(made.root, ['write-tree']);
      const sha = await git(made.root, ['commit-tree', tree, '-p', made.start, '-m', `Workflows: ${task.title} (round ${round})`]);
      await git(made.root, ['branch', `elpis/${id}/candidate-${key}`, sha]);
      commits.set(key, sha); made.inherited.add(key);
      const diff = await git(made.root, ['diff', '--no-ext-diff', '--no-textconv', made.start, sha, '--']);
      return { candidateCommit: sha, commits: [{ sha, subject: `Workflows: ${task.title} (round ${round})` }, ...original.split('\n').filter(Boolean).map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))],
        diff: diff.slice(0, 64000), diffTruncated: diff.length > 64000, stat: await git(made.root, ['diff', '--stat', made.start, sha, '--']) };
    },
    async review(signal) {
      if (!commits.size) return { status: 'empty', source, base };
      const merged = await create('integration'); places.set('integration', merged);
      for (const sha of commits.values()) await git(merged.root, ['cherry-pick', '--no-gpg-sign', sha]);
      if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
      const diff = await git(merged.root, ['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--']);
      return { status: 'ready', source, base, branch: merged.branch, path: merged.root, commit: await git(merged.root, ['rev-parse', 'HEAD']),
        diff: diff.slice(0, 128000), diffTruncated: diff.length > 128000, stat: await git(merged.root, ['diff', '--stat', base, 'HEAD', '--']) };
    },
    paths() { return [...places].map(([key, { root, branch }]) => ({ path: root, branch, ...(key === 'integration' ? {} : { taskId: key.slice(0, key.lastIndexOf('-r')), round: Number(key.slice(key.lastIndexOf('-r') + 2)) }) })); },
  };
}
