'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');

const SESSION_MANAGER_ID_KEY = 'elpis-session-manager-v1';
const SESSION_GROUPS_KEY = 'elpis-chat-groups-v1';
const SESSION_MANAGER_ACTIONS_KEY = 'elpis-session-manager-actions-v1';
const MAX_REQUEST_BYTES = 65_536;

function projectPath(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); }
}
// Deliberately conservative: an arbitrary meaningful title cannot be declared irrelevant by a model.
function irrelevantName(thread) {
  const names = [thread.name, thread.workflowTaskTitle, thread.workflowTitle].map(name => name?.trim() || '').filter(Boolean);
  return names.every(name => /^(?:untitled(?: (?:session|conversation|chat))?|new (?:chat|conversation|session))$/i.test(name));
}
function lastActivity(thread) {
  const values = [thread.createdAt, thread.updatedAt, thread.lastUpdatedAt, thread.recencyAt].filter(value => value != null)
    .map(value => typeof value === 'number' ? value * 1000 : Date.parse(value));
  return values.length && values.every(Number.isFinite) ? Math.max(...values) : null;
}
function eligibility(thread, project, now = Date.now()) {
  let reason;
  if (!project || projectPath(thread.cwd) !== project) reason = 'The session is outside this review’s project.';
  else if (thread.archived || thread.path?.includes('/archived_sessions/')) reason = 'The session is already archived.';
  else if (thread.parentThreadId || thread.ephemeral || thread.source === 'exec' || (typeof thread.source === 'object' && thread.source?.subAgent)) reason = 'Agent and temporary sessions are excluded.';
  else if (!['idle', 'notLoaded'].includes(thread.status?.type)) reason = 'The session is running or its status is unknown.';
  else if (!irrelevantName(thread)) reason = 'The session already has a meaningful name.';
  if (reason) return { canRename: false, canArchive: false, reason };
  const activity = lastActivity(thread);
  return { canRename: true, canArchive: activity !== null && activity < now - 7 * 86400_000,
    reason: 'The session name is unset or a placeholder.', lastActivity: activity };
}

function readActions(stored) {
  if (stored.error) throw Error(stored.error);
  const actions = JSON.parse(stored[SESSION_MANAGER_ACTIONS_KEY] || '{}');
  if (!record(actions) || Object.values(actions).some(value => !Array.isArray(value))) throw Error('Could not read Session Manager action reasons. No change was made.');
  return actions;
}

function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function parseGroups(raw) {
  if (raw === undefined) return { groups: [], members: {}, groupBy: 'none', sortBy: 'recency', collapsed: [], order: [] };
  let state;
  try { state = JSON.parse(raw); } catch { throw Error('Could not read saved session groups. No change was made.'); }
  if (!record(state) || !Array.isArray(state.groups) || !record(state.members) || !Array.isArray(state.collapsed) || !Array.isArray(state.order)) {
    throw Error('Saved session groups have an unsupported format. No change was made.');
  }
  return state;
}

async function listActive(client, searchTerm, includeAgentRuns = false) {
  const data = [];
  const seen = new Set();
  let cursor;
  for (;;) {
    const result = await client.listThreads({ limit: 100, includeAgentRuns, ...(cursor ? { cursor } : {}), ...(searchTerm ? { searchTerm } : {}) });
    data.push(...result.data);
    cursor = result.nextCursor;
    if (!cursor) return { data, truncated: false };
    if (seen.has(cursor)) throw Error('Could not read every session: repeated page cursor.');
    seen.add(cursor);
  }
}

function groupName(state, threadId) {
  const id = state.members[threadId];
  return state.groups.find(group => group.id === id)?.name ?? '';
}

