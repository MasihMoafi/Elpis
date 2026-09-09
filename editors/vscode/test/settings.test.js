const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {readSettings,writeSetting}=require('../src/settings-data');

test('settings write reaches real config, redacts unrelated values and rejects a stale version',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-settings-'));
  const home=path.join(root,'home');await fs.mkdir(home);
  await fs.writeFile(path.join(home,'config.toml'),'model="gpt-5.4"\nweb_search="disabled"\n[model_providers.private]\nname="Private"\nbase_url="http://127.0.0.1:1"\nenv_key="SETTINGS_SECRET_SENTINEL"\n');
  const options={home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server')};
  try {
    const before=await readSettings(root,options,'configuration');
    assert.equal(before.values.web_search,'disabled');
    assert(!JSON.stringify(before).includes('SETTINGS_SECRET_SENTINEL'));
    await writeSetting(root,options,'web_search','live',before.version);
    const after=await readSettings(root,options,'configuration');
    assert.equal(after.values.web_search,'live');assert.notEqual(after.version,before.version);
    await assert.rejects(writeSetting(root,options,'web_search','disabled',before.version),/version|changed|conflict/i);
    assert.equal((await readSettings(root,options,'configuration')).values.web_search,'live');
    await assert.rejects(writeSetting(root,options,'unapproved.key','value',after.version),/cannot be changed/);
    await assert.rejects(writeSetting(root,options,'web_search','invented',after.version),/Invalid/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
