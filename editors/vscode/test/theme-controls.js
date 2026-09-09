'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
async function themeControls({vscode, frame, page, evidence, eventually, screenshotsOnly = false}) {
  const config = vscode.workspace.getConfiguration('workbench');
  for (const [theme, kind, file] of [['Default Light Modern', vscode.ColorThemeKind.Light, 'light'], ['Default Dark Modern', vscode.ColorThemeKind.Dark, 'dark'], ['Default High Contrast', vscode.ColorThemeKind.HighContrast, 'high-contrast']]) {
    await config.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await eventually(() => vscode.window.activeColorTheme.kind === kind, `IDE theme ${theme}`);
    await eventually(async () => (await frame.evaluate('d.body.className')).includes(kind === vscode.ColorThemeKind.Light ? 'vscode-light' : kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' : 'vscode-high-contrast'), 'webview theme update');
    await frame.evaluate('d.getSelection()?.removeAllRanges(); true');
    await page.screenshot({path:path.join(process.env.ELPIS_EDITOR_TEST_DATA, `theme-${file}.png`), animations:'disabled'});
    const colors = await frame.evaluate(`(()=>{const w=d.defaultView; const body=w.getComputedStyle(d.body); const probe=d.createElement('span');d.body.appendChild(probe);probe.style.color='var(--vscode-editor-foreground)';const expectedText=w.getComputedStyle(probe).color;probe.style.color='var(--vscode-editor-background)';const expectedBackground=w.getComputedStyle(probe).color;probe.remove();return {text:body.color,background:body.backgroundColor,expectedText,expectedBackground,buttons:[...d.querySelectorAll('button')].map(b=>({id:b.id,text:w.getComputedStyle(b).color,background:w.getComputedStyle(b).backgroundColor}))};})()`);
    assert.equal(colors.text, colors.expectedText, `${theme}: body foreground must match IDE`);
    assert.equal(colors.background, colors.expectedBackground, `${theme}: body background must match IDE`);
    assert.notEqual(colors.text, colors.background);
    for (const button of colors.buttons) assert.notEqual(button.text, button.background, `${theme}: ${button.id} is invisible`);
    evidence.results.push({name:`IDE theme inheritance: ${theme}`,passed:true,colors});
  }
  await config.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  await eventually(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light, 'light theme restored');
  if (screenshotsOnly) {
    await page.setViewportSize({width:760, height:850});
    await eventually(async () => await frame.evaluate('d.defaultView.innerWidth < 500'), 'narrow chat viewport');
    const modelLabel = await frame.locator('#model').textContent();
    await frame.evaluate('d.getElementById("model").textContent = "private-organization/a-very-long-custom-model-identifier-for-layout-testing"; true');
    assert(await frame.evaluate('d.documentElement.scrollWidth <= d.defaultView.innerWidth'), 'chat overflows narrow viewport');
    assert(await frame.evaluate('d.getElementById("send").getBoundingClientRect().right <= d.defaultView.innerWidth'), 'Send falls outside narrow viewport');
    await frame.evaluate(`d.getElementById("model").textContent = ${JSON.stringify(modelLabel)}; true`);
    await page.screenshot({path:path.join(process.env.ELPIS_EDITOR_TEST_DATA, 'chat-narrow.png')});
    await page.setViewportSize({width:1280, height:900});
    evidence.results.push({name:'Narrow chat keeps composer and Send inside viewport without horizontal overflow',passed:true});
    return;
  }
  await frame.locator('#more').click();
  assert(await frame.evaluate('d.getElementById("settings").getClientRects().length > 0'));
  assert.equal(await frame.locator('#access').count(),0,'IDE access does not need a composer toggle');
  assert.equal(await frame.locator('#cancel').count(),0,'there must be no separate Stop button');
  assert.equal(await frame.evaluate('d.getElementById("send").getAttribute("aria-label")'),'Send message');
  evidence.results.push({name:'Composer has no IDE toggle or separate Stop button',passed:true});
  await frame.locator('#model').click();
  await eventually(async () => await frame.locator('[data-model="runtime-only-picker-sentinel"]').count(), 'in-composer runtime catalog');
  assert(await frame.evaluate('d.getElementById("model-menu").getBoundingClientRect().bottom <= d.getElementById("model").getBoundingClientRect().top'), 'model menu must open above composer');
  assert(await frame.evaluate('(()=>{const r=d.getElementById("model-menu").getBoundingClientRect();return r.left>=0 && r.right<=d.defaultView.innerWidth;})()'), 'model menu must stay inside the sidebar');
  await page.screenshot({path:path.join(process.env.ELPIS_EDITOR_TEST_DATA, 'composer-model-menu.png')});
  assert(await frame.evaluate('(()=>{d.querySelector("[data-model=runtime-only-picker-sentinel]").click();d.getElementById("prompt").value="MODEL_SWITCH_RACE_SENTINEL";d.getElementById("composer").dispatchEvent(new d.defaultView.Event("submit",{bubbles:true,cancelable:true}));return d.getElementById("send").disabled && d.getElementById("prompt").value==="MODEL_SWITCH_RACE_SENTINEL";})()'), 'selecting a model must immediately block Send and preserve the draft');
  await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model') === 'runtime-only-picker-sentinel', 'popover model persisted');
  await eventually(async()=>!(await frame.evaluate('d.getElementById("send").disabled')), 'model selection acknowledged before Send is enabled');
  await frame.locator('#prompt').fill('');
  await frame.locator('#model').click();
  await eventually(async () => await frame.evaluate('d.getElementById("effort").options.length > 1'), 'runtime reasoning capabilities');
  const effort = await frame.evaluate('d.getElementById("effort").options[1].value');
  await frame.evaluate(`(()=>{const e=d.getElementById('effort');e.value=${JSON.stringify(effort)};e.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));return true;})()`);
  await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('reasoningEffort') === effort, 'effort selection persisted');
  await frame.locator('#model').click();
  await frame.evaluate('d.getElementById("model-search").focus(); true');
  await page.keyboard.press('Escape');
  await eventually(async () => !await frame.evaluate('d.getElementById("model-picker").open'), 'Escape closes model menu');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model'), 'runtime-only-picker-sentinel');
  await frame.locator('#model').click();
  await frame.locator('#prompt').click();
  assert(!await frame.evaluate('d.getElementById("model-picker").open'), 'outside click closes menu');
  evidence.results.push({name:'Composer menu selects a runtime-only model and supported effort; Escape/outside cancellation preserves selection',passed:true});
  await frame.locator('#provider').click();
  const input = page.locator('.quick-input-widget input').first();
  await input.fill('Elpis configuration'); await input.press('Enter');
  await eventually(async () => (await page.locator('.quick-input-title').textContent()).includes('Elpis configuration model'), 'runtime model picker');
  await page.getByText('Runtime-only picker sentinel', {exact:true}).waitFor();
  await page.screenshot({path:path.join(process.env.ELPIS_EDITOR_TEST_DATA, 'model-picker.png')});
  await page.getByText('Runtime-only picker sentinel', {exact:true}).click();
  await eventually(async () => (await frame.locator('#model').textContent()).includes('Runtime-only picker sentinel'), 'runtime catalog selection reaches model label');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model'), 'runtime-only-picker-sentinel');
  evidence.results.push({name:'Model found only in real runtime catalog appears and persists through native picker',passed:true});
  const nativeModels = await require('../src/model-catalog').loadModels(vscode.workspace.workspaceFolders[0].uri.fsPath, {
    executable:process.env.ELPIS_EDITOR_TEST_RUNTIME,
    home:vscode.workspace.getConfiguration('elpis').get('home'), provider:'openai',
  });
  assert(nativeModels.length > 0);
  await frame.locator('#provider').click();
  await input.fill('OpenAI'); await input.press('Enter');
  await page.getByText(nativeModels[0].label, {exact:true}).click();
  await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('provider') === 'openai', 'OpenAI provider persisted');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model'), nativeModels[0].model);
  for (const value of ['SYNTHETIC_UI_KEY_72841', '']) {
    await frame.locator('#key').click();
    const password = page.locator('.quick-input-widget input[type="password"]');
    await password.fill(value); await password.press('Enter');
    await eventually(async () => (await frame.locator('#status').textContent()).includes('Authentication updated'), 'key operation completed');
    assert(!(await frame.evaluate('d.body.textContent')).includes('SYNTHETIC_UI_KEY_72841'), 'key leaked into webview');
  }
  await frame.locator('#provider').click(); await input.press('Escape');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('provider'), 'openai');
  const originalFetch = globalThis.fetch;
  const originalKeys = {ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY, GEMINI_API_KEY:process.env.GEMINI_API_KEY};
  process.env.ANTHROPIC_API_KEY = 'catalog-test-anthropic';
  process.env.GEMINI_API_KEY = 'catalog-test-gemini';
  const catalogRequests = [];
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).hostname;
    const fixture = {
      'openrouter.ai': {data:[{id:'vendor/router-catalog-sentinel',name:'Router catalog sentinel'}]},
      'api.anthropic.com': {data:[{id:'anthropic-catalog-sentinel',display_name:'Anthropic catalog sentinel'}],has_more:false},
      'generativelanguage.googleapis.com': {models:[{name:'models/gemini-catalog-sentinel',displayName:'Gemini catalog sentinel',supportedGenerationMethods:['generateContent']}]},
    }[host];
    if (!fixture) return originalFetch(url, options);
    catalogRequests.push(host);
    if (host === 'api.anthropic.com') assert.equal(options.headers['x-api-key'], 'catalog-test-anthropic');
    if (host === 'generativelanguage.googleapis.com') assert.equal(options.headers['x-goog-api-key'], 'catalog-test-gemini');
    return {ok:true,json:async()=>fixture};
  };
  try {
  for (const [provider, label, model] of [
    ['OpenRouter', 'Router catalog sentinel', 'vendor/router-catalog-sentinel'],
    ['Anthropic', 'Anthropic catalog sentinel', 'anthropic-catalog-sentinel'],
    ['Google Gemini', 'Gemini catalog sentinel', 'gemini-catalog-sentinel'],
  ]) {
    await frame.locator('#provider').click();
    await input.fill(provider); await input.press('Enter');
    await page.getByText(label, {exact:true}).click();
    await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model') === model, `${provider} chosen model persisted`);
  }
  await frame.locator('#provider').click();
  await input.fill('OpenAI'); await input.press('Enter');
  await page.getByText('Enter custom model ID…', {exact:true}).click();
  await eventually(async () => (await page.locator('.quick-input-title').textContent()).includes('custom model'), 'custom input opens');
  await input.fill('custom-private-model'); await input.press('Enter');
  await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model') === 'custom-private-model', 'custom model persisted');
  await frame.locator('#provider').click();
  await input.fill('Anthropic'); await input.press('Enter');
  await page.getByText('Anthropic catalog sentinel', {exact:true}).waitFor();
  await input.press('Escape');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('model'), 'custom-private-model');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('provider'), 'openai');
  assert.equal(new Set(catalogRequests).size, 3);
  evidence.results.push({name:'Provider catalog-only models, custom ID, and model-picker cancellation',passed:true});
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalKeys)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const settings = vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri);
  await settings.update('provider', '', vscode.ConfigurationTarget.WorkspaceFolder);
  await settings.update('model', '', vscode.ConfigurationTarget.WorkspaceFolder);
  evidence.results.push({name:'Real provider/model picker, cancellation, masked key store/remove and no webview key leak',passed:true});
  await vscode.workspace.getConfiguration('files').update('simpleDialog.enable', true, vscode.ConfigurationTarget.Global);
  await settings.update('executable', '__invalid_runtime_probe__', vscode.ConfigurationTarget.Global);
  await frame.locator('#runtime').click();
  await eventually(async () => (await page.locator('.quick-input-title').textContent()).includes('Select the Elpis-built'), 'file picker initialized');
  await input.fill(path.dirname(process.env.ELPIS_EDITOR_TEST_RUNTIME) + '/');
  await page.getByText(path.basename(process.env.ELPIS_EDITOR_TEST_RUNTIME), {exact:true}).dblclick();
  await eventually(() => vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('executable') === process.env.ELPIS_EDITOR_TEST_RUNTIME, 'runtime selected by file picker');
  await frame.locator('#runtime').click();
  await eventually(async () => (await page.locator('.quick-input-title').textContent()).includes('Select the Elpis-built'), 'second file picker initialized');
  await input.press('Escape');
  assert.equal(vscode.workspace.getConfiguration('elpis', vscode.workspace.workspaceFolders[0].uri).get('executable'), process.env.ELPIS_EDITOR_TEST_RUNTIME);
  evidence.results.push({name:'Runtime file picker selects executable; cancellation preserves it (VS Code simple file dialog)',passed:true});
  const previousEditor = vscode.window.activeTextEditor;
  await frame.locator('#open-config').click();
  await eventually(() => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(vscode.workspace.getConfiguration('elpis').get('home'), 'config.toml'), 'Open config uses configured Elpis home');
  assert(!vscode.window.activeTextEditor.document.isDirty);
  await frame.locator('#open-settings').click();
  await eventually(() => vscode.window.tabGroups.all.flatMap(g=>g.tabs).some(t=>t.label==='Elpis settings'), 'Elpis settings editor opens');
  let settingsFrame;
  await eventually(async()=>{settingsFrame ||= await require('./webview-cdp').WebviewDOM.connect(process.env.ELPIS_EDITOR_TEST_CDP,'[data-section="personalization"]');return settingsFrame && await settingsFrame.locator('[data-setting="sendShortcut"]').count();},'real settings preferences load');
  await settingsFrame.evaluate('(()=>{const e=d.querySelector("[data-setting=sendShortcut]");e.value="Ctrl+Enter";e.dispatchEvent(new d.defaultView.Event("change",{bubbles:true}));return true;})()');
  await eventually(()=>vscode.workspace.getConfiguration('elpis',vscode.workspace.workspaceFolders[0].uri).get('sendShortcut')==='Ctrl+Enter','settings page updates editor preference');
  await vscode.workspace.getConfiguration('elpis',vscode.workspace.workspaceFolders[0].uri).update('sendShortcut','Enter',vscode.ConfigurationTarget.WorkspaceFolder);
  await settingsFrame.locator('[data-section="configuration"]').click();
  await eventually(async()=>await settingsFrame.locator('[data-setting="web_search"]').count(),'runtime settings load');
  await settingsFrame.evaluate('(()=>{const e=d.querySelector("[data-setting=web_search]");e.value="disabled";e.dispatchEvent(new d.defaultView.Event("change",{bubbles:true}));return true;})()');
  await eventually(async()=>await settingsFrame.evaluate('d.querySelector("[data-setting=web_search]")?.value==="disabled" && !d.getElementById("notice").textContent.includes("Saving")'),'runtime setting saves and reads back');
  await page.screenshot({path:path.join(process.env.ELPIS_EDITOR_TEST_DATA,'settings.png')});
  settingsFrame.close();
  if(previousEditor) await vscode.window.showTextDocument(previousEditor.document);
  evidence.results.push({name:'Settings and config buttons open actual settings and the configured home without editing files',passed:true});
  await config.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
}
module.exports = {themeControls};
