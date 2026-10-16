import { execFile } from 'node:child_process';
import { BridgeError } from './client.mjs';

const DIFF_LIMIT = 400_000;
const NOT_A_REPOSITORY = 'This chat\'s folder is not a Git repository.';
// Read-only Git, with the repository's own helpers switched off: its config may name programs to run.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks'];
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'];

function run(cwd, args, { limit = 4_000_000, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => execFile('git', [...SAFE, ...args], { cwd, timeout: 15000, maxBuffer: limit, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } }, (error, stdout, stderr) => {
    if (!error || okCodes.includes(error.code)) return resolve(stdout);
    if (error.code === 'ENOENT') return reject(new BridgeError('Git is not installed on this computer.', 501));
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(String(stdout ?? ''));
    reject(new BridgeError(/not a git repository/i.test(stderr) ? NOT_A_REPOSITORY : `Git could not read this folder: ${String(stderr).trim().split('\n')[0].slice(0, 200)}`, 409));
  }));
}
const folder = cwd => {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new BridgeError('This chat has no folder to read.', 409);
  return cwd;
};

/** The terminal's /review presets that need Git: local branches, the current one, and recent commits. */
export async function reviewChoices(cwd) {
  folder(cwd);
  const [branches, current, log] = await Promise.all([
    run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    run(cwd, ['branch', '--show-current']),
    run(cwd, ['log', '-n', '100', '--format=%H%x1f%s']).catch(error => { if (/does not have any commits/i.test(error.message)) return ''; throw error; }),
  ]);
  return {
    branches: branches.split('\n').filter(Boolean), current: current.trim() || null,
    commits: log.split('\n').filter(Boolean).map(line => { const [sha, ...subject] = line.split('\x1f'); return { sha, subject: subject.join('\x1f') }; }),
  };
}

/** The terminal's /diff: tracked changes against HEAD plus every untracked file, as plain text. */
export async function workingDiff(cwd) {
  folder(cwd);
  const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => 'HEAD', () => null);
  const tracked = await run(cwd, ['diff', ...SAFE_DIFF, ...(head ? [head] : [])], { limit: DIFF_LIMIT * 2 });
  const names = (await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  let diff = tracked;
  for (const name of names.slice(0, 200)) {
    if (diff.length > DIFF_LIMIT) break;
    diff += await run(cwd, ['diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', name], { limit: DIFF_LIMIT * 2, okCodes: [0, 1] });
  }
  const truncated = diff.length > DIFF_LIMIT || names.length > 200;
  return { diff: diff.slice(0, DIFF_LIMIT), truncated };
}