async function handleTool(name, args, { client, store, managerThreadId, project }) {
  if (!record(args)) throw Error('Tool arguments must be an object.');
  const stored = store.read();
  if (stored.error) throw Error(stored.error);
  if (stored[SESSION_MANAGER_ID_KEY] !== managerThreadId) throw Error('Session Manager identity is not registered in Elpis.');
  const groupState = parseGroups(stored[SESSION_GROUPS_KEY]);

  if (name === 'session_list') {
    const searchTerm = args.searchTerm === undefined ? '' : args.searchTerm;
    if (typeof searchTerm !== 'string' || searchTerm.length > 200) throw Error('Search text must be 200 characters or fewer.');
    const { data, truncated } = await listActive(client, searchTerm.trim());
    const sessions = [];
    for (const listed of data.filter(thread => thread.id !== managerThreadId)) {
      // Lists can lag native settings. Resolve possible candidates without resuming them or reading messages.
      const thread = project() && irrelevantName(listed) && ['idle', 'notLoaded'].includes(listed.status?.type)
        ? await client.readThreadMetadata(listed.id) : listed;
      sessions.push({
        sessionId: thread.id,
        name: thread.name || thread.workflowTitle || 'Untitled session',
        project: thread.cwd ? path.basename(thread.cwd.replace(/[\\/]+$/, '')) : '',
        lastActivity: lastActivity(thread),
        status: thread.status?.type ?? 'unknown',
        group: groupName(groupState, thread.id),
        ...eligibility(thread, project()),
      });
    }
    return {
      sessions,
      groups: groupState.groups.map(group => group.name),
      truncated,
    };
  }

  if (!['session_rename', 'session_organize', 'session_archive'].includes(name)) throw Error('Unknown Session Manager action.');
  if (Object.hasOwn(args, 'sessionIds') || Object.hasOwn(args, 'threadIds')) throw Error('Session Manager actions operate on one session at a time.');
  const id = args.sessionId;
  if (typeof id !== 'string' || !id || id.length > 200) throw Error('Choose one valid session.');
  if (id === managerThreadId) throw Error('The Session Manager chat cannot manage itself.');
  const { data } = await listActive(client);
  if (!data.some(thread => thread.id === id)) throw Error('That session is not in the active session list. No change was made.');
  const target = await client.readThreadMetadata(id);
  if (name === 'session_rename') {
    if (Object.keys(args).some(key => !['sessionId', 'name'].includes(key))) throw Error('Rename one session by ID and name only.');
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 120) throw Error('Session names must contain 1 to 120 characters.');
  } else if (name === 'session_organize') {
    if (Object.keys(args).some(key => !['sessionId', 'groupName'].includes(key))) throw Error('Move one session by ID and group name only.');
    if (typeof args.groupName !== 'string' || args.groupName.trim().length > 60) throw Error('Group names must be 60 characters or fewer.');
  } else if (Object.keys(args).some(key => key !== 'sessionId')) throw Error('Archive one session by ID only.');
  const guard = async thread => {
    const reviewProject = project();
    const rule = eligibility(thread, reviewProject);
    if (!rule.canRename) throw Error(rule.reason);
    if (name === 'session_archive') {
      if (!rule.canArchive) throw Error('Archive requires an unset or irrelevant name and no activity for more than 7 days.');
      // Native archive cascades to descendants. Refuse trees so no protected child can be changed indirectly.
      const all = client.sessionHasChildren ? null : await listActive(client, undefined, true);
      if (all ? all.truncated || all.data.some(item => item.parentThreadId === id) : await client.sessionHasChildren(id)) throw Error('Cannot archive a session with spawned chats or an incomplete child list.');
      if (project() !== reviewProject) throw Error('The automatic review ended before the session could be archived.');
    }
  };
  await guard(target);
  const reason = name === 'session_archive'
    ? 'Name unset or irrelevant; no activity for more than 7 days; idle in this review’s project.'
    : 'Name unset or irrelevant; idle in this review’s project.';
  const actions = readActions(store.read());
  const entry = { action: name.slice(8), reason, at: Date.now(), project: project(), previousName: target.name ?? null, status: 'pending' };
  actions[id] = [...(actions[id] ?? []), entry];
  // Save intent before mutation: a failed journal write must never cause an unrecorded action.
  await store.set(SESSION_MANAGER_ACTIONS_KEY, JSON.stringify(actions));
  async function act(operation) {
    try { await operation(); entry.status = 'done'; }
    catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
    finally { await store.set(SESSION_MANAGER_ACTIONS_KEY, JSON.stringify(actions)); }
  }

  if (name === 'session_rename') {
    await act(() => client.renameThread(id, { name: args.name.trim() }, guard));
    return { renamed: true, name: args.name.trim(), project: target.cwd ? path.basename(target.cwd.replace(/[\\/]+$/, '')) : '' };
  }

  if (name === 'session_organize') {
    const group = args.groupName.trim();
    let groupId = null;
    if (group) {
      let existing = groupState.groups.find(item => typeof item.name === 'string' && item.name.toLowerCase() === group.toLowerCase());
      if (!existing) {
        existing = { id: randomUUID(), name: group };
        groupState.groups.push(existing);
      }
      groupId = existing.id;
    }
    const members = { ...groupState.members };
    if (groupId) members[id] = groupId; else delete members[id];
    await act(() => store.set(SESSION_GROUPS_KEY, JSON.stringify({ ...groupState, groups: groupState.groups, members, groupBy: 'custom' })));
    return { organized: true, name: target.name || 'Untitled session', group: group || null };
  }

  await act(() => client.archiveThread(id, {}, guard, { reason }));
  return { archived: true, name: target.name || 'Untitled session', project: target.cwd ? path.basename(target.cwd.replace(/[\\/]+$/, '')) : '', reason };
}

