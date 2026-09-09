'use strict';
const assert=require('node:assert/strict');const path=require('node:path');
async function historyMenu({frame,page,eventually,evidence,data,id,sentinel}) {
  await frame.locator('#history').click();await frame.locator('#history-search').fill('');
  const row=`[data-thread="${id}"]`,actions=`[data-history-actions="${id}"]`;
  await eventually(async()=>await frame.locator(row).count(),'history action target');
  async function choose(label) {
    await frame.locator(actions).click();const input=page.locator('.quick-input-widget input');await input.waitFor();await input.fill(label);await page.getByText(label,{exact:true}).last().waitFor();await input.press('Enter');
  }
  await choose('Rename chat');
  await eventually(async()=>await page.getByText('Conversation name',{exact:true}).count(),'rename input opens');
  const input=page.locator('.quick-input-widget input');await input.fill('Renamed editor conversation');await input.press('Enter');
  await eventually(async()=>await frame.locator(row).textContent()==='Renamed editor conversation','renamed title appears');
  await choose('Archive chat');await eventually(async()=>!await frame.locator(row).count(),'archived chat leaves active list');
  await frame.locator('#history-archived').click();await eventually(async()=>await frame.locator(row).count(),'archived chat appears in archive');
  await page.screenshot({path:path.join(data,'archived-history.png'),animations:'disabled'});
  await choose('Restore chat');await eventually(async()=>!await frame.locator(row).count(),'restored chat leaves archive');
  await frame.locator('#history-archived').click();await eventually(async()=>await frame.locator(row).count(),'restored chat returns to active list');
  await frame.locator(row).click();await eventually(async()=>(await frame.locator('#status').textContent()).includes('Conversation resumed'),'restored chat resumes');
  assert((await frame.locator('#messages').textContent()).includes(sentinel),'archive/restore must preserve the conversation');
  evidence.results.push({name:'Visible history menu renames, archives, restores and resumes the same conversation without losing its transcript',passed:true});
}
module.exports={historyMenu};
