// Run unchanged against a CI renderer or a real packaged app with copied chat history.
const assert = require('node:assert/strict');
const { drag, shot } = require('./settings-reorder-check.cjs');
const { openSettings, leaveSettings } = require('./controls.cjs');

async function feedback(page, source, target, { shots, name } = {}) {
  await page.evaluate(() => {
    window.__reorderEvents = [];
    window.__reorderListener ||= event => window.__reorderEvents.push(event.type);
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      document.removeEventListener(type, window.__reorderListener, true);
      document.addEventListener(type, window.__reorderListener, true);
    }
  });
  let appearance;
  await drag(page, source, target, false, false, async () => {
    await shot(page, shots, `${name}-drag`);
    assert.equal(await target.getAttribute('data-drop'), 'before', `${name}: chat drop indicator`);
    assert.equal(await source.getAttribute('data-dragging'), '', `${name}: chat drag preview`);
    appearance = await target.evaluate(element => {
      const style = getComputedStyle(element);
      return { shadow: style.boxShadow, transition: style.transition };
    });
    assert.match(appearance.shadow, /inset/, `${name}: visible chat drop line`);
    await source.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    Object.assign(appearance, await source.evaluate(element => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, translate: style.translate, transform: style.transform };
    }));
  });
  assert.equal(await target.getAttribute('data-drop'), null, `${name}: drop line clears`);
  assert.equal(await source.getAttribute('data-dragging'), null, `${name}: preview clears`);
  const events = await page.evaluate(() => window.__reorderEvents);
  // Native browsers emit a variable number of enter/over events; compare the same event lifecycle.
  appearance.events = [...new Set(events)];
  assert.deepEqual(appearance.events, ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']);
  return appearance;
}

async function compare(page, options = {}) {
  const chats = page.locator('aside.sidebar section[aria-label="Recents"] .thread-row');
  await chats.nth(1).waitFor();
  assert.ok(await chats.count() >= 2, 'Seed at least two copied chats in Recents');
  const chat = await feedback(page, chats.last(), chats.first(), { ...options, name: 'chat' });
  await openSettings(page);
  const sections = page.locator('.settings-nav [data-slot="section-link"]');
  const settings = await feedback(page, sections.last(), sections.first(), { ...options, name: 'settings' });
  assert.deepEqual(settings, { ...chat, opacity: '1' }, 'Settings keeps native chat motion without an added CSS fade');
  assert.equal(chat.opacity, '1', 'the shared row must not add transparency to the native drag');
  assert.equal(settings.translate, 'none', 'reorder rows must not move like pressed action buttons');
  assert.equal(settings.transform, 'none', 'reorder rows use native drag motion');
  // Pages move within their section; App & terminal contains several pages.
  const groupPages = page.locator('.settings-nav-group').filter({ has: page.getByRole('tab', { name: 'General', exact: true }) }).getByRole('tab');
  assert.deepEqual(await feedback(page, groupPages.last(), groupPages.first(), { ...options, name: 'settings-page' }), chat);
  await leaveSettings(page);
  const sidebar = page.locator('aside.sidebar [data-nav-page]');
  assert.deepEqual(await feedback(page, sidebar.last(), sidebar.first(), { ...options, name: 'sidebar' }), chat);
  const projects = page.locator('aside.sidebar .project-row');
  if (await projects.count() >= 2) assert.deepEqual(await feedback(page, projects.last(), projects.first(), { ...options, name: 'project' }), chat);
  return chat;
}
module.exports = { compare, feedback };
