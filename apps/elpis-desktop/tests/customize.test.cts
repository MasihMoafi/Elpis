// Customize, based on Claude's Customize page: Skills, Plugins and Connectors, each a list of yours. A skill turns on and
// off; Create skill starts a chat that makes one; Manage connectors opens the MCP servers settings. Local bridge
// fixture (tests/parity-fixture.cts); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const skill = (name: string, scope: string, enabled: boolean, extra = {}) => ({ id: name, name, description: `Does ${name}`, path: `/home/u/.elpis-next/skills/${name}/SKILL.md`, scope, enabled, plugin: null, ...extra });
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

test('a skill switch flips as it is pressed while the engine still answers, and goes back with the reason when the change is refused', async () => {
  const s = state(); let release: () => void = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let refuse = true;
  const f = await fixture({ routes: {
    '/api/customize': () => s.reply(),
    '/api/customize/skill': async (body: { path: string; enabled: boolean }) => { await held; if (refuse) return { __http: 500, error: 'The engine refused the change' }; const found = s.skills.find(item => item.path === body.path); if (!found) throw new Error('Skill not found'); found.enabled = body.enabled; return s.reply(); },
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
    assert.equal(s.skills.find(item => item.name === 'pdf')?.enabled, false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
