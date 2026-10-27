const { openSettings } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
// Settings pages share one control height and fit the pane: wide and narrow, light and dark. Local mock adapter; no model calls.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const PAGES=['General','Notifications','Appearance','Keyboard shortcuts','Voice','Personalization','Usage & limits','Archived chats','Models & accounts','MCP servers','Browser','Git','Worktrees','Hooks','Configuration','About'];
const options={defaultPermissions:'ask',webSearch:null,verbosity:null,reasoningSummary:null,serviceTier:null,developerInstructions:null,projectRootMarkers:null,worktreeRoot:null};
const settings=()=>({version:'v1',main:{model:'main-model',provider:'openai'},background:{model:null,provider:null},providers:[{id:'openai',displayName:'OpenAI'}],smartPrune:{enabled:true,explicitOverride:{available:true,model:null,provider:null,version:'p1'}},memory:{enabled:false,generate:null,use:null,skipExternalContext:null,extractionModel:null,consolidationModel:null},options,managed:{allowedApprovalPolicies:null,allowedSandboxModes:['read-only','workspace-write']},write:{available:true,reason:'Applies to new conversations.'}});
const hooks={version:'h1',write:{available:true},warnings:[],errors:[],hooks:[{key:'k',event:'preToolUse',handler:'command',command:'rtk hook claude',matcher:'^Bash$',timeoutSec:5,source:'user',sourcePath:'/home/person/.elpis-next/hooks.json',pluginId:null,enabled:true,managed:false,trust:'untrusted'}]};
const mcp={version:'m1',configPath:'/home/person/.elpis-next/config.toml',write:{available:true},servers:[{name:'whispertype',enabled:true,transport:'stdio',command:'whispertype-mcp',url:null,credentials:[],whispertype:{backend:'openrouter',model:null}}]};

test('settings controls share one height and no page overflows, wide or narrow, light or dark', async () => {
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://l');let raw='';for await(const c of req)raw+=c;
const json=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v))};
if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');return}
if(url.pathname==='/api/health')return json({connected:true});
if(url.pathname==='/api/love-spot/companion')return json({pinned:false,favorite:null,music:null,reason:''});
if(url.pathname==='/api/models')return json({data:[{id:'main-model',model:'main-model',displayName:'Main model'}]});
if(url.pathname==='/api/threads')return json({data:[],nextCursor:null});
if(url.pathname==='/api/settings')return json(settings());
if(url.pathname==='/api/mcp')return json(mcp);
if(url.pathname==='/api/tools/transcription')return json({available:true,backend:'openrouter',label:'OpenRouter'});
if(url.pathname==='/api/hooks')return json(hooks);
if(url.pathname==='/api/providers')return json({openai:{auth:{state:'signedOut'},usage:[],usageError:null},claude:{state:'notConnected',models:[],usage:[]},gemini:{state:'notConnected',models:[],usage:[]},openrouter:[],local:[]});
if(url.pathname==='/api/providers/settings')return json({version:'p',configPath:null,write:{available:true},managed:{modelProvider:null},providers:[]});
try{const f=path.join(__dirname,'..','out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(f))}catch{res.statusCode=404;res.end()}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  try {
    for (const [width, height, native] of [[1280, 900, true], [390, 844, true], [390, 844, false]]) for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' }); page.setDefaultTimeout(7000);
      if (native) await page.addInitScript(fakeDesktop);
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      if (!await page.locator('aside.sidebar').isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await openSettings(page);
      await page.evaluate(on => document.documentElement.classList.toggle('dark', on), dark);
      for (const name of PAGES) {
        await page.getByRole('tab', { name, exact: true }).click(); await page.waitForTimeout(250);
        const found = await page.evaluate(() => {
          const pane = document.querySelector('.settings-page').getBoundingClientRect();
          const heights = [...document.querySelectorAll('.settings-page [data-slot="input"], .settings-page [data-slot="select-trigger"], .settings-page .search-field, .settings-page [data-slot="button"]:not([class~="size-6"], [class~="size-7"], [class~="size-8"], [class~="size-9"], .h-auto, .segmented > *)')]
            .filter(el => el.getBoundingClientRect().width > 20).map(el => Math.round(el.getBoundingClientRect().height));
          const clipped = [...document.querySelectorAll('.settings-page button, .settings-page input:not([type=checkbox]), .settings-page [role=combobox]')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().right > pane.right + 1).length;
          return { heights, clipped, scrolls: document.documentElement.scrollWidth > innerWidth + 1, paneWidth: pane.width };
        });
        const where = `${name} at ${width}px ${dark ? 'dark' : 'light'}`;
        assert.deepEqual([...new Set(found.heights)], found.heights.length ? [32] : [], `${where}: control heights ${found.heights}`);
        assert.equal(found.clipped, 0, `${where}: clipped controls`);
        assert.equal(found.scrolls, false, `${where}: horizontal scroll`);
        assert.ok(found.paneWidth > width * 0.7, `${where}: page is squeezed to ${found.paneWidth}px`);
      }
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
});

test('desktop settings navigation fits without scrolling and retains a short-window fallback', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  for (const [width, height] of [[2048, 1159], [1280, 900], [1280, 760]]) {
    const f = await fixture({ width, height });
    try {
      const { page } = f; await openSettings(page);
      const nav = page.getByRole('navigation', { name: 'Settings navigation' });
      const geometry = await nav.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll('[role="tab"], .back-link, input')];
        return { client: element.clientHeight, scroll: element.scrollHeight, controls: controls.map(node => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top - bounds.top, bottom: bounds.bottom - rect.bottom, font: parseFloat(getComputedStyle(node).fontSize) };
        }) };
      });
      assert.equal(await nav.getByRole('tab').count(), 17);
      assert.equal(await nav.getByRole('button', { name: 'Back to app' }).count(), 1);
      assert.equal(await nav.getByLabel('Search settings', { exact: true }).count(), 1);
      assert.ok(geometry.scroll <= geometry.client + 1, `${width}×${height}: navigation scrolls (${geometry.scroll} > ${geometry.client})`);
      assert.ok(geometry.controls.every(item => item.top >= -1 && item.bottom >= -1 && item.font >= 12), `${width}×${height}: controls must fit and remain legible`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
  const short = await fixture({ width: 1280, height: 540 });
  try {
    await openSettings(short.page);
    const nav = short.page.getByRole('navigation', { name: 'Settings navigation' });
    const result = await nav.evaluate(element => { element.scrollTop = element.scrollHeight; return { overflow: element.scrollHeight > element.clientHeight, bottom: element.scrollTop + element.clientHeight, total: element.scrollHeight }; });
    assert.ok(result.overflow && result.bottom >= result.total - 1, 'short windows retain reachable navigation via scrolling');
    await nav.getByRole('tab', { name: 'About', exact: true }).click();
    assert.deepEqual(short.errors, []);
  } finally { await short.close(); }
});
