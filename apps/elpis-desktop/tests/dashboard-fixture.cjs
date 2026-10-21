const fs = require('node:fs');
const path = require('node:path');
const { DASHBOARD_ASSETS } = require('../bridge/dashboard-assets.mjs');
const assets = path.resolve(__dirname, '../../..', 'codex-rs/tui/src/dashboard_assets');
const token = 'a'.repeat(32);

function dashboardRoutes() {
  const envelope = JSON.parse(fs.readFileSync(path.join(assets, 'fixtures/activity-state.json')));
  envelope.heartbeat_at = Date.now();
  const routes = {
    '/api/dashboard': () => ({ url: `/api/dashboard/#evidence=${token}` }),
    '/api/dashboard/data.json': () => ({ ...envelope, heartbeat_at: Date.now() }),
    '/api/dashboard/agents.json': () => ({ agents: [{ id: 'chat-a', title: 'Fix the parser', parent_id: null, model: 'gpt-6.1-sol', status: 'ready', status_label: 'Ready' }] }),
    [`/api/dashboard/threads/${token}/chat-a`]: () => ({ thread: { id: 'chat-a' }, data: [{ item: { type: 'agentMessage', text: 'Parser fixed.' } }], nextCursor: null }),
    [`/api/dashboard/evidence/${token}/index.json`]: () => [],
    [`/api/dashboard/models/${token}`]: () => ({ providers: [] }),
    [`/api/dashboard/provider-keys/${token}`]: () => ({ providers: [] }),
    [`/api/dashboard/pruner-settings/${token}`]: () => ({ settings: { system_prompt: null }, default_system_prompt: 'Keep the facts.' }),
  };
  for (const file of DASHBOARD_ASSETS) routes[file === 'index.html' ? '/api/dashboard/' : `/api/dashboard/${file}`] = () => ({ __asset: {
    mimeType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', bytes: fs.readFileSync(path.join(assets, file)),
  } });
  return routes;
}
module.exports = { dashboardRoutes };
