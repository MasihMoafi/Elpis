const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

// A local MCP fixture validates the actual decoded capture, then returns a deterministic transcript.
// Speech recognition and inference are external boundaries; the recorder, HTTP/ffmpeg/MCP path and drawing are real.
const transcriber = `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(!m.id)return; let result={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'audio-check',version:'1'}};
  if(m.id===2){const a=m.params.arguments,b=Buffer.from(a.audio_base64,'base64');let start=12,peak=0;
    while(start+8<b.length&&b.toString('ascii',start,start+4)!=='data'){const size=b.readUInt32LE(start+4);start+=8+size+(size%2);}start+=8;
    for(let i=start;i+1<b.length;i+=2)peak=Math.max(peak,Math.abs(b.readInt16LE(i)));
    const ok=m.params.name==='transcribe_audio'&&a.refine_prompt===false&&b.toString('ascii',0,4)==='RIFF'&&b.length-start>3200&&peak>100;
    fs.appendFileSync(process.env.AUDIO_CHECK,JSON.stringify({bytes:b.length,peak,ok})+'\\n');
    result={content:[{type:'text',text:JSON.stringify({success:ok,text:fs.readFileSync(process.env.AUDIO_REPLY,'utf8')})}]};}
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`;

test('native Love Spot is one full drawing window: pages, green pen, captured voice note and Matilda answering', {
  skip: !process.env.ELPIS_PRIVATE_DISPLAY && 'Use ELPIS_PRIVATE_DISPLAY=1 xvfb-run -a -s "-screen 0 1600x1100x24"', timeout: 180000,
}, async () => {
  let config;
  const f = await loveSpotFixture({ configureClient: client => {
    client.transcriptionDefinition = async () => config;
    client.transcriptionEnvironment = async () => ({});
  } });
  let electron;
  try {
    const audio = path.join(f.root, 'capture.wav'), reply = path.join(f.root, 'reply.txt'), check = path.join(f.root, 'audio.jsonl');
    const wav = Buffer.alloc(44 + 32000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
    for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 10000), 44 + i * 2);
    await fs.writeFile(audio, wav); await fs.writeFile(reply, 'A captured voice note');
    config = { command: process.execPath, args: ['-e', transcriber], env: { WHISPERTYPE_BACKEND: 'local', AUDIO_CHECK: check, AUDIO_REPLY: reply } };
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audio}`,
      path.resolve(__dirname, 'session-windows-electron.cjs'), '--love-spot'],
    env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELPIS_HOME: f.root,
      SESSION_WINDOW_PROFILE: path.join(f.root, 'profile'), SESSION_WINDOW_URL: f.url } });
    const page = await electron.firstWindow(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try { await page.locator('.excalidraw canvas').first().waitFor(); }
    catch (cause) {
      await fs.mkdir(path.join(f.root, 'failure'), { recursive: true });
      await page.screenshot({ path: path.join(f.root, 'failure/native.png') });
      throw Error(`${cause.message}; url=${page.url()}; errors=${JSON.stringify(errors)}; body=${(await page.locator('body').innerText()).slice(0, 1200)}`);
    }
    assert.equal(await page.locator('.nav-list, .composer, .workspace-header').count(), 0);
    const box = await page.locator('.love-spot').boundingBox(), viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(box.width - viewport.width) <= 2 && box.height >= viewport.height - 38, JSON.stringify({ box, viewport }));
    {
      const bounds = await page.getByRole('group', { name: 'Voice note', exact: true }).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'voice fits inside the window');
    }
    await electron.evaluate(async () => { await Promise.all([global.sessionWindows.openLoveSpot(), global.sessionWindows.openLoveSpot()]); });
    assert.equal(electron.windows().length, 1, 'relaunch focuses the existing drawing');
    const pages = page.getByRole('button', { name: 'Pages', exact: true });
    await f.draw(page); await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'green drawing was not saved');
    assert.equal((await f.scene()).elements.find(e => !e.isDeleted).strokeColor, '#2f9e44');
    await pages.click(); await page.getByRole('menuitem', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.elements.length === 0, 'new page retained the old drawing');
    await pages.click(); await page.getByRole('menuitem', { name: 'Rename page', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page name', exact: true }).fill('Dock notes');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Dock notes', { exact: true }).waitFor();
    await pages.click(); await page.getByRole('menuitem', { name: /^Current page/ }).click();
    await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'switch did not restore the old drawing');
    await pages.click(); await page.getByRole('menuitem', { name: /^Dock notes/ }).click();
    await f.waitFor(s => s.elements.length === 0, 'switch did not restore the renamed page');
    const shots = process.env.LOVE_DOCK_SHOTS;
    if (shots) {
      await fs.mkdir(shots, { recursive: true });
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, colorScheme === 'dark');
        await pages.click(); await page.getByRole('menuitem', { name: 'New page', exact: true }).waitFor();
        const host = await electron.browserWindow(page);
        const picture = await host.evaluate(async host => (await host.webContents.capturePage()).toDataURL());
        await fs.writeFile(path.join(shots, `pages-${colorScheme}.png`), Buffer.from(picture.split(',')[1], 'base64'));
        await page.keyboard.press('Escape');
      }
    }
    const record = async control => {
      await control.getByRole('button', { name: 'Dictate message', exact: true }).click();
      await control.getByRole('button', { name: 'Stop recording and transcribe' }).waitFor();
      await page.waitForTimeout(700); await control.getByRole('button', { name: 'Stop recording and transcribe' }).click();
    };
    const note = page.getByRole('group', { name: 'Voice note', exact: true });
    await record(note);
    await f.waitFor(s => s.elements.some(e => e.text === 'A captured voice note'), 'captured audio did not reach the drawing', 15000);
    assert.equal((await f.scene()).elements.find(e => e.text === 'A captured voice note').strokeColor, '#2f9e44');
    await fs.writeFile(reply, ''); await record(note);
    await note.getByRole('status').filter({ hasText: 'No speech was recognized' }).waitFor();
    assert.equal((await f.scene()).elements.filter(e => !e.isDeleted && !e.id.startsWith('love-')).length, 1, 'empty recognition adds nothing');
    await fs.writeFile(reply, 'Speak to the agent'); await record(note);
    await f.waitFor(s => s.elements.some(e => e.text === 'Speak to the agent'), 'second captured note did not reach the drawing', 15000);
    await f.waitFor(s => s.elements.some(e => e.id.startsWith('love-reply-') && !e.isDeleted) && f.turns.some(turn => /Speak to the agent/.test(turn.text)), 'Matilda did not answer on the board', 20000);
    const captures = (await fs.readFile(check, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(captures.length, 3); assert.ok(captures.every(c => c.ok), JSON.stringify(captures));
    await electron.evaluate(async () => { await global.sessionWindows.open(); });
    assert.equal(electron.windows().length, 2, 'normal Elpis can coexist with the drawing');
    await page.close();
    await electron.evaluate(async () => { await Promise.all([global.sessionWindows.openLoveSpot(), global.sessionWindows.openLoveSpot()]); });
    assert.equal(electron.windows().length, 2, 'concurrent reopen creates only one Love Spot');
    const reopened = electron.windows().find(host => host.url().includes('/love-spot.html'));
    await reopened.locator('.excalidraw canvas').first().waitFor();
    await f.waitFor(s => s.elements.some(e => e.text === 'A captured voice note'), 'reopening lost the saved note');
    assert.deepEqual(errors, []);
  } finally { if (electron) await electron.close(); await f.close(); }
});
