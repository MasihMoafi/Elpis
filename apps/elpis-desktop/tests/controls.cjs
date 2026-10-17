// Exercise the visible shadcn controls, including their portals, rather than
// mutating hidden inputs or retaining native-select-only test operations.
async function chooseOption(locator, value) {
  const page = locator.page();
  await locator.click();
  const options = page.getByRole('option');
  const option = value && typeof value === 'object' && 'label' in value
    ? page.getByRole('option', { name: value.label, exact: true })
    : options.and(page.locator(`[data-value=${JSON.stringify(String(value))}]`));
  await option.click();
}
async function controlValue(locator) {
  if (await locator.getAttribute('data-value') !== null) return locator.getAttribute('data-value');
  return locator.inputValue();
}
// Settings replaces the sidebar, as in the ChatGPT app: leave it the way a user does before using the sidebar.
async function leaveSettings(page) {
  const back = page.getByRole('button', { name: 'Back to app', exact: true });
  if (await back.isVisible().catch(() => false)) await back.click();
}
async function sidebar(page) { await leaveSettings(page); return page.locator('aside'); }
/** Makes the page's stub of the desktop store (window.elpisDesktop.storage) refuse what the real one refuses
 * (STORE_KEYS in desktop/state.cjs): a refused key throws, uncaught, as "Unsupported workspace value", so the test's
 * pageerror check fails. Add it before the stub's own init script. */
async function guardDesktopStore(target) {
  const { STORE_KEYS } = require('../desktop/state.cjs');
  await target.addInitScript(source => {
    const allowed = new RegExp(source); let current;
    const guard = (inner, key, rest) => { if (allowed.test(key)) return inner(key, ...rest); setTimeout(() => { throw Error(`Unsupported workspace value: ${key}`); }); };
    Object.defineProperty(window, 'elpisDesktop', { configurable: true, get: () => current, set: value => {
      const storage = value?.storage;
      if (storage) for (const name of ['setItem', 'removeItem', 'saveItem']) if (typeof storage[name] === 'function') { const inner = storage[name]; storage[name] = (key, ...rest) => guard(inner, key, rest); }
      current = value;
    } });
  }, STORE_KEYS.source);
}
module.exports = { chooseOption, controlValue, guardDesktopStore, leaveSettings, sidebar };
