'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {message,call}=require('./runtime-eval');

module.exports=async function sharedUI({root,home,provider,frame,page,document,sentinel,evidence,eventually,data}) {
  const executable=process.env.ELPIS_IDE_TEST_CLI;
  assert(executable,'Shared UI acceptance requires the real Elpis CLI');
  await frame.locator('#reconnect').click();
  await eventually(async()=>(await frame.locator('#identity').textContent()).includes('editor_eval'),'reconnect after selecting the isolated test home');
  provider.actions.push(message('SHARED_UI_INITIAL'));
  await frame.locator('#prompt').fill('Initialize simultaneous CLI and IDE acceptance');
  await frame.locator('#send').click();
  await eventually(async()=>(await frame.locator('#status').textContent()).includes('completed'),'initial IDE turn completes');
  const options={home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME};
  const history=await require('../src/history').listHistory(root.fsPath,options);
  assert.equal(history.threads.length,1);
  const threadId=history.threads[0].id;
  const cli=require('./shared-cli')({executable,root:root.fsPath,home,threadId,socket:path.join(home,'app-server-control','app-server-control.sock')});
  try {
    await eventually(async()=>cli.text().includes('SHARED_UI_INITIAL'),'native terminal resumes IDE history');
    provider.actions.push({hang:true});
    await cli.send('SHARED_NATIVE_USER');
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('SHARED_NATIVE_USER'),'IDE renders terminal user message');
    await eventually(async()=>frame.evaluate('!d.getElementById("send-stop").classList.contains("hidden")'),'IDE observes active terminal turn');
    await frame.locator('#send').click();
    await eventually(async()=>(await frame.locator('#status').textContent()).includes('interrupted'),'IDE interrupts terminal turn');
    provider.actions.push(call('shared_live_read','editor_read',{uri:document.uri.toString()}),request=>{
      assert(JSON.stringify(request.input).includes(sentinel),'terminal-origin tool request reaches actual unsaved editor');
      return message('SHARED_NATIVE_TOOL_REPLY');
    });
    await cli.send('Read the shared live editor');
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('SHARED_NATIVE_TOOL_REPLY'),'IDE renders terminal-origin response');
    await eventually(async()=>cli.text().includes('SHARED_NATIVE_TOOL_REPLY'),'terminal renders editor tool response');
    await eventually(async()=>(await frame.locator('#status').textContent()).includes('completed'),'shared editor tool turn completes');
    provider.actions.push(message('SHARED_IDE_REPLY'));
    await frame.locator('#prompt').fill('IDE follow-up while the terminal remains open');
    await frame.locator('#send').click();
    await eventually(async()=>cli.text().includes('SHARED_IDE_REPLY'),'terminal renders IDE-origin response');
    await eventually(async()=>(await frame.locator('#status').textContent()).includes('completed'),'IDE follow-up completes');
    const transcript=await frame.locator('#messages').textContent();
    assert.equal(transcript.split('SHARED_NATIVE_USER').length-1,1);
    assert.equal(transcript.split('IDE follow-up while the terminal remains open').length-1,1);
    const saved=await require('../src/history').readHistory(root.fsPath,options,threadId);
    assert(JSON.stringify(saved).includes('SHARED_NATIVE_TOOL_REPLY'));
    assert(JSON.stringify(saved).includes('SHARED_IDE_REPLY'));
    await page.screenshot({path:path.join(data,'simultaneous-cli-ide.png')});
    evidence.results.push({name:'Actual terminal and VS Code share history, busy state, interruption, unsaved editor tools and messages in both directions',passed:true,threadId});
  } finally {await cli.dispose();}
};
