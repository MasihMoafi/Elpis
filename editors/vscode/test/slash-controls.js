const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs/promises');
const {execFile}=require('node:child_process');const run=require('node:util').promisify(execFile);
const {message}=require('./runtime-eval');const {WebviewDOM}=require('./webview-cdp');
module.exports=async({vscode,root,frame,page,provider,eventually,evidence,data})=>{
 const input={fill:async value=>{await frame.pointerClick('#prompt');await frame.locator('#prompt').fill(value);}};await input.fill('/');
 await eventually(async()=>await frame.locator('[data-slash="model"]').count(),'slash menu visible');
 assert.equal(await frame.evaluate('d.querySelectorAll("[data-slash]").length'),15);
 await page.screenshot({path:path.join(data,'slash-menu.png'),animations:'disabled'});
 await page.keyboard.press('ArrowDown');assert.equal(await frame.evaluate('d.querySelector("[data-slash=permissions]").getAttribute("aria-selected")'),'true');
 await page.keyboard.press('Escape');assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'/');assert(await frame.evaluate('d.getElementById("slash-menu").classList.contains("hidden")'));
 await input.fill('/mod');await page.keyboard.press('Tab');assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'/model');await page.keyboard.press('Enter');
 await eventually(async()=>await frame.evaluate('d.getElementById("model-picker").open'),'slash model opens composer picker');await frame.locator('#model').click();
 await input.fill('/permissions');await frame.locator('[data-slash=permissions]').click();assert(await frame.evaluate('d.getElementById("permissions-picker").open'));await frame.locator('#approval-mode').click();
 const before=provider.requests.length;await input.fill('/unknown-command');await page.keyboard.press('Enter');
 assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'/unknown-command');assert.equal(provider.requests.length,before);
 assert((await frame.locator('#status').textContent()).includes('Unknown command'));
 await input.fill('ordinary /model text');provider.actions.push(request=>{assert(JSON.stringify(request.input).includes('ordinary /model text'));return message('SLASH_ORDINARY_OK');});await page.keyboard.press('Enter');
 await eventually(async()=>!await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Stop response"')&&(await frame.locator('#messages').textContent()).includes('SLASH_ORDINARY_OK'),'ordinary message still sends');
 await input.fill('/copy');await page.keyboard.press('Enter');await eventually(async()=>(await vscode.env.clipboard.readText()).includes('SLASH_ORDINARY_OK'),'slash copy actual clipboard');
 for(const [command,title] of [['settings','General'],['mcp','MCP servers'],['hooks','Hooks'],['plugins','Plugins'],['usage','Usage & billing']]){
  await frame.pointerClick('#prompt');await input.fill('/'+command);await page.keyboard.press('Enter');let settings;
  await eventually(async()=>{settings=await WebviewDOM.connect(Number(process.env.ELPIS_EDITOR_TEST_CDP),'[data-section="personalization"]');if(!settings)return false;const match=await settings.locator('#title').textContent()===title;settings.close();return match;},'slash settings section '+command);
 }
 await frame.pointerClick('#prompt');await input.fill('/resume');await page.keyboard.press('Enter');assert(await frame.evaluate('!d.getElementById("history-panel").classList.contains("hidden")'));await frame.locator('#history-close').click();
 const compactBefore=provider.requests.length;provider.actions.push(message('SLASH_COMPACT_SUMMARY'));
 await input.fill('/compact');await page.keyboard.press('Enter');await eventually(async()=>provider.requests.length>compactBefore&&await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'slash compact finishes');
 // Give review/start a real, isolated repository with a known changed file.
 await run('git',['init','-q'],{cwd:root.fsPath});await fs.writeFile(path.join(root.fsPath,'review-marker.txt'),'before\n');await run('git',['add','review-marker.txt'],{cwd:root.fsPath});await run('git',['-c','user.name=Elpis eval','-c','user.email=eval@localhost','commit','-qm','Review fixture'],{cwd:root.fsPath});await fs.writeFile(path.join(root.fsPath,'review-marker.txt'),'after\n');
 let reviewed=false;provider.actions.push(request=>{assert(/review/i.test(JSON.stringify(request.input)));reviewed=true;return message(JSON.stringify({findings:[],overall_correctness:'patch is correct',overall_explanation:'SLASH_REVIEW_RESULT',overall_confidence_score:1}));});
 await input.fill('/review');await page.keyboard.press('Enter');await eventually(async()=>reviewed&&await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'slash review actual runtime');
 assert((await frame.locator('#messages').textContent()).includes('SLASH_REVIEW_RESULT'));
 assert(await frame.evaluate('[...d.querySelectorAll(".chat-bubble")].some(b=>b.textContent.includes("SLASH_REVIEW_RESULT")&&!b.textContent.includes("SLASH_ORDINARY_OK"))'),'review has its own response');
 await input.fill('/new');await page.keyboard.press('Enter');await eventually(async()=>await frame.evaluate('d.getElementById("messages").textContent.trim()===""&&d.getElementById("status").textContent.startsWith("Elpis ·")'),'slash new clears conversation and reconnects');
 const noCompact=provider.requests.length;await input.fill('/compact');await page.keyboard.press('Enter');await eventually(async()=>(await frame.locator('#status').textContent()).includes('Start a conversation'),'empty compact rejected');assert.equal(provider.requests.length,noCompact);assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'/compact');await input.fill('');
 provider.actions.push({hang:true});await input.fill('Busy slash command guard');await page.keyboard.press('Enter');await eventually(async()=>await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Stop response"'),'busy slash guard turn');const busyRequests=provider.requests.length;
 await input.fill('/new');await page.keyboard.press('Enter');assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'/new');assert.equal(provider.requests.length,busyRequests);assert((await frame.locator('#status').textContent()).includes('Finish or stop'));
 await frame.locator('#send').click();await eventually(async()=>await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'stop after guarded slash');await input.fill('');
 evidence.results.push({name:'Composer slash menu: filtering, keyboard/mouse, Escape, unknown/busy/draft protection, model/permissions/history/settings/copy, real compact/review/new',passed:true});
};
