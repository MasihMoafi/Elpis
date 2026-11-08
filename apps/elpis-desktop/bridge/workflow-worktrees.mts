import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './validate.mts';

type Review = { path: string; source: string; base: string; branch: string; commit: string };
type Task = { id: string; title: string; dependsOn: string[]; writeScopes: string[]; status?: string; result?: { candidateCommit?: string } | null };
type SavedPlace = { path: string; branch: string; taskId?: string; round?: number; start?: string };
type Saved = { worktreeBase?: string; review?: Review; worktrees?: SavedPlace[]; tasks: Task[] };
type Workspace = { root: string; branch: string; cwd: string; start?: string; inherited: Set<string> };

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => {
  try {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Elpis Workflows', '-c', 'user.email=workflows@elpis.local', '--literal-pathspecs', ...args],
    { cwd, timeout: 30000, maxBuffer: 4_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
    return stdout.trimEnd();
  } catch (error) { throw new BridgeError(`Workflow Git operation failed: ${String((error as { stderr?: string; message: string }).stderr || (error as Error).message).trim().slice(0, 1500)}`, 409); }
};
const files = (text: string) => text.split('\0').filter(Boolean);
const inScope = (name: string, scopes: string[]) => scopes.some(scope => scope === '.' || name === scope || name.startsWith(`${scope.replace(/\/$/, '')}/`));
export async function workflowCandidateChanged(review: Review) {
  return await git(review.path, ['rev-parse', 'HEAD']) !== review.commit || Boolean(await git(review.path, ['status', '--porcelain']));
}

/** A saved review is sufficient to integrate after a bridge restart; no model is restarted. */
export async function checkWorkflowReview(review: Review, signal?: AbortSignal) {
  const { source, base, branch, commit } = review;
  if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
  if (await git(source, ['rev-parse', branch]) !== commit) throw new BridgeError('Not merged: the reviewed candidate changed', 409);
  const head = await git(source, ['rev-parse', 'HEAD']);
  if (![base, commit].includes(head) || await git(source, ['status', '--porcelain'])) throw new BridgeError(`Not merged: the project changed during the run. Candidate worktrees are kept at ${review.path}.`, 409);
  return head === commit;
}
export async function mergeWorkflowReview(review: Review, signal?: AbortSignal) {
  const merged = await checkWorkflowReview(review, signal);
  if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
  if (!merged) await git(review.source, ['merge', '--ff-only', '--no-edit', review.branch]);
  return { ...review, error: undefined, status: 'merged', mergedAt: Date.now() };
}

/** Frees a run's scratch the moment the run ends for good (Masih, 29 Oct: "so leftovers don't exist"): the worktrees
 * under `<repo>-elpis/workflows/<id>/` that the record lists or that sit on an `elpis/<id>/` branch, every
 * `elpis/<id>/` branch, then the run's folder and its parents once they are empty. Nothing else is touched. Throws,
 * after trying everything, when any part is left; calling again retries. */
export async function removeWorkflowWorkspace(record: { id: string; review?: Review; projectCwd?: string; worktrees?: SavedPlace[] }) {
  if (!/^[0-9a-f-]{36}$/i.test(record.id ?? '')) throw new BridgeError('Invalid workflow ID', 400);
  const project = record.review?.source ?? record.projectCwd;
  if (!project) return;
  const source = await git(project, ['rev-parse', '--show-toplevel']);
  const home = path.join(path.dirname(source), `${path.basename(source)}-elpis`, 'workflows', record.id), prefix = `refs/heads/elpis/${record.id}/`;
  const own = (place: unknown): place is string => typeof place === 'string' && path.isAbsolute(place) && path.dirname(path.resolve(place)) === home;
  const listed = new Set([...(record.worktrees ?? []).map(place => place?.path), record.review?.path].filter(own).map(place => path.resolve(place)));
  const registered: { path: string; branch?: string }[] = [];
  for (const line of (await git(source, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (line.startsWith('worktree ')) registered.push({ path: line.slice(9) });
    else if (line.startsWith('branch ') && registered.length) registered.at(-1)!.branch = line.slice(7);
  }
  const problems = [];
  for (const place of registered.filter(place => own(place.path) && (listed.has(place.path) || place.branch?.startsWith(prefix)))) {
    await git(source, ['worktree', 'remove', '--force', place.path]).catch(error => problems.push(error.message));
  }
  const branches = (await git(source, ['for-each-ref', '--format=%(refname)', prefix]).catch(error => { problems.push(error.message); return ''; }))
    .split('\n').filter(ref => ref.startsWith(prefix));
  for (const ref of branches) await git(source, ['branch', '-D', ref.slice('refs/heads/'.length)]).catch(error => problems.push(error.message));
  for (const [at, dir] of [home, path.dirname(home), path.dirname(path.dirname(home))].entries()) {
    const error = await fs.rmdir(dir).then(() => null, error => error);
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') { if (!at) problems.push(`${home} still holds files`); break; }
    if (error && error.code !== 'ENOENT') { problems.push(error.message); break; }
  }
  if (problems.length) throw new BridgeError(`Some of this run’s worktrees were not removed: ${problems.join('; ').slice(0, 1500)}`, 409);
}

/** Each task sees only committed prerequisites. All candidate commits combine in a separate worktree before a
 * guarded fast-forward touches the source checkout. Failed/conflicting candidates stay available for inspection. */
export async function workflowWorktrees(project: string, id: string, saved?: Saved) {
  const source = await git(project, ['rev-parse', '--show-toplevel']);
  const base = saved?.worktreeBase ?? saved?.review?.base ?? await git(source, ['rev-parse', 'HEAD']);
  const relative = path.relative(source, await fs.realpath(project));
  const home = path.join(path.dirname(source), `${path.basename(source)}-elpis`, 'workflows', id);
  const places = new Map<string, Workspace>(), commits = new Map<string, string>();
  await fs.mkdir(home, { recursive: true });
  const create = async (key: string): Promise<Workspace> => {
    const root = path.join(home, key), branch = `elpis/${id}/${key}`;
    await git(source, ['worktree', 'add', '-q', '--no-track', '-b', branch, root, base]);
    return { root, branch, cwd: path.join(root, relative), inherited: new Set() };
  };
  if (saved?.worktrees) {
    for (const place of saved.worktrees) {
      if (!place.taskId || !Number.isSafeInteger(place.round)) continue;
      const task = saved.tasks.find(task => task.id === place.taskId), key = `${place.taskId}-r${place.round}`;
      if (!task || place.path !== path.join(home, key) || place.branch !== `elpis/${id}/${key}`) throw new BridgeError('Saved workflow workspace could not be verified. Existing work was preserved.', 409);
      const actual = await fs.realpath(place.path);
      if (actual !== place.path || await git(actual, ['branch', '--show-current']) !== place.branch) throw new BridgeError('A workflow workspace moved or changed branch. Existing work was preserved.', 409);
      const start = place.start ?? (task.result?.candidateCommit ? await git(actual, ['rev-parse', `${task.result.candidateCommit}^`]) : await git(actual, ['merge-base', base, 'HEAD']));
      const made: Workspace = { root: actual, branch: place.branch, cwd: path.join(actual, relative), start, inherited: new Set() };
      if (!place.start && !task.result?.candidateCommit && await git(actual, ['status', '--porcelain'])) throw new BridgeError('This older workflow has unfinished edits without a saved checkpoint. Its workspace is preserved; inspect it before recovery.', 409);
      places.set(key, made);
      if (task.status === 'succeeded' && task.result?.candidateCommit) { commits.set(key, task.result.candidateCommit); made.inherited.add(key); }
    }
    const inherit = (taskId: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(taskId)) return seen; seen.add(taskId);
      for (const dependency of saved.tasks.find(task => task.id === taskId)?.dependsOn ?? []) inherit(dependency, seen);
      return seen;
    };
    for (const [key, made] of places) {
      const dependencies = inherit(key.slice(0, key.lastIndexOf('-r')));
      for (const candidate of commits.keys()) if (dependencies.has(candidate.slice(0, candidate.lastIndexOf('-r')))) made.inherited.add(candidate);
    }
  }
  return { base,
    async prepare(task: Task, round: number) {
      const key = `${task.id}-r${round}`;
      if (places.has(key)) return places.get(key)!.cwd;
      const made = await create(key);
      places.set(key, made);
      const needed = new Set<string>();
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
    async complete(task: Task, round: number) {
      const key = `${task.id}-r${round}`, made = places.get(key)!;
      const listChanged = async () => [...new Set([...files(await git(made.root, ['diff', '--name-only', '-z', made.start!, '--'])),
        ...files(await git(made.root, ['diff', '--cached', '--name-only', '-z', made.start!, '--'])),
        ...files(await git(made.root, ['ls-files', '--others', '--exclude-standard', '-z']))])];
      let changed = await listChanged();
      const prefix = relative.split(path.sep).join('/');
      const scopes = task.writeScopes.map(scope => path.posix.join(prefix, scope));
      // 1 Nov live runs: Haiku saved answer-3.md at the project root instead of in answer-3/, even after a correction. A file
      // that is new and outside the agent's folders cannot touch anyone's work, so Elpis moves it into the agent's first folder;
      // a change to a file that already exists outside them still fails below.
      const relocated = [];
      const untracked = new Set(files(await git(made.root, ['ls-files', '--others', '--exclude-standard', '-z'])));
      const outside = changed.filter(name => !inScope(name, scopes));
      if (outside.length && scopes.length && !scopes.includes('.') && outside.every(name => untracked.has(name))) {
        for (const name of outside) {
          let target = path.posix.join(scopes[0]!, path.posix.basename(name));
          for (let n = 2; await fs.stat(path.join(made.root, target)).then(() => true, () => false); n++) target = path.posix.join(scopes[0]!, `${path.posix.basename(name, path.posix.extname(name))}-${n}${path.posix.extname(name)}`);
          await fs.mkdir(path.dirname(path.join(made.root, target)), { recursive: true });
          await fs.rename(path.join(made.root, name), path.join(made.root, target));
          const local = (file: string) => prefix ? path.posix.relative(prefix, file) : file;
          relocated.push({ from: local(name), to: local(target) });
        }
        changed = await listChanged();
      }
      if (changed.some(name => !inScope(name, scopes))) throw new BridgeError(`“${task.title}” changed files outside its write scopes: ${changed.filter(name => !inScope(name, scopes)).join(', ')}. Kept at ${made.root}`, 409);
      // An agent may create a commit itself. Rebuild the candidate's own patch from its prerequisite HEAD, without
      // resetting any checkout or discarding files. This also prevents unrelated agent commits reaching the source.
      if (!changed.length) return { commits: [], diff: '', stat: '', ...(relocated.length ? { relocated } : {}) };
      const original = await git(made.root, ['log', '--format=%H %s', `${made.start}..HEAD`]);
      await git(made.root, ['add', '--', ...changed]);
      const tree = await git(made.root, ['write-tree']);
      const sha = await git(made.root, ['commit-tree', tree, '-p', made.start!, '-m', `Workflows: ${task.title} (round ${round})`]);
      // A step completed again in the same round (check findings, a retry) replaces its candidate (1 Nov live run).
      await git(made.root, ['branch', '-f', `elpis/${id}/candidate-${key}`, sha]);
      commits.set(key, sha); made.inherited.add(key);
      const diff = await git(made.root, ['diff', '--no-ext-diff', '--no-textconv', made.start!, sha, '--']);
      return { candidateCommit: sha, commits: [{ sha, subject: `Workflows: ${task.title} (round ${round})` }, ...original.split('\n').filter(Boolean).map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))],
        diff: diff.slice(0, 64000), diffTruncated: diff.length > 64000, stat: await git(made.root, ['diff', '--stat', made.start!, sha, '--']), ...(relocated.length ? { relocated } : {}) };
    },
    async review(signal?: AbortSignal) {
      if (!commits.size) return { status: 'empty', source, base };
      const merged = await create('integration'); places.set('integration', merged);
      for (const sha of commits.values()) await git(merged.root, ['cherry-pick', '--no-gpg-sign', sha]);
      if (signal?.aborted) throw new BridgeError('Workflow cancelled before integration', 409);
      const diff = await git(merged.root, ['diff', '--no-ext-diff', '--no-textconv', base, 'HEAD', '--']);
      return { status: 'ready', source, base, branch: merged.branch, path: merged.root, commit: await git(merged.root, ['rev-parse', 'HEAD']),
        diff: diff.slice(0, 128000), diffTruncated: diff.length > 128000, stat: await git(merged.root, ['diff', '--stat', base, 'HEAD', '--']) };
    },
    paths() { return [...places].map(([key, { root, branch, start }]) => ({ path: root, branch, ...(start ? { start } : {}), ...(key === 'integration' ? {} : { taskId: key.slice(0, key.lastIndexOf('-r')), round: Number(key.slice(key.lastIndexOf('-r') + 2)) }) })); },
  };
}
