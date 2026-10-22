// Customize, based on Claude's Customize page: Skills, Plugins and Connectors, each a list of yours. A skill turns on and
// off; Create skill starts a chat that makes one; Manage connectors opens the MCP servers settings. Local bridge
// fixture (tests/parity-fixture.cjs); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const skill = (name, scope, enabled, extra = {}) => ({ id: name, name, description: `Does ${name}`, path: `/home/u/.elpis-next/skills/${name}/SKILL.md`, scope, enabled, plugin: null, ...extra });
function state() {
  const skills = [skill('pdf', 'system', true), skill('web-dev', 'user', true)];
  const plugins = [{ id: 'docs@local', name: 'Docs', description: 'Writes docs', marketplace: 'My plugins', enabled: true }];
  const connectors = [{ name: 'rag', enabled: true, transport: 'stdio' }, { name: 'web', enabled: false, transport: 'http' }];
  return {
    skills, plugins, connectors, writes: [],
    reply: () => ({ skills: { data: skills.map(item => ({ ...item })), errors: [{ path: '/home/u/.elpis-next/skills/bad/SKILL.md', message: 'missing name' }] },
      plugins: { version: 'user-v1', write: { available: true }, data: plugins.map(item => ({ ...item })) },
      connectors: { version: 'user-v1', write: { available: true }, data: connectors.map(item => ({ ...item })) } }),
  };
}

test('Customize lists skills, plugins and connectors; a skill switches off; Create skill and Manage connectors go where they say', async () => {
  const s = state();
  const f = await fixture({ routes: {
    '/api/customize': () => s.reply(),
    '/api/customize/skill': body => { s.writes.push(body); s.skills.find(item => item.path === body.path).enabled = body.enabled; return s.reply(); },
    '/api/customize/plugin': body => { s.plugins.find(item => item.id === body.id).enabled = body.enabled; return s.reply(); },
    '/api/mcp': body => { if (body) s.connectors.find(item => item.name === body.name).enabled = body.enabled; return {}; },
  } });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    const view = page.getByLabel('Customize', { exact: true }).first();
    const sections = page.getByRole('radiogroup', { name: 'Customize', exact: true });
    assert.equal(await sections.getByRole('radio', { name: 'Skills', exact: true }).getAttribute('aria-checked'), 'true');
    const skills = page.getByRole('region', { name: 'Your skills', exact: true });
    await skills.getByText('web-dev', { exact: true }).waitFor();
    assert.deepEqual(await skills.locator('.customize-name').allInnerTexts(), ['pdf', 'web-dev']);
    assert.deepEqual(await skills.locator('.customize-badge').allInnerTexts(), ['Built in', 'Yours']);
    assert.match(await skills.locator('.customize-errors summary').innerText(), /1 skill could not be read/);
    // Off, and the engine is told.
    const pdf = skills.getByRole('switch', { name: 'Use pdf', exact: true });
    assert.equal(await pdf.getAttribute('aria-checked'), 'true');
    await pdf.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Use pdf"]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(s.writes.map(({ path, enabled }) => [path, enabled]), [['/home/u/.elpis-next/skills/pdf/SKILL.md', false]]);
    // Plugins and connectors.
    await sections.getByRole('radio', { name: 'Plugins', exact: true }).click();
    const plugins = page.getByRole('region', { name: 'Your plugins', exact: true });
    assert.deepEqual(await plugins.locator('.customize-name').allInnerTexts(), ['Docs']);
    assert.deepEqual(await plugins.locator('.customize-description').allInnerTexts(), ['Writes docs']);
    assert.deepEqual(await plugins.locator('.customize-badge').allInnerTexts(), ['My plugins']);
    const plugin = plugins.getByRole('switch', { name: 'Use Docs', exact: true });
    assert.equal(await plugin.getAttribute('aria-checked'), 'true');
    for (const enabled of [false, true]) {
      await plugin.click();
      await page.waitForFunction(value => document.querySelector('[aria-label="Use Docs"]')?.getAttribute('aria-checked') === String(value), enabled);
      assert.equal(s.plugins[0].enabled, enabled);
    }
    assert.deepEqual(f.posts.filter(post => post.path === '/api/customize/plugin').map(post => post.body), [false, true].map(enabled => ({ action: 'enable', id: 'docs@local', enabled, version: 'user-v1' })));
    await sections.getByRole('radio', { name: 'Connectors', exact: true }).click();
    const connectors = page.getByRole('region', { name: 'Your connectors', exact: true });
    assert.deepEqual(await connectors.locator('.customize-name').allInnerTexts(), ['rag', 'web']);
    assert.deepEqual(await connectors.getByRole('switch').evaluateAll(items => items.map(item => item.getAttribute('aria-checked'))), ['true', 'false']);
    const rag = connectors.getByRole('switch', { name: 'Use rag', exact: true });
    for (const enabled of [false, true]) {
      await rag.click();
      await page.waitForFunction(value => document.querySelector('[aria-label="Use rag"]')?.getAttribute('aria-checked') === String(value), enabled);
      assert.equal(s.connectors[0].enabled, enabled);
      assert.equal(await connectors.getByRole('switch', { name: 'Use web', exact: true }).getAttribute('aria-checked'), 'false');
    }
    assert.deepEqual(f.posts.filter(post => post.path === '/api/mcp').map(post => post.body), [false, true].map(enabled => ({ action: 'enable', name: 'rag', enabled, version: 'user-v1' })));
    await connectors.getByRole('button', { name: 'Manage connectors', exact: true }).click();
    await page.getByRole('heading', { name: 'MCP servers' }).first().waitFor();
    assert.equal(await page.getByText('This page could not be shown', { exact: false }).count(), 0, 'the MCP page reads a reply without servers as none');
    // Create skill: a new chat asks Elpis's skill creator for one.
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('region', { name: 'Your skills', exact: true }).getByRole('button', { name: 'Create skill', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Elpis"]')?.value?.startsWith('Use $skill-creator to create a new skill that '));
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('region', { name: 'Your skills', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.nav-list button[aria-current="page"]').allInnerTexts(), ['Customize'], 'only Customize is the current page');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.new-chat')).backgroundColor === 'rgba(0, 0, 0, 0)', null, { timeout: 2000 });
    if (process.env.ELPIS_SHOTS) { await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click(); await page.getByRole('region', { name: 'Your skills' }).waitFor(); await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/customize.png` }); }
    assert.ok(view);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a skill switch flips as it is pressed while the engine still answers, and goes back with the reason when the change is refused', async () => {
  const s = state(); let release; const held = new Promise(resolve => { release = resolve; }); let refuse = true;
  const f = await fixture({ routes: {
    '/api/customize': () => s.reply(),
    '/api/customize/skill': async body => { await held; if (refuse) return { __http: 500, error: 'The engine refused the change' }; s.skills.find(item => item.path === body.path).enabled = body.enabled; return s.reply(); },
  } });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    const skills = page.getByRole('region', { name: 'Your skills', exact: true });
    const pdf = skills.getByRole('switch', { name: 'Use pdf', exact: true });
    await pdf.waitFor();
    await pdf.click();
    assert.equal(await pdf.getAttribute('aria-checked'), 'false', 'it flips at once, before the engine has answered');
    release();
    await page.getByText('The engine refused the change').waitFor();
    assert.equal(await pdf.getAttribute('aria-checked'), 'true', 'a refused change puts the switch back');
    refuse = false;
    await pdf.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Use pdf"]')?.getAttribute('aria-checked') === 'false');
    assert.equal(s.skills[0].enabled, false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
