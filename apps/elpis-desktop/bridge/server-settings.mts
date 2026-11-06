import { BridgeError, MAX_BRIDGE_MESSAGE_BYTES } from './client.mts';
import { appIdentity } from './app-identity.mts';
import { body, json, pageQuery } from './server-http.mts';

export async function handleSettingsRoutes(state: import('./server-http.mts').ServerState, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL, method: string) {
  const { client, settingsFiles } = state;
  if (url.pathname === '/api/models' && method === 'GET') { json(response, 200, await client.models(pageQuery(url, false, true))); return true; }
  if (url.pathname === '/api/about' && method === 'GET') { json(response, 200, await appIdentity()); return true; }
  const settingsFile = url.pathname.match(/^\/api\/settings\/files\/(instructions|memory)$/);
  if (settingsFile) { json(response, 200, method === 'GET' ? await settingsFiles.read(settingsFile[1]) : await settingsFiles.save(settingsFile[1], await body(request, MAX_BRIDGE_MESSAGE_BYTES))); return true; }
  if (url.pathname === '/api/settings' && method === 'GET') { json(response, 200, await client.settings()); return true; }
  if (url.pathname === '/api/settings' && method === 'POST') { json(response, 200, await client.saveSettings(await body(request))); return true; }
  if (url.pathname === '/api/pruner' && method === 'POST') { json(response, 200, await client.savePruner(await body(request))); return true; }
  if (url.pathname === '/api/providers') { json(response, 200, method === 'GET' ? await client.providers() : await client.signIn(await body(request))); return true; }
  if (url.pathname === '/api/providers/cloudroom') { json(response, 200, method === 'GET' ? await client.cloudroom() : await client.cloudroom(await body(request))); return true; }
  if (url.pathname === '/api/providers/claude-accounts') { json(response, 200, method === 'GET' ? await client.claudeAccounts() : await client.claudeAccounts(await body(request))); return true; }
  if (url.pathname === '/api/providers/settings') { json(response, 200, method === 'GET' ? await client.providerSettings() : await client.saveProvider(await body(request))); return true; }
  if (url.pathname === '/api/providers/key' && method === 'POST') { json(response, 200, await client.saveProviderKey(await body(request))); return true; }
  if (url.pathname === '/api/mcp/import') { json(response, 200, method === 'GET' ? await client.previewClaudeMcp() : await client.importClaudeMcp(await body(request))); return true; }
  if (url.pathname === '/api/mcp') { json(response, 200, method === 'GET' ? await client.mcp() : await client.saveMcp(await body(request))); return true; }
  if (url.pathname === '/api/customize' && method === 'GET') { json(response, 200, await client.customize(url.searchParams.get('cwd') || undefined)); return true; }
  if (url.pathname === '/api/customize/skill' && method === 'POST') { json(response, 200, await client.setSkill(await body(request))); return true; }
  if (url.pathname === '/api/customize/skill/delete' && method === 'POST') { json(response, 200, await client.deleteSkill(await body(request))); return true; }
  if (url.pathname === '/api/customize/skill/undo' && method === 'POST') { json(response, 200, await client.undoSkillDelete(await body(request))); return true; }
  if (url.pathname === '/api/customize/github' && method === 'POST') { json(response, 200, await client.setGithubConnector(await body(request))); return true; }
  if (url.pathname === '/api/customize/plugins' && method === 'GET') { json(response, 200, await client.pluginCatalog(Object.fromEntries(['cwd', 'search', 'cursor'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])))); return true; }
  if (url.pathname === '/api/customize/plugin' && method === 'POST') { json(response, 200, await client.changePlugin(await body(request))); return true; }
  if (url.pathname === '/api/customize/marketplace' && method === 'POST') { json(response, 200, await client.changeMarketplace(await body(request))); return true; }
  if (url.pathname === '/api/context/switches') { json(response, 200, method === 'GET' ? await client.contextSwitches() : await client.saveContextSwitches(await body(request))); return true; }
  if (url.pathname === '/api/hooks') { json(response, 200, method === 'GET' ? await client.hooks() : await client.saveHook(await body(request))); return true; }
  if (url.pathname === '/api/memories/count' && method === 'GET') {
    if ([...url.searchParams.keys()].length) throw new BridgeError('Unsupported memory count parameters');
    json(response, 200, { count: await settingsFiles.countMemoryFiles() }); return true;
  }
  if (url.pathname === '/api/memories/reset' && method === 'POST') { json(response, 200, await client.resetMemories(await body(request))); return true; }
  return false;
}
