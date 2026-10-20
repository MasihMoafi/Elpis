'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');

const SESSION_MANAGER_ID_KEY = 'elpis-session-manager-v1';
const SESSION_GROUPS_KEY = 'elpis-chat-groups-v1';
const MAX_REQUEST_BYTES = 65_536;

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

async function listActive(client, searchTerm) {
  const data = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await client.listThreads({ limit: 100, includeAgentRuns: false, ...(cursor ? { cursor } : {}), ...(searchTerm ? { searchTerm } : {}) });
    data.push(...result.data);
    cursor = result.nextCursor;
    if (!cursor) return { data, truncated: false };
  }
  return { data, truncated: !!cursor };
}

function groupName(state, threadId) {
  const id = state.members[threadId];
  return state.groups.find(group => group.id === id)?.name ?? '';
}

async function handleTool(name, args, { client, store, managerThreadId }) {
  if (!record(args)) throw Error('Tool arguments must be an object.');
  const stored = store.read();
  if (stored.error) throw Error(stored.error);
  if (stored[SESSION_MANAGER_ID_KEY] !== managerThreadId) throw Error('Session Manager identity is not registered in Elpis.');
  const groupState = parseGroups(stored[SESSION_GROUPS_KEY]);

  if (name === 'session_list') {
    const searchTerm = args.searchTerm === undefined ? '' : args.searchTerm;
    if (typeof searchTerm !== 'string' || searchTerm.length > 200) throw Error('Search text must be 200 characters or fewer.');
    const { data, truncated } = await listActive(client, searchTerm.trim());
    return {
      sessions: data.filter(thread => thread.id !== managerThreadId).map(thread => ({
        sessionId: thread.id,
        name: thread.name || thread.workflowTitle || 'Untitled session',
        project: thread.cwd ? path.basename(thread.cwd.replace(/[\\/]+$/, '')) : '',
        lastActivity: thread.updatedAt ?? thread.lastUpdatedAt ?? thread.createdAt ?? null,
        status: thread.status?.type ?? 'unknown',
        group: groupName(groupState, thread.id),
      })),
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
  const target = data.find(thread => thread.id === id);
  if (!target) throw Error('That session is not in the active session list. No change was made.');

  if (name === 'session_rename') {
    if (Object.keys(args).some(key => !['sessionId', 'name'].includes(key))) throw Error('Rename one session by ID and name only.');
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.trim().length > 120) throw Error('Session names must contain 1 to 120 characters.');
    await client.renameThread(id, { name: args.name.trim() });
    return { renamed: true, name: args.name.trim(), project: target.cwd ? path.basename(target.cwd.replace(/[\\/]+$/, '')) : '' };
  }

  if (name === 'session_organize') {
    if (Object.keys(args).some(key => !['sessionId', 'groupName'].includes(key))) throw Error('Move one session by ID and group name only.');
    if (typeof args.groupName !== 'string' || args.groupName.trim().length > 60) throw Error('Group names must be 60 characters or fewer.');
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
    await store.set(SESSION_GROUPS_KEY, JSON.stringify({ ...groupState, groups: groupState.groups, members, groupBy: 'custom' }));
    return { organized: true, name: target.name || 'Untitled session', group: group || null };
  }

  if (Object.keys(args).some(key => key !== 'sessionId')) throw Error('Archive one session by ID only.');
  await client.archiveThread(id, {});
  return { archived: true, name: target.name || 'Untitled session', project: target.cwd ? path.basename(target.cwd.replace(/[\\/]+$/, '')) : '', spawnedAgentsArchived: true };
}

function startSessionManagerAgent({ client, store }) {
  if (!client || !store) throw TypeError('Session Manager agent requires a desktop client and workspace store.');
  const socketPath = path.join(os.tmpdir(), `elpis-session-manager-${process.pid}-${randomUUID()}.sock`);
  const scopes = new Map();
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
        if (typeof managerThreadId !== 'string' || scopes.get(managerThreadId) !== capability) throw Error('Session Manager capability or chat identity is invalid.');
        const result = await handleTool(name, args, { client, store, managerThreadId });
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
        revoke(threadId) { scopes.delete(threadId); },
        async close() {
          for (const threadId of scopes.keys()) scopes.delete(threadId);
          await new Promise(done => server.close(done));
          await fs.promises.unlink(socketPath).catch(() => {});
        },
      });
    });
  });
}

module.exports = { SESSION_MANAGER_ID_KEY, SESSION_GROUPS_KEY, handleTool, startSessionManagerAgent };
