// Run unchanged against a CI renderer or a real packaged app with copied chat history.
const assert = require('node:assert/strict');
const { drag, shot } = require('./settings-reorder-check.cts');

type Locator = {
  getAttribute(name: string): Promise<string | null>;
  evaluate<T>(fn: (element: Element) => T): Promise<Awaited<T>>;
  nth(index: number): Locator;
  first(): Locator;
  last(): Locator;
  waitFor(): Promise<void>;
  count(): Promise<number>;
};
type Page = {
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  locator(selector: string): Locator;
};
type ReorderWindow = Window & { __reorderEvents?: string[]; __reorderListener?: (event: Event) => void };
type Options = { shots?: string; name?: string };
type Appearance = { shadow: string; transition: string; opacity?: string; translate?: string; transform?: string; events?: string[] };

async function feedback(page: Page, source: Locator, target: Locator, { shots, name }: Options = {}) {
  await page.evaluate(() => {
    const reorderWindow = window as ReorderWindow;
    reorderWindow.__reorderEvents = [];
    reorderWindow.__reorderListener ||= (event: Event) => reorderWindow.__reorderEvents?.push(event.type);
    for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
      document.removeEventListener(type, reorderWindow.__reorderListener, true);
      document.addEventListener(type, reorderWindow.__reorderListener, true);
    }
  });
  let appearance: Appearance | undefined;
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
  if (!appearance) throw new Error('drag callback did not capture appearance');
  const events = await page.evaluate(() => {
    const recorded = (window as ReorderWindow).__reorderEvents;
    if (!recorded) throw new Error('drag events were not recorded');
    return recorded;
  });
  // Native browsers emit a variable number of enter/over events; compare the same event lifecycle.
  appearance.events = [...new Set(events)];
  assert.deepEqual(appearance.events, ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']);
  return appearance;
}

async function compare(page: Page, options: Options = {}) {
  const chats = page.locator('aside.sidebar section[aria-label="Recents"] .thread-row');
  await chats.nth(1).waitFor();
  assert.ok(await chats.count() >= 2, 'Seed at least two copied chats in Recents');
  const chat = await feedback(page, chats.last(), chats.first(), { ...options, name: 'chat' });
  assert.equal(chat.opacity, '1', 'the shared row must not add transparency to the native drag');
  const sidebar = page.locator('aside.sidebar [data-nav-page]');
  assert.deepEqual(await feedback(page, sidebar.last(), sidebar.first(), { ...options, name: 'sidebar' }), chat);
  const projects = page.locator('aside.sidebar .project-row');
  if (await projects.count() >= 2) assert.deepEqual(await feedback(page, projects.last(), projects.first(), { ...options, name: 'project' }), chat);
  return chat;
}
module.exports = { compare, feedback };
