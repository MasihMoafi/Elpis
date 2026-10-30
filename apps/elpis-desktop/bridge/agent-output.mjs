import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './validate.mjs';

// What one agent of a board run left for the person to verify (components/agents-canvas.tsx, the agent's panel), read
// from its run's working folder: the first sentence of `## Result` in `agents/<name>/report.md`, a preview of each file
// its report lists under `## Files` inside the folders it may write, and its check's `## Verdict` lines from
// `agents/<name>/check/report.md` (the report form is lib/canvas.ts `report`). Read only: every path is checked to lie
// inside the working folder after links are followed, reports are read up to REPORT_BYTES and files only as previews.
const REPORT_BYTES = 256 * 1024, PREVIEW_BYTES = 16 * 1024, PREVIEW_LINES = 6, LINE_CHARS = 400, MOST_FILES = 20, TEXT_CHARS = 600;

/** The body of a report's `## <name>` section (its heading may go on, as in "## Verdict (passed or failed…)"). */
export function section(markdown, name) {
  const lines = markdown.split(/\r?\n/), heading = new RegExp(`^##\\s+${name}\\b`, 'i');
  const start = lines.findIndex(line => heading.test(line.trim()));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** The first sentence of markdown text: a full stop inside a code span or a “quotation”, after a one-letter word
 * ("e.g.", "B.C.") or not followed by a space ends nothing. */
export function firstSentence(markdown) {
  let code = false, quote = 0;
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown[i];
    if (char === '`') { code = !code; continue; }
    if (code) continue;
    if (char === '“') quote++;
    else if (char === '”') quote = Math.max(0, quote - 1);
    else if (/[.!?]/.test(char) && !quote) {
      let end = i + 1;
      while (end < markdown.length && /[.!?"”’)\]*_]/.test(markdown[end])) end++;
      if (end < markdown.length && !/\s/.test(markdown[end])) continue;
      if (char === '.' && /(?:^|[\s(])(?:\p{L}\.)*\p{L}$/u.test(markdown.slice(0, i))) continue;
      return markdown.slice(0, end).trim();
    }
  }
  return markdown.trim();
}

/** Markdown inline text in plain words: a code span naming a path shows its file name; emphasis and link marks go. */
export function plain(markdown) {
  return markdown.replace(/`([^`]+)`/g, (_, code) => /^\S*\/[^\s/]+$/.test(code) ? code.slice(code.lastIndexOf('/') + 1) : code)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=$|[\s.,;:)])/g, '$1$2').replace(/\s+/g, ' ').trim().slice(0, TEXT_CHARS);
}

/** A section's list items (`-`, `*` or `1.`), each with its wrapped lines; plain paragraphs when it has no list. */
function items(body) {
  const found = [];
  for (const line of body.split('\n')) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) found.push(item[1]);
    else if (line.trim() && found.length && /^\s/.test(line)) found[found.length - 1] += ` ${line.trim()}`;
    else if (line.trim() && !found.length) found.push(line.trim());
    else if (!line.trim() && found.length && !/^\s*(?:[-*+]|\d+[.)])\s/.test(body.split('\n').find(row => row.trim()) ?? '')) break;
  }
  return found;
}

/** What one agent did: the first sentence of its result, past a bare "Yes." or "Done.". */
export function whatItDid(report) {
  let text = items(section(report, 'Result'))[0] ?? '';
  for (let tries = 0; tries < 3 && text; tries++) {
    const sentence = firstSentence(text);
    if (sentence.split(/\s+/).length > 1 || sentence === text) return plain(sentence) || null;
    text = text.slice(sentence.length).trim();
  }
  return text ? plain(firstSentence(text)) || null : null;
}

const PASSED = /^(?:passed|pass|met|holds|yes|ok)$/i, FAILED = /^(?:failed|fail|not met|unmet|does not hold|not passed|no)$/i;
const WORD = String.raw`(passed|pass|met|holds|yes|ok|failed|fail|not met|unmet|does not hold|not passed|no)`;
const stateOf = word => PASSED.test(word.trim()) ? 'passed' : FAILED.test(word.trim()) ? 'failed' : 'unclear';
/** One verdict line in the forms checkers write: "**Passed** — “criterion.” evidence", "**Passed — Criterion.** evidence",
 * "**Passed:** criterion. evidence" and "criterion: passed". `detail` is the first sentence of the evidence. */
export function verdictLine(item) {
  const say = (state, criterion, detail = '') => ({ state, criterion: plain(criterion), detail: detail.trim() ? plain(firstSentence(detail.trim())) : '' });
  let match = item.match(new RegExp(String.raw`^\*\*\s*${WORD}\s*[—–:-]\s*(.+?)\*\*\s*(.*)$`, 'i'));
  if (match) return say(stateOf(match[1]), match[2], match[3]);
  match = item.match(new RegExp(String.raw`^\*\*\s*${WORD}\s*[:.]?\s*\*\*\s*[—–:.-]?\s*(.*)$`, 'i'));
  if (match) {
    const rest = match[2], quoted = rest.match(/^[“"](.+?)[”"]\s*(.*)$/);
    if (quoted) return say(stateOf(match[1]), quoted[1], quoted[2]);
    const criterion = firstSentence(rest);
    return say(stateOf(match[1]), criterion, rest.slice(criterion.length));
  }
  match = item.match(new RegExp(String.raw`^(.+?)\s*(?:\*\*)?\s*[:—–-]\s*(?:\*\*)?\s*${WORD}\s*(?:\*\*)?[.!]?$`, 'i'));
  if (match) return say(stateOf(match[2]), match[1].replace(/\*\*$/, ''));
  return say('unclear', item);
}
export const verdicts = report => items(section(report, 'Verdict')).map(verdictLine);

/** The paths a report lists under `## Files`: its code spans and link targets. */
export function listedFiles(report) {
  const body = section(report, 'Files'), found = [];
  for (const match of body.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)) found.push((match[1] ?? match[2]).trim());
  return [...new Set(found)];
}

const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
/** A real directory of the run, or null. */
async function directory(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const real = await fs.realpath(candidate).catch(() => null), info = real && await fs.stat(real).catch(() => null);
  return info?.isDirectory() ? real : null;
}
/** `rel` (relative to the folder, or absolute inside it) as a project-relative path, or null when it leaves the folder. */
function relative(folder, target) {
  if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0')) return null;
  const abs = path.resolve(folder, target);
  return within(abs, folder) && abs !== folder ? path.relative(folder, abs).split(path.sep).join('/') : null;
}
/** The real file at `rel`, if it exists and stays inside the folder after its links are followed. */
async function fileIn(folder, rel) {
  const real = await fs.realpath(path.join(folder, rel)).catch(() => null);
  if (!real || !within(real, folder)) return null;
  const info = await fs.stat(real).catch(() => null);
  return info?.isFile() ? { real, size: info.size } : null;
}
/** At most `limit` bytes of a file. */
async function head(real, limit) {
  const handle = await fs.open(real, 'r');
  try { const buffer = Buffer.alloc(limit), { bytesRead } = await handle.read(buffer, 0, limit, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
async function readReport(folder, rel) {
  const file = await fileIn(folder, rel);
  return file ? (await head(file.real, REPORT_BYTES)).toString('utf8') : null;
}
/** The first non-empty lines of a text file, or null for a binary one. */
async function preview(real) {
  const bytes = await head(real, PREVIEW_BYTES);
  if (bytes.includes(0)) return null;
  // A cut may split the last character; drop it rather than show a replacement mark.
  const text = bytes.toString('utf8').replace(/�$/, '');
  return text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim()).slice(0, PREVIEW_LINES).map(line => line.slice(0, LINE_CHARS));
}

/** The agent's own folder, `agents/<name>`: its check writes `<own>/check` (lib/canvas.ts `runParts`), and an agent with
 * no check has it as its last write scope. */
function ownFolder(record, task) {
  const check = record.tasks.find(item => item.kind === 'verify' && item.id === `${task.id}-check`);
  const own = check?.writeScopes?.[0]?.replace(/\/check$/, '') ?? task.writeScopes?.at(-1);
  return typeof own === 'string' && /^agents\/[^/\\]+$/.test(own) && own !== 'agents/..' && own !== 'agents/.' ? { own, check } : { own: null, check };
}

/** The agent's report, outputs and check verdicts. `record` is a board run (bridge/workflow-acp.mjs). */
export async function agentOutput(record, taskId) {
  const task = record?.tasks?.find(item => item.id === taskId);
  if (!task || task.kind === 'verify') throw new BridgeError('That agent is not part of this workflow.', 404);
  const { own, check } = ownFolder(record, task);
  // An isolated task works in its own worktree, which is freed once the run merged; the project then holds its work.
  const folder = await directory(task.cwd) ?? await directory(record.projectCwd);
  const checkFolder = await directory(check?.cwd) ?? folder;
  if (!folder || !own) return { folder: folder ?? null, report: null, did: null, outputs: [], check: null };
  const reportPath = `${own}/report.md`, report = await readReport(folder, reportPath);
  const scopes = (task.writeScopes ?? []).flatMap(scope => scope === '.' ? ['.'] : relative(folder, scope) ?? []);
  const allowed = rel => scopes.some(scope => scope === '.' || rel === scope || rel.startsWith(`${scope}/`));
  const outputs = [];
  for (const listed of report ? listedFiles(report) : []) {
    const rel = relative(folder, listed);
    if (!rel || rel === reportPath || rel.startsWith(`${own}/check/`) || !allowed(rel) || outputs.some(item => item.path === rel)) continue;
    const file = await fileIn(folder, rel);
    if (!file) continue;
    outputs.push({ path: rel, size: file.size, lines: await preview(file.real) });
    if (outputs.length === MOST_FILES) break;
  }
  const checkPath = `${own}/check/report.md`, checked = check ? await readReport(checkFolder, checkPath) : null;
  return {
    folder, report: report === null ? null : reportPath, did: report ? whatItDid(report) : null, outputs,
    check: check ? { report: checked === null ? null : checkPath, verdicts: checked ? verdicts(checked) : [] } : null,
  };
}
