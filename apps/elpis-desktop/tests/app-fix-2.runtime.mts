// APP-FIX-2 acceptance: real native runtime + real browser; only inference is a local fixture.
// Usage: ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/app-fix-2.runtime.mts /abs/elpis-next [--shots DIR]
// Each check runs independently and is reported; any failure exits non-zero.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { chooseOption, controlValue, WebSocket, shots, followOnly, wireRequests, root, home, agentCwd, SECRET, message, exec, spawnChild, HANG, fixture, releaseFollow, reply, requestsWith, providerUrl, socketPath, app, page, results, wait, until, check, shoot, api, composer, send, requestsOf, lastRequest, nav, childTitleFor, humanTask, startApp, startRuntime, finishRun, followGate, setApp } from './app-fix-2-setup.mts';
import type { Thread, Approval } from './app-fix-2-setup.mts';

try {
  const { pageErrors, loaded } = await startRuntime();
  // Setup: one root conversation that spawns one real multi-agent v2 child.
  const marker = path.join(root, 'child-approved.txt');
  reply('SPAWN_4242', spawnChild, message('ROOT_SPAWN_DONE_4242'));
  if (followOnly) fixture.child.push({ gate: new Promise<void>(resolve => { followGate(resolve); }), item: message('CHILD_FOLLOW_LIVE_4242') });
  else fixture.child.push(exec('child_approval', `printf approved > '${marker}'`, true), exec('child_sleep', 'sleep 8'), HANG);
  await send('SPAWN_4242 spawn the fixture child');
  await page.getByText('ROOT_SPAWN_DONE_4242', { exact: true }).waitFor({ timeout: 30000 });
  await until(() => requestsOf('child').length >= 1, 'child started', 30000);
  const roots = (await api('/threads?limit=20')).body.data;
  const rootThread = roots.find(t => t.preview?.includes('SPAWN_4242'));
  assert(rootThread, 'root conversation listed');
  let foundChild: Thread | undefined;
  await until(async () => { foundChild = (await api(`/threads?ancestorThreadId=${rootThread.id}&limit=20`)).body.data?.[0]; return !!foundChild; }, 'child listed');
  assert(foundChild);
  const childThread = foundChild;
  assert(childThread.agentNickname, 'native child has a nickname');
  const childTitle = childThread.name || childThread.preview || humanTask(childThread.source?.subAgent?.thread_spawn?.agent_path);
  assert.equal(childTitle, 'Failure reporting');

  if (followOnly) {
    await check('read-only child reconnects live without refreshing and keeps its history and parent draft', async () => {
      await until(() => fixture.gated, 'child output held', 30000);
      await composer().fill('Parent draft survives reconnect');
      const showChild = async () => {
        const rootRow = page.locator(`.thread-row[data-thread-id="${rootThread.id}"]`).first();
        await rootRow.getByRole('button', { name: /^Actions for / }).click();
        const agentsItem = page.getByRole('menuitem', { name: /^(Show|Hide) agents$/ });
        if ((await agentsItem.innerText()).startsWith('Show')) await agentsItem.click(); else await page.keyboard.press('Escape');
        await page.locator(`.thread-row[data-thread-id="${childThread.id}"] .thread-link`).click();
        await page.getByRole('heading', { level: 1, name: childTitle }).waitFor();
      };
      await showChild();
      assert.equal(await composer().count(), 0, 'active child is read-only');
      assert.equal(await page.getByText(/Not following live/).count(), 0);
      const port = Number(new URL(app.url).port);
      await app.close();
      setApp(await startApp(port));
      await page.goto(app.url);
      await page.getByText('Local workspace', { exact: true }).waitFor();
      let historyReads = 0;
      page.on('request', request => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/threads/${childThread.id}`) historyReads++;
      });
      const followed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/threads/${childThread.id}/resume` && response.status() === 200);
      await showChild();
      await followed;
      await wait(500);
      const reads = historyReads, pageLoads = loaded.count;
      await wait(3500);
      assert.equal(historyReads, reads, 'following a child does not poll its history');
      assert.equal(loaded.count, pageLoads, 'the page does not refresh');
      assert.equal(await page.getByText(/Not following live/).count(), 0);
      assert(releaseFollow); releaseFollow();
      await page.getByText('CHILD_FOLLOW_LIVE_4242', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.getByText('CHILD_FOLLOW_LIVE_4242', { exact: true }).count(), 1);
      if (shots) { await fs.mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'subagent-live-follow.png') }); }
      await page.locator(`.thread-row[data-thread-id="${rootThread.id}"] .thread-link`).first().click();
      assert.equal(await composer().inputValue(), 'Parent draft survives reconnect');
      reply('FOLLOW_PARENT_4242', message('FOLLOW_PARENT_OK_4242'));
      await send('FOLLOW_PARENT_4242');
      await page.getByText('FOLLOW_PARENT_OK_4242', { exact: true }).waitFor({ timeout: 30000 });
      await page.locator(`.thread-row[data-thread-id="${childThread.id}"] .thread-link`).click();
      await page.getByText('CHILD_FOLLOW_LIVE_4242', { exact: true }).waitFor();
      assert.equal(await page.getByText('CHILD_FOLLOW_LIVE_4242', { exact: true }).count(), 1, 'completed history has one copy');
      const bridgeRequests = wireRequests.filter(request => request?.params?.threadId === childThread.id);
      assert(bridgeRequests.some(request => request.method === 'thread/subscribe'), 'viewer uses the native read-only subscription');
      assert.equal(bridgeRequests.some(request => ['thread/resume', 'thread/settings/update', 'turn/start'].includes(request.method)), false, 'viewer sends no child mutation or resume');
    });
  } else {
  await check('child approval is answered from the app (expanded, with session option)', async () => {
    await page.getByRole('button', { name: /^Needs input \(1\)$/ }).click();
    const panel = page.locator('.approval').filter({ hasText: 'printf approved' });
    await panel.waitFor({ timeout: 15000 });
    assert.match(await panel.locator('pre').innerText(), /printf approved/, 'command is visible without expanding');
    // Every decision Elpis offers is a button: never "allow once" only when more is offered.
    const pending = await page.evaluate(() => new Promise<Approval>(resolve => { const events = new EventSource('/api/events'); events.addEventListener('approval', event => { events.close(); resolve(JSON.parse(event.data)); }); }));
    const offered = pending.params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
    console.log('offered decisions:', JSON.stringify(offered));
    assert.equal(await panel.getByRole('button').count(), offered.length, 'one button per offered decision');
    assert.equal(await panel.getByRole('button', { name: /^Always allow|Allow for this session/ }).count(), offered.filter(d => d === 'acceptForSession' || typeof d === 'object').length);
    assert.equal(await page.locator('.pending-input-panel').getByText(childTitleFor(pending), { exact: true }).count() > 0, true, 'requester named by its task');
    await shoot('approval');
    await panel.getByRole('button', { name: 'Allow once', exact: true }).click();
    await until(async () => (await fs.readFile(marker, 'utf8').catch(() => '')) === 'approved', 'approved command ran');
  });

  await check('titles-not-nicknames (sidebar)', async () => {
    const rootRow = page.locator(`.thread-row[data-thread-id="${rootThread.id}"]`);
    // A chat's agents are shown from its row menu (the row's hover shows only Pin and Archive, as in the ChatGPT app).
    await rootRow.first().getByRole('button', { name: /^Actions for / }).click();
    const agentsItem = page.getByRole('menuitem', { name: /^(Show|Hide) agents$/ });
    if ((await agentsItem.innerText()).startsWith('Show')) await agentsItem.click(); else await page.keyboard.press('Escape');
    const sideChild = page.locator(`.thread-row[data-thread-id="${childThread.id}"]`);
    await sideChild.waitFor({ timeout: 10000 });
    assert.equal((await sideChild.locator('.thread-title').innerText()).trim(), childTitle);
    assert.equal(await sideChild.locator('.thread-nickname').count(), 0, 'Sidebar task title is shown without an arbitrary nickname');
    await shoot('sidebar', { mobileSidebar: true });
  });

  await api(`/threads/${childThread.id}/interrupt`, {});
  await until(() => fixture.hanging.size === 0, 'child fixture stopped');
  await check('writable child chat sends exactly one fixture request', async () => {
    await page.locator(`.thread-row[data-thread-id="${childThread.id}"] .thread-link`).click();
    await page.getByRole('heading', { level: 1, name: childTitle }).waitFor();
    await page.getByRole('button', { name: `Open parent: ${(await api(`/threads/${rootThread.id}?limit=1`)).body.thread.name || rootThread.preview}` }).waitFor();
    assert.equal(await page.getByText(/controlled by its parent/i).count(), 0);
    assert.equal(await page.getByText('Read-only conversation').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue here' }).count(), 0);
    assert.equal(await composer().isEnabled(), true);
    await shoot('child-chat');
    const before = fixture.requests.length;
    reply('CHILD_FOLLOWUP_4242', message('CHILD_CONTINUED_4242'));
    await send('CHILD_FOLLOWUP_4242');
    await page.getByText('CHILD_CONTINUED_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(500);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    assert.equal(requestsWith('CHILD_FOLLOWUP_4242').length, 1);
    const sent = JSON.stringify(lastRequest().body.input);
    assert.match(sent, /CHILD_TASK_4242/, 'continues the child history');
    assert.equal(lastRequest().body.model, childThread.model, 'recorded model kept');
  });

  await check('existing chat is writable after reconnect without Continue here', async () => {
    await app.close(); setApp(await startApp()); await page.goto(app.url);
    await page.locator(`.thread-row[data-thread-id="${rootThread.id}"] .thread-link`).click();
    await composer().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue here' }).count(), 0);
    const before = fixture.requests.length;
    reply('EXISTING_4242', message('EXISTING_REPLY_4242'));
    await send('EXISTING_4242');
    await page.getByText('EXISTING_REPLY_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(300);
    assert.equal(fixture.requests.length, before + 1);
    assert.match(JSON.stringify(lastRequest().body.input), /SPAWN_4242.*EXISTING_4242/s);
  });

  await check('a chat working in another client opens live and streams its reply', async () => {
    // Another client (as the terminal would) starts a turn whose reply is held by the fixture.
    const other = new WebSocket(`ws+unix://${await fs.realpath(socketPath)}:/`); await once(other, 'open');
    type RpcResult = { id: number; method?: string; result: { thread: Thread } };
    let next = 0; const waiting = new Map<number, (result: RpcResult) => void>(); other.on('message', (raw: Buffer) => { const m: RpcResult = JSON.parse(raw.toString()); if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
    const rpc = (method: string, params: object) => new Promise<RpcResult>(resolve => { const id = ++next; waiting.set(id, resolve); other.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'other-client', title: 'Other', version: '0' }, capabilities: { experimentalApi: true } }); other.send(JSON.stringify({ method: 'initialized', params: {} }));
    let release: (() => void) | undefined; reply('ELSEWHERE_4242', { gate: new Promise<void>(resolve => { release = resolve; }), item: message('ELSEWHERE_REPLY_4242') });
    const started = (await rpc('thread/start', {})).result.thread;
    await rpc('turn/start', { threadId: started.id, input: [{ type: 'text', text: 'ELSEWHERE_4242 work in the terminal', text_elements: [] }] });
    await until(() => fixture.gated, 'turn reached inference');
    await page.locator(`.thread-row[data-thread-id="${started.id}"] .thread-link`).click({ timeout: 15000 });
    await page.getByText('Working…', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Stop response' }).isVisible(), 'its running turn can be stopped from here');
    const loadsBefore = loaded.count; assert(release); release();
    await page.getByText('ELSEWHERE_REPLY_4242', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(loaded.count, loadsBefore, 'streamed without reload');
    other.close();
  });

  const agentThread = (await api('/threads', { model: 'gpt-6-luna', cwd: agentCwd })).body.thread;
  await api(`/threads/${agentThread.id}/rename`, { name: 'Docs reviewer 4242' });
  await page.reload();
  await page.locator(`.thread-row[data-thread-id="${agentThread.id}"] .thread-link`).click();

  await check('model and effort change is shown and reaches the next request', async () => {
    await chooseOption(page.getByLabel('Model', { exact: true }), 'gpt-5.5');
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'high');
    await page.getByLabel('Model', { exact: true }).filter({ hasText: /GPT-5\.5/i }).waitFor();
    await page.locator('[aria-label="Reasoning effort"][data-value="high"]').waitFor();
    reply('SETTINGS_4242', message('SETTINGS_REPLY_4242'));
    await send('SETTINGS_4242');
    await page.getByText('SETTINGS_REPLY_4242', { exact: true }).waitFor({ timeout: 30000 });
    // Switching models may make Elpis compact first; the turn's own request is the one that carries the message.
    const [turn] = requestsWith('SETTINGS_4242').filter(r => !JSON.stringify(r.body.input).includes('CONTEXT CHECKPOINT'));
    assert(turn, 'the turn reached inference');
    assert.equal(turn.body.model, 'gpt-5.5');
    assert.equal(turn.body.reasoning?.effort, 'high');
    await page.locator('.thread-meta').filter({ hasText: /GPT-5\.5/i }).filter({ hasText: 'high' }).waitFor();
  });

  await check('delete removes the chat everywhere (cancel keeps it)', async () => {
    const row = () => page.locator(`.thread-row[data-thread-id="${agentThread.id}"]`);
    await row().getByRole('button', { name: 'Actions for Docs reviewer 4242' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('Delete “Docs reviewer 4242”?').waitFor();
    await shoot('delete-confirm');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await wait(300);
    assert.equal(await row().count(), 1, 'cancel keeps the chat');
    await row().getByRole('button', { name: 'Actions for Docs reviewer 4242' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await until(async () => await row().count() === 0, 'row removed from sidebar');
    assert.equal((await api('/threads?limit=50')).body.data.some(t => t.id === agentThread.id), false, 'native list no longer has it');
    // A root with an agent and a continued agent chat: every piece disappears.
    const rootRow = page.locator(`.thread-row[data-thread-id="${rootThread.id}"]`);
    await rootRow.getByRole('button', { name: /^Actions for / }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await until(async () => await page.locator(`[data-thread-id="${rootThread.id}"], [data-thread-id="${childThread.id}"]`).count() === 0, 'root and agent removed');
    const remaining = (await api('/threads?limit=50')).body.data;
    assert.equal(remaining.some(t => t.id === rootThread.id || t.forkedFromId === childThread.id), false, 'root and continuation deleted natively');
    await until(async () => !(await api('/threads?limit=100')).body.data.some(t => t.id === childThread.id), 'its agent is deleted natively too');
    await wait(1500);
    assert.equal(await page.locator(`[data-thread-id="${childThread.id}"]`).count(), 0, 'the agent does not come back');
  });

  await check('MCP servers page: real config, no secrets, writes', async () => {
    await nav('Settings').click();
    await page.getByRole('tab', { name: 'MCP servers' }).click();
    const rag = page.locator('.mcp-server[data-name="rag"]'), whisper = page.locator('.mcp-server[data-name="whispertype"]');
    await rag.waitFor(); await whisper.waitFor();
    await rag.locator('.key-state code').filter({hasText:'OPENROUTER_API_KEY'}).waitFor();
    assert.equal(await page.getByLabel('rag RAG_MCP_MAX_TOKENS',{exact:true}).count(),0,'token budget is not an API-key field');
    assert.match(await rag.innerText(), /OPENROUTER_API_KEY\s*·?\s*set/i);
    assert.match(await rag.innerText(), /deepseek\/deepseek-v4\.1-flash/);
    assert.match(await whisper.innerText(), /OPENROUTER_API_KEY_COMPANY\s*·?\s*set/i);
    const raw = JSON.stringify((await api('/mcp')).body) + await page.content();
    assert.equal(raw.includes(SECRET), false, 'secret never reaches the renderer');
    assert.equal(raw.includes('company-key-not-shown'), false, 'environment secret never reaches the renderer');
    const ragKey = 'fixture-rag-key-replaced-4242';
    await page.getByLabel('rag OPENROUTER_API_KEY',{exact:true}).fill(ragKey);
    await rag.locator('form[aria-label="API keys for rag"]').getByRole('button',{name:'Save API keys',exact:true}).click();
    await rag.getByRole('status').filter({hasText:'API keys saved.'}).waitFor();
    assert.equal(await controlValue(page.getByLabel('rag OPENROUTER_API_KEY',{exact:true})),'');
    await until(async () => (await fs.readFile(path.join(home,'config.toml'),'utf8')).includes(ragKey),'RAG key saved');
    assert(!JSON.stringify((await api('/mcp')).body).includes(ragKey),'saved key is redacted');
    assert(!(await page.content()).includes(ragKey),'saved key never redisplayed');
    const whisperKey = 'fixture-whisper-key-replaced-4242';
    await page.getByLabel('whispertype OPENROUTER_API_KEY_COMPANY',{exact:true}).fill(whisperKey);
    await whisper.locator('form[aria-label="API keys for whispertype"]').getByRole('button',{name:'Save API keys',exact:true}).click();
    await whisper.getByRole('status').filter({hasText:'API keys saved.'}).waitFor();
    await until(async () => (await fs.readFile(path.join(home,'config.toml'),'utf8')).includes(whisperKey),'WhisperType key saved');
    assert(!JSON.stringify((await api('/mcp')).body).includes(whisperKey),'WhisperType key is redacted');
    await shoot('mcp');
    // The transcription route moved to Settings → Voice; it still writes WhisperType's MCP env.
    await whisper.getByRole('button', { name: 'Open Voice settings', exact: true }).click();
    const voice = page.getByRole('tabpanel', { name: 'Voice', exact: true });
    await chooseOption(voice.getByLabel('Fallback transcription engine', { exact: true }), 'local');
    await voice.getByRole('button', { name: 'Save transcription settings' }).click();
    await until(async () => /WHISPERTYPE_BACKEND\s*=\s*"local"/.test(await fs.readFile(path.join(home, 'config.toml'), 'utf8')), 'whispertype provider written');
    await page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
    await page.getByRole('button', { name: 'Add MCP server' }).click();
    await page.getByLabel('Server name').fill('fixture-extra');
    await page.getByLabel('Command').fill('/bin/true');
    await page.getByRole('button', { name: 'Save server' }).click();
    await page.locator('.mcp-server[data-name="fixture-extra"]').waitFor();
    assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /\[mcp_servers\.fixture-extra\]/);
    await page.locator('.mcp-server[data-name="fixture-extra"]').getByRole('button', { name: 'Remove fixture-extra' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await until(async () => await page.locator('.mcp-server[data-name="fixture-extra"]').count() === 0, 'server removed');
    assert.doesNotMatch(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /fixture-extra/);
  });

  await check('Providers page: separate auth and usage per provider', async () => {
    await page.getByRole('tab', { name: 'Models & accounts' }).click();
    const card = (id: string) => page.locator(`.provider-card[data-provider="${id}"]`);
    await card('openai').waitFor();
    assert.match(await card('openai').innerText(), /Not signed in/);
    assert(await card('openai').getByRole('button', { name: 'Sign in with ChatGPT' }).isVisible());
    assert.match(await card('claude').innerText(), /Not connected/);
    assert.match(await card('openrouter').innerText(), /OPENROUTER_API_KEY\s*·?\s*not set/i);
    assert.match(await card('local').innerText(), /LM Studio/);
    await shoot('providers');
  });

  await check('native API provider can be configured in the app and selected for real runtime inference', async () => {
    await nav('Settings').click(); await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await page.getByText('Advanced API connections',{exact:true}).click();
    await page.getByRole('button',{name:'Add API provider',exact:true}).click();
    await page.getByLabel('Provider ID',{exact:true}).fill('app-native-provider');
    await page.getByLabel('Provider display name',{exact:true}).fill('Fixture native API');
    await page.getByLabel('API endpoint',{exact:true}).fill(providerUrl);
    await chooseOption(page.getByLabel('API key action',{exact:true}), 'replace');
    const apiKey='fixture-native-api-key-4242';
    await page.getByLabel('Provider API key',{exact:true}).fill(apiKey);
    await shoot('native-api-provider-form');
    await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
    assert(!(await page.content()).includes(apiKey),'saved provider secret is never redisplayed');
    assert(!JSON.stringify((await api('/providers/settings')).body).includes(apiKey),'provider snapshot is redacted');
    assert((await api('/settings')).body.providers.some(provider=>provider.id==='app-native-provider'),'provider appears immediately in native settings');
    await nav('New chat').click();
    await page.getByLabel('Model',{exact:true}).click();
    await page.getByText('Configured API model…',{exact:true}).click();
    await chooseOption(page.getByLabel('Provider',{exact:true}), 'app-native-provider');
    await page.getByLabel('Model ID',{exact:true}).fill('fixture/custom-model');
    await page.getByRole('button',{name:'Use model',exact:true}).click();
    const before=fixture.requests.length;reply('PROVIDER_4242',message('PROVIDER_REPLY_4242'));
    await send('PROVIDER_4242');await page.getByText('PROVIDER_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+1,'exactly one local fixture request');
    assert.equal(lastRequest().authorization,`Bearer ${apiKey}`,'stored native key reaches the request');
    assert.equal(lastRequest().body.model,'fixture/custom-model');
    const thread=(await api('/threads?limit=50')).body.data.find(thread=>thread.preview?.includes('PROVIDER_4242'));
    assert.equal(thread?.modelProvider,'app-native-provider');
    assert.equal(thread.model,'fixture/custom-model');
    reply('PROVIDER_KEEP_4242',message('PROVIDER_KEEP_REPLY_4242'));
    await send('PROVIDER_KEEP_4242');await page.getByText('PROVIDER_KEEP_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+2,'second send preserves the native route');
    assert.equal(lastRequest().authorization,`Bearer ${apiKey}`);
    assert.equal(lastRequest().body.model,'fixture/custom-model');
    await nav('Settings').click();await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await page.getByRole('button',{name:'Edit Fixture native API',exact:true}).click();
    await chooseOption(page.getByLabel('API key action',{exact:true}), 'clear');
    await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
    const provider=(await api('/providers/settings')).body.providers.find(provider=>provider.id==='app-native-provider');
    assert(provider);
    assert.equal(provider.auth.keySet,false,'explicit clear removes saved credential');
    await nav('New chat').click();
    await page.getByLabel('Model',{exact:true}).click();
    await page.getByText('Configured API model…',{exact:true}).click();
    await chooseOption(page.getByLabel('Provider',{exact:true}), 'app-native-provider');
    await page.getByLabel('Model ID',{exact:true}).fill('fixture/custom-model');
    await page.getByRole('button',{name:'Use model',exact:true}).click();
    reply('PROVIDER_CLEAR_4242',message('PROVIDER_CLEAR_REPLY_4242'));
    await send('PROVIDER_CLEAR_4242');await page.getByText('PROVIDER_CLEAR_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+3,'new conversation after clear uses the same provider without the cleared credential');
    assert.equal(lastRequest().authorization,undefined,'cleared secret is not used');
    assert.equal(lastRequest().body.model,'fixture/custom-model');
    await nav('Settings').click();await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await shoot('native-api-provider');
  });

  // APP-FIX-3: ChatGPT/Claude parity. Each check plants a marker only the feature can move.
  const row = (id: string) => page.locator(`.thread-row[data-thread-id="${id}"]`);
  const rowMenu = async (id: string, item: string) => { await row(id).getByRole('button', { name: /^Actions for / }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  let parity: Thread | undefined;
  const parityId = () => { assert(parity); return parity.id; };
  await check('markdown renders tables, copyable code and external links', async () => {
    await nav('New chat').click();
    reply('PARITY_A_4242', message('| Col | Val |\n| --- | --- |\n| MD_CELL_4242 | 1 |\n\n```js\nconst CODE_4242 = 1;\n```\n\nSee [the docs](https://example.com/docs) for REPLY_A_4242.'));
    await send('PARITY_A_4242 first prompt');
    await page.getByText('REPLY_A_4242', { exact: false }).waitFor({ timeout: 30000 });
    parity = (await api('/threads?limit=20')).body.data.find(t => t.preview?.includes('PARITY_A_4242'));
    assert(parity, 'parity chat listed');
    assert.equal(await page.locator('.markdown table td').filter({ hasText: 'MD_CELL_4242' }).count(), 1, 'table rendered as a table');
    assert.equal(await page.getByText('| Col | Val |').count(), 0, 'no raw markdown table source');
    const link = page.locator('.markdown a', { hasText: 'the docs' });
    assert.equal(await link.getAttribute('target'), '_blank', 'links leave the app');
    await page.locator('.code-block').getByRole('button', { name: 'Copy code' }).click();
    assert.equal((await clipboard()).trim(), 'const CODE_4242 = 1;');
    await shoot('markdown');
  });

  await check('copy a sent message', async () => {
    await page.locator('.user-turn').filter({ hasText: 'PARITY_A_4242' }).getByRole('button', { name: 'Copy message' }).click();
    assert.equal(await clipboard(), 'PARITY_A_4242 first prompt');
  });

  await check('regenerate re-runs the last prompt once and replaces the reply', async () => {
    reply('PARITY_A_4242', message('REGENERATED_4242'));
    const before = fixture.requests.length;
    await page.getByRole('button', { name: 'Regenerate reply' }).last().click();
    await page.getByText('REGENERATED_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(400);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    assert.equal(await page.getByText('REPLY_A_4242', { exact: false }).count(), 0, 'old reply is gone');
    assert.doesNotMatch(JSON.stringify(lastRequest().body.input), /REPLY_A_4242/, 'old reply is not in the new request');
  });

  await check('edit an earlier prompt replaces it and every later turn', async () => {
    reply('PARITY_B_4242', message('REPLY_B_4242'));
    await send('PARITY_B_4242 second prompt');
    await page.getByText('REPLY_B_4242', { exact: true }).waitFor({ timeout: 30000 });
    const first = page.locator('.user-turn').filter({ hasText: 'PARITY_A_4242' });
    await first.getByRole('button', { name: 'Edit message' }).click();
    await page.getByLabel('Edited message').fill('PARITY_C_4242 edited prompt');
    await shoot('edit-message');
    reply('PARITY_C_4242', message('REPLY_C_4242'));
    const before = fixture.requests.length;
    await page.getByRole('form', { name: 'Edit message' }).getByRole('button', { name: 'Send' }).click();
    await page.getByText('REPLY_C_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(400);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    const sent = JSON.stringify(lastRequest().body.input);
    assert.match(sent, /PARITY_C_4242/);
    assert.doesNotMatch(sent, /PARITY_A_4242|PARITY_B_4242|REPLY_B_4242/, 'replaced turns are not sent');
    assert.equal(await page.getByText('REPLY_B_4242', { exact: true }).count(), 0, 'later turns removed from the chat');
    const history = JSON.stringify((await api(`/threads/${parityId()}?limit=100`)).body.data);
    assert.doesNotMatch(history, /PARITY_B_4242/, 'native history no longer has the later turn');
  });

  await check('Ctrl+Shift+K focuses chat search and filters the sidebar', async () => {
    const name = (await row(parityId()).locator('.thread-title').innerText()).trim();
    const listed = await page.locator('.thread-row').count();
    assert(listed > 1, 'several chats are listed');
    await page.locator('.chat-scroll').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+Shift+K');
    const search = page.getByLabel('Search conversations');
    assert.equal(await search.evaluate(element => element === document.activeElement), true, 'search is focused');
    try {
      await page.keyboard.type(name);
      await until(async () => await row(parityId()).count() === 1 && await page.locator('.thread-row').count() < listed, 'other chats hidden');
      await shoot('search');
      await search.fill(`${name} no-such-chat-4242`);
      await until(async () => await row(parityId()).count() === 0, 'a non-matching query hides it too');
    } finally { await search.fill(''); }
  });

  await check('rename from the row menu is saved in Elpis', async () => {
    await rowMenu(parityId(), 'Rename');
    const field = page.getByLabel('Conversation name');
    await field.fill('Renamed parity 4242');
    await shoot('rename');
    await page.getByRole('form', { name: 'Rename conversation' }).getByRole('button', { name: 'Save' }).click();
    await row(parityId()).locator('.thread-title').filter({ hasText: 'Renamed parity 4242' }).waitFor();
    assert.equal((await api(`/threads/${parityId()}?limit=1`)).body.thread.name, 'Renamed parity 4242');
    await rowMenu(parityId(), 'Rename');
    await page.getByLabel('Conversation name').fill('Discarded name 4242');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await wait(300);
    assert.equal((await api(`/threads/${parityId()}?limit=1`)).body.thread.name, 'Renamed parity 4242', 'cancel keeps the name');
  });

  await check('archive hides a chat; the Archived view restores it', async () => {
    await rowMenu(parityId(), 'Archive');
    await until(async () => await row(parityId()).count() === 0, 'row removed from sidebar');
    assert.equal((await api('/threads?limit=100')).body.data.some(t => t.id === parityId()), false, 'native list no longer has it');
    assert.equal((await api('/threads?limit=100&archived=true')).body.data.some(t => t.id === parityId()), true, 'native archive has it');
    await nav('Settings').click(); await page.getByRole('tab', { name: 'Archived chats' }).click();
    const archived = page.locator(`.archived-row[data-thread-id="${parityId()}"]`);
    await archived.waitFor();
    await shoot('archived');
    await archived.getByRole('button', { name: 'Unarchive Renamed parity 4242' }).click();
    await row(parityId()).waitFor();
    assert.equal((await api('/threads?limit=100')).body.data.some(t => t.id === parityId()), true, 'restored natively');
  });

  await check('theme follows Settings → Appearance: System, Light, Dark', async () => {
    await nav('Settings').click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    const group = page.getByRole('radiogroup', { name: 'Theme' });
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    await group.getByRole('radio', { name: 'Dark' }).click(); assert.equal(await isDark(), true);
    await group.getByRole('radio', { name: 'Light' }).click(); assert.equal(await isDark(), false);
    await group.getByRole('radio', { name: 'System' }).click();
    await page.emulateMedia({ colorScheme: 'dark' }); await until(isDark, 'system dark followed');
    await page.emulateMedia({ colorScheme: 'light' }); await until(async () => !(await isDark()), 'system light followed');
    await page.reload(); await page.getByText('Local workspace', { exact: true }).waitFor();
    await nav('Settings').click(); await page.getByRole('tab', { name: 'Appearance' }).click();
    assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'true', 'choice persists');
    await shoot('theme-settings');
  });

  await check('sidebar usage card names each provider state and never shows unreported use as 0%', async () => {
    const panel = page.locator('details.usage-panel');
    await panel.locator('summary').click();
    await panel.getByRole('region', { name: 'Claude usage' }).waitFor();
    const body = await panel.innerText();
    assert.match(body, /OpenAI \/ ChatGPT[\s\S]*Sign in with ChatGPT to see ChatGPT usage\./, 'signed-out ChatGPT says so');
    assert.match(body, /Claude[\s\S]*Sign in with Claude Code to see Claude usage\./);
    assert.match(body, /Gemini \(Antigravity\)[\s\S]*Sign in to Antigravity to see Gemini usage\./);
    assert.doesNotMatch(body, /\b0% used/, 'no invented zero');
    await shoot('usage-panel');
    await panel.locator('summary').click();
  });

  await check('header shows the Elpis mark', async () => {
    const mark = page.locator('.brand img[alt="Elpis"]');
    await mark.waitFor();
    assert(await mark.evaluate(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0), 'logo loaded');
    const icon = await page.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href'));
    assert.equal(String(icon), '/branding/favicon-amber.svg');
    await nav('New chat').click();
    await shoot('header-logo');
  });
  }
  assert.deepEqual(pageErrors, []);
} catch (error) {
  const caught = error instanceof Error ? error : new Error(String(error));
  results.push({ name: 'setup', ok: false, error: String(caught.stack || caught.message).split('\n').slice(0, 3).join(' | ') });
  console.log(`FAIL setup: ${caught.message}`);
} finally {
  await finishRun();
}
