import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type GoalTask = { id: string; ownerSession: string | null; model: string | null; worktree: string | null; status: string };
export type GoalMessage = { taskId: string; text: string; state: 'sent' | 'accepted'; at: string };
export type GoalFields = { originalRequest: string; decisions: string[]; constraints: string[]; tasks: GoalTask[]; messages: GoalMessage[]; evidence: string[]; nextAction: string };
export type Goal = GoalFields & { id: string; revision: number; createdAt: string; updatedAt: string };
export type GoalPatch = Partial<GoalFields>;

/** Revision checks prevent a stale caller from silently erasing another caller's work. */
export function createGoalStore(elpisHome: string) {
  const directory = path.join(elpisHome, 'matilda', 'goals');
  const fileFor = (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid goal id.');
    return path.join(directory, `${id}.json`);
  };
  async function prepare() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }
  async function get(id: string): Promise<Goal | null> {
    try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')) as Goal; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async function write(goal: Goal) {
    const file = fileFor(goal.id), temp = `${file}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(goal)); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temp, file);
      const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
  }
  async function create(fields: GoalFields): Promise<Goal> {
    await prepare(); const now = new Date().toISOString();
    const goal: Goal = { ...fields, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now };
    await write(goal); return goal;
  }
  async function update(id: string, revision: number, patch: GoalPatch): Promise<Goal> {
    await prepare(); const lock = `${fileFor(id)}.lock`;
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Goal is being updated; retry after reading it.'); throw error; }
    try {
      const current = await get(id);
      if (!current) throw Error('Goal not found.');
      if (current.revision !== revision) throw Error('Goal changed; read it before updating.');
      const goal = { ...current, ...patch, id, revision: revision + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      await write(goal); return goal;
    } finally { await fs.rmdir(lock); }
  }
  async function list(): Promise<Goal[]> {
    let names: string[];
    try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const goals = await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name => get(name.slice(0, -5))));
    return goals.filter((goal): goal is Goal => goal !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return { create, update, list, get };
}
