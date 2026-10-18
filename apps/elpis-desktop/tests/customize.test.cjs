// Ledger, based on Claude's Customize page: Skills, Plugins and Connectors, each a list of yours. A skill turns on and
// off; Create skill starts a chat that makes one; Manage connectors opens the MCP servers settings. Local bridge
// fixture (tests/parity-fixture.cjs); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const skill = (name, scope, enabled, extra = {}) => ({ id: name, name, description: `Does ${name}`, path: `/home/u/.elpis-next/skills/${name}/SKILL.md`, scope, enabled, plugin: null, ...extra });
function state() {
  const skills = [skill('pdf', 'system', true), skill('web-dev', 'user', true)];
  return {
    skills, writes: [],
    reply: () => ({ skills: { data: skills.map(item => ({ ...item })), errors: [{ path: '/home/u/.elpis-next/skills/bad/SKILL.md', message: 'missing name' }] },
      plugins: { data: [{ id: 'docs@local', name: 'Docs', description: 'Writes docs', marketplace: 'My plugins', enabled: true }] },
      connectors: { data: [{ name: 'rag', enabled: true, transport: 'stdio' }, { name: 'web', enabled: false, transport: 'http' }] } }),
  };
}

test('Ledger lists skills, plugins and connectors; a skill switches off; Create skill and Manage connectors go where they say', async () => {
  const s = state();
  const f = await fixture({ routes: {
    '/api/customize': () => s.reply(),
    '/api/customize/skill': body => { s.writes.push(body); s.skills.find(item => item.path === body.path).enabled = body.enabled; return s.reply(); },
  } });
  try {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    const view = page.getByLabel('Ledger', { exact: true }).first();
    const sections = page.getByRole('radiogroup', { name: 'Ledger', exact: true });
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
    assert.deepEqual(await plugins.locator('.customize-item').allInnerTexts(), ['Docs\nWrites docs\nMy plugins\nOn']);
    await sections.getByRole('radio', { name: 'Connectors', exact: true }).click();
    const connectors = page.getByRole('region', { name: 'Your connectors', exact: true });
    assert.deepEqual(await connectors.locator('.customize-name').allInnerTexts(), ['rag', 'web']);
    assert.deepEqual(await connectors.locator('.customize-state').allInnerTexts(), ['On', 'Off']);
    await connectors.getByRole('button', { name: 'Manage connectors', exact: true }).click();
    await page.getByRole('heading', { name: 'MCP servers' }).first().waitFor();
    assert.equal(await page.getByText('This page could not be shown', { exact: false }).count(), 0, 'the MCP page reads a reply without servers as none');
    // Create skill: a new chat asks Elpis's skill creator for one.
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    await page.getByRole('region', { name: 'Your skills', exact: true }).getByRole('button', { name: 'Create skill', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Elpis"]')?.value?.startsWith('Use $skill-creator to create a new skill that '));
    await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    await page.getByRole('region', { name: 'Your skills', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.nav-list button[aria-current="page"]').allInnerTexts(), ['Ledger'], 'only Ledger is the current page');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.new-chat')).backgroundColor === 'rgba(0, 0, 0, 0)', null, { timeout: 2000 });
    if (process.env.ELPIS_SHOTS) { await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click(); await page.getByRole('region', { name: 'Your skills' }).waitFor(); await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/customize.png` }); }
    assert.ok(view);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