function startSessionManagerAgent({ client, store }) {
  if (!client || !store) throw TypeError('Session Manager agent requires a desktop client and workspace store.');
  const socketPath = path.join(os.tmpdir(), `elpis-session-manager-${process.pid}-${randomUUID()}.sock`);
  const scopes = new Map();
  const projects = new Map();
  let queue = Promise.resolve();
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', async chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES) { socket.end(`${JSON.stringify({ error: 'Session Manager request exceeded 64 KB.' })}\n`); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = Buffer.alloc(0);
      try {
        const request = JSON.parse(line);
        const { name, arguments: args, capability, managerThreadId } = request;
        if (typeof managerThreadId !== 'string' || typeof capability !== 'string' || !capability || scopes.get(managerThreadId) !== capability) throw Error('Session Manager capability or chat identity is invalid.');
        const review = projects.get(managerThreadId);
        const run = () => handleTool(name, args, { client, store, managerThreadId, project: () => projects.get(managerThreadId) === review ? review?.cwd : undefined });
        const action = queue.then(run); queue = action.catch(() => {});
        const result = await action;
        socket.end(`${JSON.stringify({ result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      fs.chmodSync(socketPath, 0o600);
      resolve({
        path: socketPath,
        beginReview(threadId, cwd) {
          const project = projectPath(cwd);
          if (!project || !scopes.has(threadId) || projects.has(threadId)) throw Error('Session Manager review needs one project and an idle manager.');
          const review = { cwd: project };
          projects.set(threadId, review);
          return () => { if (projects.get(threadId) === review) projects.delete(threadId); };
        },
        scope(threadId) {
          if (typeof threadId !== 'string' || !threadId) throw TypeError('Session Manager scope needs a thread ID.');
          const capability = scopes.get(threadId) ?? randomBytes(32).toString('hex');
          scopes.set(threadId, capability);
          return capability;
        },
        bind(from, to) {
          const capability = scopes.get(from);
          if (!capability) throw Error('Session Manager scope was not prepared for this thread.');
          scopes.delete(from); scopes.set(to, capability);
        },
        revoke(threadId) { scopes.delete(threadId); projects.delete(threadId); },
        async close() {
          for (const threadId of scopes.keys()) scopes.delete(threadId);
          projects.clear();
          await new Promise(done => server.close(done));
          await fs.promises.unlink(socketPath).catch(() => {});
        },
      });
    });
  });
}

module.exports = { SESSION_MANAGER_ID_KEY, SESSION_GROUPS_KEY, SESSION_MANAGER_ACTIONS_KEY, eligibility, readActions, listActive, handleTool, startSessionManagerAgent };
