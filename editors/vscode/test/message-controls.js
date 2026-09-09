'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {message}=require('./runtime-eval');
async function messageControls({vscode,frame,page,provider,eventually,evidence,data}) {
  const code='const answer = "ELPIS_CODE_SENTINEL";\n';
  provider.actions.push(message('**Formatted response**\n\n```js\n'+code+'```\n\n<script>window.elpisUnsafe=true</script>\n\n[Unsafe link](javascript:alert(1))'));
  await frame.locator('#prompt').fill('Render the message formatting fixture.');await frame.locator('#send').click();
  await eventually(async()=>(await frame.locator('#status').textContent()).includes('completed'),'formatted response completes');
  assert.equal(await frame.evaluate('!![...d.querySelectorAll(".chat-bubble strong")].find(e=>e.textContent==="Formatted response")'),true,'assistant markdown must render');
  assert.equal(await frame.evaluate('d.querySelector(".chat-bubble pre code")?.textContent'),code);
  assert.equal(await frame.evaluate('!!d.defaultView.elpisUnsafe || !!d.querySelector(".chat-bubble script") || !!d.querySelector(".chat-bubble a[href^=javascript]")'),false);
  const previous=await vscode.env.clipboard.readText();
  try {
    await frame.locator('[data-copy-code]').click();await eventually(async()=>await vscode.env.clipboard.readText()===code,'code copy reaches system clipboard');
  }finally{await vscode.env.clipboard.writeText(previous);}
  await page.screenshot({path:path.join(data,'formatted-response.png'),animations:'disabled'});
  assert.equal(await frame.evaluate('d.querySelector("details[data-tool=editor_read]").open'),false);
  await frame.locator('details[data-tool=editor_read] summary').click();
  assert.equal(await frame.evaluate('d.querySelector("details[data-tool=editor_read]").open && d.querySelector("details[data-tool=editor_read] pre").textContent.includes("UNSAVED_")'),true,'tool details expose the actual unsaved read');
  evidence.results.push({name:'Assistant markdown and code render, code copies exactly, model HTML and unsafe links stay inert',passed:true});
}
module.exports={messageControls};
