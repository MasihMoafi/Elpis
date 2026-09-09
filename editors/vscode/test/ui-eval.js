'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { Provider, message, call } = require('./runtime-eval');
const { WebviewDOM } = require('./webview-cdp');

function output(request, id) {
  const item = request.input.find(item => item.call_id === id && item.type === 'function_call_output');
  assert(item, `Missing tool output ${id}`);
  const text = typeof item.output === 'string' ? item.output : item.output.map(part => part.text || '').join('');
  return JSON.parse(text);
}
async function uiEvaluation({ vscode, root, document, sentinel, evidence, eventually }) {
  const data = process.env.ELPIS_EDITOR_TEST_DATA;
  const home = await fs.mkdtemp(path.join(require('node:os').tmpdir(),'elpis-ui-home-'));
  await fs.writeFile(path.join(data,'ui-home-path.txt'),home);
  await fs.mkdir(home, { recursive: true });
  const catalog = JSON.parse(await fs.readFile(path.join(__dirname, '../../../codex-rs/models-manager/models.json'), 'utf8'));
  catalog.models.unshift({...catalog.models[0], slug:'runtime-only-picker-sentinel', display_name:'Runtime-only picker sentinel', visibility:'list'});
  const catalogPath = path.join(home, 'picker-catalog.json');
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const provider = new Provider(); await provider.start();
  await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "editor_eval"\n[model_providers.editor_eval]\nname = "Controlled editor UI provider"\nbase_url = ${JSON.stringify(provider.url)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const previousHome = process.env.CODEX_HOME;
  const configText = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
  // Keep context-size limits stable across fixture models.
  await fs.writeFile(path.join(home, 'config.toml'), `model_context_window = 128000\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n${configText}`);
  process.env.CODEX_HOME = home;
  await vscode.workspace.getConfiguration('elpis').update('executable', process.env.ELPIS_EDITOR_TEST_BUNDLED ? 'elpis-app-server' : process.env.ELPIS_EDITOR_TEST_RUNTIME, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('elpis').update('home', home, vscode.ConfigurationTarget.Global);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.ELPIS_EDITOR_TEST_CDP}`);
  let frame, page;
  try {
    await vscode.commands.executeCommand('elpis.chat');
    page = browser.contexts()[0].pages()[0];
    await eventually(async () => {
      frame ||= await WebviewDOM.connect(process.env.ELPIS_EDITOR_TEST_CDP);
      return frame && await frame.locator('#prompt').count();
    }, 'actual Elpis webview');
    await require('./theme-controls').themeControls({vscode, frame, page, evidence, eventually});
    assert.equal(await frame.locator('#slash-menu').count(),1,'composer exposes slash commands');
    await require('./ide-context-controls')({vscode,root,document,sentinel,home,eventually,evidence,provider,data});
    assert.equal(await frame.locator('#approval-mode').count(),1,'composer must expose working approval modes');
    assert.equal(await frame.locator('#approval-mode svg').count(),1,'Permissions use a shield icon');
    assert.equal(await frame.locator('#thinking svg').count(),1,'Thinking uses a brain icon');
    assert.equal(await frame.locator('#access').count(),0,'No IDE on/off button in the composer');
    async function selectMode(label,short) {
      await frame.pointerClick('#prompt');
      await frame.pointerClick('#approval-mode');
      assert.equal(await page.locator('.quick-input-widget').isVisible(),false,'Permissions stay in the composer');
      const mode={'Approve for me':'auto','Ask for approval':'ask','Full access':'full'}[label];
      await frame.locator(`[data-permission="${mode}"]`).click();
      await eventually(async()=>await frame.evaluate('d.getElementById("approval-mode").getAttribute("aria-label")')==='Permissions: '+short && !await frame.evaluate('d.getElementById("send").disabled'),'mode applied: '+short);
    }
    await selectMode('Approve for me','Auto');
    await selectMode('Ask for approval','Ask');
    await frame.pointerClick('#approval-mode');await page.keyboard.press('Escape');
    await eventually(async()=>!await frame.evaluate('d.getElementById("send").disabled'),'cancelled mode picker unlocks composer');
    assert.equal(await frame.evaluate('d.getElementById("approval-mode").getAttribute("aria-label")'),'Permissions: Ask');
    evidence.results.push({name:'Approval modes change before first message; cancelling selection preserves Ask',passed:true});
    // VS Code test mode suppresses native modal dialogs. Exercise both responses
    // through the real extension handler, and restore its API before other tests.
    const warningApi=require('node:module').createRequire(path.join(vscode.extensions.getExtension('elpis-local.elpis-editor').extensionPath,'src/extension.js'))('vscode').window;
    const previousWarning=warningApi.showWarningMessage;let fullAnswer,fullConfirmations=0;
    warningApi.showWarningMessage=async(text,options,...choices)=>{assert.match(text,/Allow full access/);assert.equal(options.modal,true);assert(choices.includes('Allow full access'));fullConfirmations++;return fullAnswer;};
    try {
      for(const [answer,expected] of [[undefined,'Ask'],['Allow full access','Full']]){
        fullAnswer=answer;const before=fullConfirmations;
        await frame.locator('#approval-mode').click();await frame.locator('[data-permission="full"]').click();
        await eventually(async()=>fullConfirmations>before && !await frame.evaluate('d.getElementById("send").disabled'),'Full access confirmation completes');
        assert.equal(await frame.evaluate('d.getElementById("approval-mode").getAttribute("aria-label")'),'Permissions: '+expected);
      }
      await page.screenshot({path:path.join(data,'full-access-selected.png'),animations:'disabled'});
    }finally{warningApi.showWarningMessage=previousWarning;}
    await selectMode('Ask for approval','Ask');
    evidence.results.push({name:'Full access requires affirmative confirmation; cancellation preserves Ask (native modal response substituted in test mode)',passed:true});
    await frame.locator('#model').click();
    await eventually(async()=>await frame.locator('[data-model="runtime-only-picker-sentinel"]').count(),'model repair catalog');
    await frame.locator('[data-model="runtime-only-picker-sentinel"]').click();
    await eventually(async()=>!(await frame.evaluate('d.getElementById("send").disabled')) && (await frame.locator('#model').textContent()).includes('sentinel'),'new model acknowledged');
    await frame.locator('#thinking').click();
    await eventually(async()=>await frame.locator('#effort option[value="high"]').count(),'advertised thinking levels appear in composer');
    assert.equal(await page.locator('.quick-input-widget').isVisible(),false,'Thinking stays in the composer');
    await page.screenshot({path:path.join(data,'thinking-menu.png'),animations:'disabled'});
    await frame.evaluate('(()=>{const select=d.getElementById("effort");select.value="high";return select.dispatchEvent(new d.defaultView.Event("change",{bubbles:true}));})()');
    await eventually(async()=>await frame.evaluate('d.getElementById("thinking").getAttribute("aria-label")')==='Thinking: high','visible thinking choice acknowledged');
    await page.screenshot({path:path.join(data,'model-thinking-selected.png'),animations:'disabled'});
    provider.actions.push(request=>{
      assert.equal(request.model,'runtime-only-picker-sentinel');
      assert.equal(request.reasoning.effort,'high');
      return message('MODEL_AND_THINKING_CONFIRMED');
    });
    await frame.locator('#prompt').fill('Verify selected model and thinking level.');await frame.locator('#send').click();
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('MODEL_AND_THINKING_CONFIRMED'),'selected model and thinking produce a reply');
    await eventually(async()=>(await frame.evaluate('d.getElementById("send").getAttribute("aria-label")'))==='Send message','selected-model turn finished');
    await frame.locator('#model').click();
    await eventually(async()=>(await frame.evaluate('d.querySelectorAll("[data-model]").length'))>2,'second model offered');
    const nextModel=await frame.evaluate('[...d.querySelectorAll("[data-model]")].find(x=>x.dataset.model && x.dataset.model!=="runtime-only-picker-sentinel").dataset.model');
    await frame.locator(`[data-model="${nextModel}"]`).click();
    await eventually(async()=>!(await frame.evaluate('d.getElementById("send").disabled')),'second model selected');
    assert((await frame.locator('#messages').textContent()).includes('MODEL_AND_THINKING_CONFIRMED'),'model switch must retain visible chat');
    provider.actions.push(request=>{
      assert.equal(request.model,nextModel);assert.equal(request.reasoning.effort,'high');
      assert(JSON.stringify(request.input).includes('MODEL_AND_THINKING_CONFIRMED'),'model switch must retain runtime conversation');
      return message('SWITCHED_MODEL_RETAINED_CONTEXT');
    });
    await frame.locator('#prompt').fill('Continue with the new model.');await frame.locator('#send').click();
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('SWITCHED_MODEL_RETAINED_CONTEXT'),'second model keeps chat context');
    await eventually(async()=>(await frame.evaluate('d.getElementById("send").getAttribute("aria-label")'))==='Send message','second model turn finished');
    provider.actions.push({httpError:'EVAL_USAGE_LIMIT_SENTINEL'});
    await frame.locator('#model').click();await eventually(async()=>await frame.locator('[data-model=""]').count(),'configured model option');
    await frame.locator('[data-model=""]').click();await eventually(async()=>!await frame.evaluate('d.getElementById("send").disabled'),'configured model selected');
    assert((await frame.locator('#messages').textContent()).includes('SWITCHED_MODEL_RETAINED_CONTEXT'),'configured model must retain the conversation');
    let modelChangeCompacted=false;
    const configuredReply=request=>{
      const input=JSON.stringify(request.input);assert(input.includes('SWITCHED_MODEL_RETAINED_CONTEXT'));
      // Different model compatibility hashes can require a summary on the old
      // model before the next request reaches the newly selected model.
      if(input.includes('CONTEXT CHECKPOINT COMPACTION')) {
        assert.equal(modelChangeCompacted,false,'model switch must not repeatedly compact');modelChangeCompacted=true;
        provider.actions.unshift(configuredReply);return message('Previous conversation result: SWITCHED_MODEL_RETAINED_CONTEXT. Continue with the configured model.');
      }
      assert.equal(request.model,'gpt-5.4');return message('CONFIGURED_MODEL_KEPT_CONTEXT');
    };
    provider.actions.unshift(configuredReply);
    await frame.locator('#prompt').fill('Continue using the configured model.');await frame.locator('#send').click();
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('CONFIGURED_MODEL_KEPT_CONTEXT'),'configured model reaches inference with earlier context');
    await eventually(async()=>await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'configured model completes');
    evidence.results.push({name:'Returning to the configured model preserves chat and sends the resolved model with prior context',passed:true});
    await frame.locator('#prompt').fill('Show the controlled provider failure.');await frame.locator('#send').click();
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('EVAL_USAGE_LIMIT_SENTINEL'),'provider failure rendered inside conversation');
    assert(await frame.evaluate('d.documentElement.scrollWidth <= d.defaultView.innerWidth+1'),'provider errors must not overflow the sidebar');
    await page.screenshot({path:path.join(data,'provider-failure.png'),animations:'disabled'});
    evidence.results.push({name:'Selected model and visible thinking reach real inference; provider failure appears in conversation',passed:true});
    const repairSettings=vscode.workspace.getConfiguration('elpis',vscode.workspace.workspaceFolders[0].uri);
    await repairSettings.update('model','',vscode.ConfigurationTarget.WorkspaceFolder);
    await repairSettings.update('reasoningEffort','',vscode.ConfigurationTarget.WorkspaceFolder);
    await frame.locator('#reconnect').click();
    await eventually(async () => (await frame.locator('#identity').textContent()).includes('gpt-5.4'), 'UI runtime identity');
    provider.actions.push({hang:true});
    await frame.locator('#prompt').fill('Cancellation control'); await frame.locator('#send').click();
    await eventually(() => provider.hanging.size > 0, 'active runtime request');
    assert.equal(await frame.evaluate('d.getElementById("send").getAttribute("aria-label")'),'Stop response');
    assert.equal(await frame.evaluate('!d.getElementById("send-stop").classList.contains("hidden") && d.getElementById("send-arrow").classList.contains("hidden")'),true);
    await page.screenshot({path:path.join(data,'send-stop-active.png'),animations:'disabled'});
    await frame.locator('#prompt').fill('Draft kept while stopping');
    await frame.locator('#send').click();
    await eventually(async () => /interrupted|cancelled/i.test(await frame.locator('#status').textContent()), 'active Cancel completes');
    assert.equal(await frame.evaluate('d.getElementById("send").getAttribute("aria-label")'),'Send message');
    assert.equal(await frame.evaluate('!d.getElementById("send-arrow").classList.contains("hidden") && d.getElementById("send-stop").classList.contains("hidden")'),true);
    assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'Draft kept while stopping');
    await page.screenshot({path:path.join(data,'send-stop-idle.png'),animations:'disabled'});
    await frame.locator('#prompt').fill('');
    await frame.locator('#reconnect').click();
    await eventually(async () => (await frame.locator('#identity').textContent()).includes('gpt-5.4'), 'reconnect after cancellation');
    evidence.results.push({name:'Active Cancel and New conversation buttons control real runtime',passed:true});
    await require('./followup-controls').followupControls({vscode,root,frame,page,provider,eventually,evidence,data});
    await require('./inline-approval-controls')({vscode,root,frame,page,provider,eventually,evidence,data});
    await frame.locator('#reconnect').click();
    await eventually(async () => (await frame.locator('#messages').textContent()).trim()==='', 'fresh conversation after follow-up evaluation');
    const uri = document.uri.toString();
    provider.actions.push(call('ui_read', 'editor_read', { uri }), request => {
      const read = output(request, 'ui_read');
      assert(read.text.includes(sentinel));
      return message(`The unsaved editor value is ${sentinel}.`);
    });
    await frame.locator('#prompt').fill('Read the unsaved editor value and report it.');
    await frame.locator('#send').click();
    await eventually(async () => (await frame.locator('#messages').textContent()).includes(sentinel), 'chat renders actual streamed tool-derived reply');
    await eventually(async () => (await frame.locator('#status').textContent()).includes('completed'), 'UI turn complete');
    evidence.results.push({ name: 'actual webview Send renders streamed unsaved fact from real Elpis tool roundtrip', passed: true });

    const original = document.getText();
    async function editTurn(decision) {
      provider.actions.push(call('ui_read_edit_' + decision, 'editor_read', { uri }), request => {
        const read = output(request, 'ui_read_edit_' + decision);
        return call('ui_propose_' + decision, 'editor_propose_edit', { uri, version: read.version, text: read.text.replace('result: number', 'result: string'), reason: 'greet returns string; match the result annotation.' });
      }, request => call('ui_apply_' + decision, 'editor_apply_edit', { proposalId: output(request, 'ui_propose_' + decision).proposalId }), request => {
        const applied = output(request, 'ui_apply_' + decision);
        assert.equal(applied.applied, decision !== 'Reject');
        return call('ui_diagnostics_' + decision, 'editor_diagnostics', { uri });
      }, () => message(`${decision} edit flow completed.`));
      await frame.locator('#prompt').fill('Fix the TypeScript assignment error using the editor approval flow.');
      await frame.locator('#send').click();
      if(decision!=='Auto') {
        await page.getByRole('button', { name: decision, exact: true }).waitFor({timeout:30000});
        await page.screenshot({path:path.join(data,`edit-${decision.toLowerCase()}-review.png`),animations:'disabled'});
        await page.getByRole('button', { name: decision, exact: true }).click({ timeout: 30000 });
      }
      await eventually(async () => (await frame.locator('#messages').textContent()).includes(`${decision} edit flow completed.`), 'approval result in chat');
      await eventually(async () => (await frame.locator('#status').textContent()).includes('completed'), 'edit turn completion');
    }
    await editTurn('Reject'); assert.equal(document.getText(), original);
    await editTurn('Apply'); assert(document.getText().includes('result: string'));
    await page.screenshot({path:path.join(data,'edit-applied.png'),animations:'disabled'});
    await eventually(() => !vscode.languages.getDiagnostics(document.uri).some(d => d.code === 2322), 'actual approved UI fix clears diagnostic');
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await page.locator('.editor-instance .monaco-editor').last().click({ position: { x: 220, y: 25 } });
    evidence.undoDebug = { before: document.version, active: vscode.window.activeTextEditor?.document.uri.toString(), focused: vscode.window.state.focused, domFocus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, cls: document.activeElement?.className })) };
    await page.keyboard.press('Control+z');
    evidence.undoDebug.after = document.version;
    await eventually(() => document.getText() === original, 'UI undo document update');
    evidence.results.push({ name: 'native diff and real Reject / Apply buttons gate edits; diagnostic clears and editor undo works', passed: true });
    await vscode.commands.executeCommand('elpis.chat');
    await selectMode('Approve for me','Auto');
    assert((await frame.locator('#messages').textContent()).includes('Apply edit flow completed.'),'changing permissions preserves visible conversation');
    const autoStart=provider.requests.length;
    await editTurn('Auto');
    assert(document.getText().includes('result: string'));
    assert(JSON.stringify(provider.requests[autoStart].body.input).includes('Apply edit flow completed.'),'changing permissions preserves runtime conversation');
    assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).count(),0,'Auto must not leave an approval prompt behind');
    await page.screenshot({path:path.join(data,'auto-edit-applied.png'),animations:'disabled'});
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await page.locator('.editor-instance .monaco-editor').last().click({position:{x:220,y:25}});await page.keyboard.press('Control+z');
    await eventually(()=>document.getText()===original,'Auto edit remains undoable');
    await vscode.commands.executeCommand('elpis.chat');await selectMode('Ask for approval','Ask');
    evidence.results.push({name:'Auto applies real runtime editor edits without a prompt, preserves conversation and supports undo; Ask restored',passed:true});
    await require('./message-controls').messageControls({vscode,frame,page,provider,eventually,evidence,data});
    await require('./ledger-controls')({vscode,document,frame,page,provider,eventually,evidence,data});
    await frame.locator('#more').click();
    await frame.locator('#history').click();
    await frame.locator('#history-search').fill('NO_MATCH_HISTORY_SENTINEL');
    await eventually(async () => (await frame.locator('#history-status').textContent()) === 'No matching chats', 'history negative search');
    await frame.locator('#history-search').fill('Read the unsaved editor value');
    await eventually(async () => await frame.locator('#history-list [data-thread]').count(), 'persisted chat search');
    await page.screenshot({path:path.join(data,'history.png')});
    const historyId = await frame.evaluate('d.querySelector("#history-list [data-thread]").dataset.thread');
    await frame.locator('#history-close').click();
    await frame.locator('#reconnect').click();
    await eventually(async () => (await frame.locator('#identity').textContent()).includes('gpt-5.4'), 'new conversation before resume');
    await eventually(async()=>!(await frame.locator('#messages').textContent()).includes(sentinel),'new chat must not display old transcript');
    await frame.locator('#history').click();
    await eventually(async () => await frame.locator(`[data-thread="${historyId}"]`).count(), 'chat survives app-server restart');
    await frame.locator(`[data-thread="${historyId}"]`).click();
    await eventually(async () => (await frame.locator('#status').textContent()).includes('Conversation resumed'), 'history resume');
    assert((await frame.locator('#messages').textContent()).includes(sentinel), 'resumed chat restores prior transcript');
    const resumeOnly = `RESUME_LIVE_${Date.now()}`;
    const liveEditor = await vscode.window.showTextDocument(document);
    assert(await liveEditor.edit(edit=>edit.insert(document.positionAt(document.getText().length), `\n// ${resumeOnly}\n`)));
    provider.actions.push(call('resume_read','editor_read',{uri}));
    provider.actions.push(request=>{ assert(output(request,'resume_read').text.includes(resumeOnly)); return message(`Resumed editor tools read ${resumeOnly}.`); });
    await frame.locator('#prompt').fill('Read the latest unsaved buffer after resuming.');
    await frame.locator('#send').click();
    await eventually(async () => (await frame.locator('#messages').textContent()).includes(resumeOnly), 'resumed runtime uses live editor tool');
    await eventually(async () => (await frame.locator('#status').textContent()).includes('completed'), 'resumed turn complete');
    evidence.results.push({name:'Searchable history survives runtime restart, restores transcript, and resumes live editor tools; unmatched search is empty',passed:true});
    const preferences=vscode.workspace.getConfiguration('elpis', root);
    await preferences.update('sendShortcut','Ctrl+Enter',vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>await frame.evaluate('d.getElementById("prompt").title.startsWith("Ctrl+Enter")'), 'send preference updates live');
    await require('./history-menu').historyMenu({frame,page,eventually,evidence,data,id:historyId,sentinel:resumeOnly});
    const beforeKeyboard = provider.requests.length;
    await frame.locator('#prompt').fill('Keyboard send check');
    await frame.pointerClick('#prompt');
    await page.keyboard.press('Enter');
    assert((await frame.evaluate('d.getElementById("prompt").value')).includes(String.fromCharCode(10)), 'Enter inserts a newline when Ctrl+Enter is selected');
    provider.actions.push(message('CTRL_ENTER_CONFIRMED'));
    await page.keyboard.press('Control+Enter');
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('CTRL_ENTER_CONFIRMED'), 'Ctrl+Enter sends');
    assert.equal(provider.requests.length,beforeKeyboard+1,'plain Enter must not send with Ctrl+Enter selected');
    await eventually(async()=>(await frame.locator('#status').textContent()).includes('completed'),'keyboard turn complete');
    await preferences.update('sendShortcut','Enter',vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>await frame.evaluate('d.getElementById("prompt").title.startsWith("Enter")'), 'Enter preference restored');
    await frame.locator('#prompt').fill('Multiline send check');
    await frame.pointerClick('#prompt');
    await page.keyboard.press('Shift+Enter');
    assert((await frame.evaluate('d.getElementById("prompt").value')).includes(String.fromCharCode(10)), 'Shift+Enter inserts a newline');
    provider.actions.push(message('ENTER_CONFIRMED'));
    await page.keyboard.press('Enter');
    await eventually(async()=>await frame.evaluate('[...d.querySelectorAll(".chat-bubble")].some(e=>e.textContent.trim() === "ENTER_CONFIRMED")'), 'Enter sends');
    assert.equal(provider.requests.length,beforeKeyboard+2,'Shift+Enter must not send');
    evidence.results.push({name:'Live send preference: Enter/Shift+Enter insert lines when appropriate; chosen shortcut sends exactly once',passed:true});
    await require('./theme-controls').themeControls({vscode, frame, page, evidence, eventually, screenshotsOnly:true});
    await require('./slash-controls')({vscode,root,frame,page,provider,eventually,evidence,data});
    await page.screenshot({ path: path.join(data, 'chat.png') });
    evidence.uiScreenshot = 'chat.png';

    if (process.env.ELPIS_EDITOR_TEST_LIVE === '1') {
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      await vscode.workspace.getConfiguration('elpis').update('home', '', vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('elpis').update('model', process.env.ELPIS_EDITOR_TEST_MODEL || 'gpt-5.4-mini', vscode.ConfigurationTarget.Global);
      await frame.locator('#reconnect').click();
      await eventually(async () => (await frame.locator('#status').textContent()).includes('model'), 'live runtime connected');
      await frame.locator('#prompt').fill(`Use editor_read to read ${uri}. Report only the unique comment value beginning UNSAVED_. Do not use shell or disk reads.`);
      await frame.locator('#send').click();
      await eventually(async () => {
        const status = await frame.locator('#status').textContent();
        if (status.includes('Turn failed') || status.includes('disconnected')) throw new Error(status);
        return (await frame.locator('#messages').textContent()).includes(sentinel);
      }, 'live-model UI response knows unsaved sentinel', 90000);
      await eventually(async () => (await frame.locator('#status').textContent()).includes('completed'), 'live UI turn complete', 90000);
      evidence.results.push({ name: 'live configured model conversation through actual chat UI reports unsaved sentinel', passed: true, identity: await frame.locator('#identity').textContent(), transcript: await frame.locator('#messages').textContent() });
      await page.screenshot({ path: path.join(data, 'live-chat.png') });
    }
  } catch (error) {
    evidence.uiFailure = { error: error.message, status: await frame?.locator('#status').textContent(), pages: browser.contexts().flatMap(c => c.pages().map(p => ({ url: p.url(), frames: p.frames().map(f => f.url()) }))) };
    const first = browser.contexts()[0]?.pages()[0];
    if (first) await first.screenshot({ path: path.join(data, 'ui-failure.png') });
    throw error;
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    frame?.close();
    await browser.close(); provider.close();
    await fs.writeFile(path.join(data, 'ui-provider-requests.json'), JSON.stringify(provider.requests, null, 2));
  }
}
module.exports = { uiEvaluation };
