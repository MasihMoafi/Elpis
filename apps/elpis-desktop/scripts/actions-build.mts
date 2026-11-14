#!/usr/bin/env node
// actions-build.mts: the desktop build GitHub made for this commit, so nothing is built on Masih's laptop (Masih: "Please
// don't do builds locally"). The "Elpis desktop" workflow (.github/workflows/elpis-desktop.yml) uploads `renderer` once
// every UI shard passed: out/ with .commit and the UI receipt, and the generated bridge/resources. install-desktop.mts
// installs from it; run directly, it puts that build in this checkout's out/ and bridge/resources (for browser tests and
// `elpis-verify start source`). Usage: node scripts/actions-build.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRendererReceipt } from './renderer-artifact-gate.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const artifactName = 'renderer';
export type Run = { databaseId: number; status: string; conclusion: string | null; headSha?: string; createdAt?: string };

/** GitHub goes direct: the VPN proxy is for other sites, and gh through it fails. */
export function directEnv(env: NodeJS.ProcessEnv = process.env) {
  const direct = { ...env };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete direct[name];
  return direct;
}

/** The run whose build to install: the newest successful one of exactly `commit`, else a plain reason why there is none. */
export function pickRun(runs: Run[], commit: string): Run {
  const short = commit.slice(0, 9);
  const own = runs.filter(run => !run.headSha || run.headSha === commit)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const passed = own.find(run => run.status === 'completed' && run.conclusion === 'success');
  if (passed) return passed;
  const running = own.find(run => run.status !== 'completed');
  if (running) throw new Error(`GitHub's "Elpis desktop" run ${running.databaseId} for ${short} is still running; wait for it to finish.`);
  const [last] = own;
  if (last) throw new Error(`GitHub's "Elpis desktop" run ${last.databaseId} for ${short} ended ${last.conclusion ?? 'without a result'}; fix it and push again.`);
  throw new Error(`GitHub has no "Elpis desktop" run for ${short}: push it to a build/* branch and wait for the run.`);
}

/** Downloads and checks the build of `commit` into a new temporary folder: `out` is the renderer, `resources` the
 * generated bridge/resources. The caller removes `folder`. */
export async function downloadBuild(commit: string, { cwd = root } = {}) {
  const gh = (args: string[]) => execFileSync('gh', args, { cwd, encoding: 'utf8', env: directEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const runs: Run[] = JSON.parse(gh(['run', 'list', '--workflow', 'elpis-desktop.yml', '--commit', commit,
    '--json', 'databaseId,status,conclusion,headSha,createdAt', '--limit', '20']) || '[]');
  const run = pickRun(runs, commit);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-actions-build-'));
  try {
    try { gh(['run', 'download', String(run.databaseId), '--name', artifactName, '--dir', folder]); }
    catch (error) {
      const said = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
      throw new Error(`Could not download "${artifactName}" from run ${run.databaseId} (its build is kept 5 days; re-run it on GitHub if it expired): ${said}`);
    }
    const out = path.join(folder, 'out'), resources = path.join(folder, 'bridge/resources');
    let built = '';
    try { built = fs.readFileSync(path.join(out, '.commit'), 'utf8').trim(); } catch { /* checked below */ }
    const of = built ? built.slice(0, 9) : 'an unrecorded commit';
    if (built !== commit) throw new Error(`GitHub's build in run ${run.databaseId} is of ${of}, not ${commit.slice(0, 9)}.`);
    if (!fs.existsSync(resources)) throw new Error(`GitHub's build in run ${run.databaseId} has no bridge/resources; push the commit again so the workflow uploads them.`);
    await verifyRendererReceipt({ root: cwd, out, commit });
    return { folder, out, resources, run: run.databaseId };
  } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
}

/** Copies the generated bridge files of a downloaded build into the checkout, which the package then ships. */
export function placeResources(resources: string, app = root) {
  fs.cpSync(resources, path.join(app, 'bridge/resources'), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const build = await downloadBuild(commit);
  try {
    const out = path.join(root, 'out');
    if (fs.existsSync(out)) execFileSync('gio', ['trash', out]);
    fs.cpSync(build.out, out, { recursive: true });
    placeResources(build.resources);
    console.log(`out/ and bridge/resources are now GitHub's build of ${commit.slice(0, 9)} (run ${build.run}).`);
  } finally { fs.rmSync(build.folder, { recursive: true, force: true }); }
} catch (error) {
  console.error(`actions-build: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
