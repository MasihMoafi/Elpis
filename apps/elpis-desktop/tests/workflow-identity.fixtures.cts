import type { Locator, Page } from './playwright-types.mts';



const fs = require('node:fs/promises');

const path = require('node:path');

const os = require('node:os');

export type Fixture = { page: Page; composer: Locator; posts: { path: string; body: unknown }[]; errors: string[]; emit(type: string, data: unknown): void; shown(): Promise<string | null>; close(): Promise<void> };

const { fixture, CWD }: { fixture(options: object): Promise<Fixture>; CWD: string } = require('./parity-fixture.cts');

export type Task = { id: string; title: string; assignedThreadId?: string; status?: string; threads?: string[]; [key: string]: unknown };

export type Run = { id: string; rootThreadId: string; name: string; status: string; startedAt?: number; tasks: Task[]; mother?: { sessionId?: string; threads?: string[]; [key: string]: unknown }; [key: string]: unknown };

export type PlannedRun = Run & { startedAt: number; tasks: (Task & { assignedThreadId: string; status: string })[] };



const runs = ['Fix a bug', 'Fix a bug', 'Research pricing', 'Ship exporter'].map((name, i) => ({
  id: `run-${i}`, rootThreadId: i ? `root-${i}` : 'chat-a', name, status: i < 2 ? 'running' : 'succeeded', startedAt: 100 + i,
  tasks: ['Inspect', 'Build', 'Review'].map((title, j) => ({ id: `step-${j}`, title, assignedThreadId: `step-${i}-${j}`, status: i < 2 ? 'running' : 'succeeded' })),
})) as [PlannedRun, PlannedRun, PlannedRun, PlannedRun];

const base = (id: string, name: string, active = false) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: active ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });

const graph = { workflowId: 'run-0', name: 'Fix a bug', nodes: [{ id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} }, { id: 'writer', type: 'agent', position: { x: 400, y: 0 }, data: { title: 'Build', instruction: 'Return the requested evidence.', model: null, writeScopes: ['.'], acceptanceCriteria: ['Return evidence'] } }], edges: [] };

const open = async (colorScheme: string, savedRuns: Run[] = runs, state: Record<string, string> = {}, names: Record<string, string> = {}, routes: Record<string, (body: unknown, url: URL) => unknown> = {}, models: Record<string, string> = {}) => {
  const listed = [...new Map(savedRuns.flatMap(run => [base(run.rootThreadId, run.name), ...(run.tasks ?? []).flatMap(task => typeof task.assignedThreadId === 'string' && task.assignedThreadId ? [base(task.assignedThreadId, `Workflows · ${task.title}`, task.status === 'running')] : []), ...(run.mother?.sessionId ? [base(run.mother.sessionId, 'Workflows · Mother agent')] : []), ...(run.tasks ?? []).flatMap(task => (task.threads ?? []).map(id => base(id, `Workflows · ${task.title}`))), ...(run.mother?.threads ?? []).map(id => base(id, 'Workflows · Mother agent'))]).map(thread => [thread.id, thread])).values()].map(thread => ({ ...thread, name: names[thread.id] ?? thread.name, model: models[thread.id] ?? thread.model }));
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme, threads: listed,
  // The fixture waits for chat-a, a workflow here, so the Workflows section is open (it starts folded: sidebar-organize.runtime.mts).
  // S18, Masih 29 Oct: the sidebar's Workflows section is off by default; these tests turn it on.
  storage: { 'elpis-preferences-v1': JSON.stringify({ sidebarWorkflows: true }), 'elpis-sidebar-folds-v1': JSON.stringify({ sections: { workflows: false }, projects: {} }), 'elpis-workflow-draft-v1': JSON.stringify(graph), 'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'p', name: 'Fixture', cwd: CWD }], selectedId: 'p' }), ...state },
  routes: { '/api/threads': (_body: unknown, url: URL) => ({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : listed, nextCursor: null }), '/api/workflows/history': () => ({ data: savedRuns }), '/api/folders': () => ({ data: [] }), '/api/workflows': () => ({ data: [] }), ...routes } });
  return f;
};

const sidebar = (page: Page) => page.locator('aside.sidebar');

const workflows = (page: Page) => sidebar(page).locator('section[aria-label="Workflows"]');

const row = (page: Page, id: string) => sidebar(page).locator(`.thread-row[data-thread-id="${id}"]`);

const markColor = (locator: Locator) => locator.evaluate(el => getComputedStyle(el).backgroundColor);

async function eventually<T>(check: () => T | Promise<T>): Promise<T> { const deadline = Date.now() + 5000; for (;;) { try { return await check(); } catch (e) { if (Date.now() > deadline) throw e; await new Promise(resolve => setTimeout(resolve, 40)); } } }

async function shot(page: Page, name: string) { const dir = process.env.ELPIS_PARITY_SHOTS || path.join(os.homedir(), '.cache/elpis-shots'); await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `wfident-${name}.png`) }); }

const fixtures = { runs, base, graph, open, sidebar, workflows, row, markColor, eventually, shot };
export type Fixtures = typeof fixtures;
module.exports = fixtures;
