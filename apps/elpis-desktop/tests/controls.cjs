// Exercise the visible shadcn controls, including their portals, rather than
// mutating hidden inputs or retaining native-select-only test operations.
// A87's approved main colour comes from the new-chat logo, never from the token under test.
const LOGO_ACCENT = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/branding/elpis-wordmark-amber-light-loop.svg'), 'utf8')
  .match(/<linearGradient\b[^>]*id="elpis-word-light-gold"[^>]*>\s*<stop\b[^>]*stop-color="(#[\da-f]+)"/i)[1];
async function openList(locator) {
  const page = locator.page();
  await locator.click();
  // A select can live inside an open combobox (the advanced model form).
  // Follow its aria-controls after the portal mounts, keeping this exact list
  // for the close assertion instead of matching the outer combobox's list.
  const id = await locator.and(page.locator('[aria-controls]')).getAttribute('aria-controls');
  const content = page.locator(`[id=${JSON.stringify(id)}]`);
  return content.and(page.getByRole('listbox')).or(content.getByRole('listbox'));
}
async function chooseOption(locator, value) {
  const page = locator.page();
  const list = await openList(locator);
  const options = list.getByRole('option');
  const option = value && typeof value === 'object' && 'label' in value
    ? list.getByRole('option', { name: value.label, exact: true })
    : options.and(page.locator(`[data-value=${JSON.stringify(String(value))}]`));
  await option.click();
  // The next control must not see the previous select's options during its exit animation.
  await list.waitFor({ state: 'detached' });
}
async function controlValue(locator) {
  // The catalog can replace a fallback input with a select between two awaits.
  return locator.evaluate(element => {
    const selected = element.getAttribute('data-value');
    if (selected !== null) return selected;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    throw new Error('Expected a select trigger or a native value control');
  });
}
// Settings replaces the sidebar, as in the ChatGPT app: leave it the way a user does before using the sidebar.
async function leaveSettings(page) {
  const back = page.getByRole('button', { name: 'Back to app', exact: true });
  if (await back.isVisible().catch(() => false)) await back.click();
}
/** The account menu at the sidebar's bottom (Claude's account row): Settings, Models & accounts and the theme are in it.
 * Settings replaces the sidebar, so a test that is in Settings leaves it first. */
async function accountMenu(page) {
  await leaveSettings(page);
  await page.locator('aside.sidebar .account-row').click();
  const menu = page.getByRole('menu'); await menu.waitFor();
  return menu;
}
/** Opens Settings (or another item of the account menu, such as 'Models & accounts') the way a user does. */
async function openSettings(page, item = 'Settings') { await (await accountMenu(page)).getByRole('menuitem', { name: item, exact: true }).click(); }
/** Switches the theme to 'dark' or 'light' with the account menu's theme item. */
async function chooseTheme(page, theme) { await (await accountMenu(page)).getByRole('menuitem', { name: `Use ${theme} theme`, exact: true }).click(); }
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
  // Tests see every page and the Session Manager unless a test sets them itself: the shipped defaults hide the unfinished ones (lib/preferences.ts).
  await target.addInitScript(() => {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      const value = read.call(this, key);
      if (key !== 'elpis-preferences-v1') return value;
      try { return JSON.stringify({ hiddenPages: '', sessionManager: true, ...(value ? JSON.parse(value) : {}) }); } catch { return value; }
    };
  });
}
/** Unapproved oranges in the light theme (hue 15–50°, saturated, mid lightness), as `selector: property value`.
 * A87 approves one logo colour and its exact interaction mixes. Light text still uses ink.
 * Colours are read back from a canvas pixel, so color-mix(), oklch() and gradients count as what is drawn. */
const oranges = (page, exclude = '', approvedAccents = false) => page.evaluate(({ exclude, approvedAccents, accent }) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = value; context.fillRect(0, 0, 1, 1); return context.getImageData(0, 0, 1, 1).data; };
  // A87 approves these exact colours, including the existing focus and message-edge mixes.
  // Resolve the mixes through CSS just as the renderer does; no hue range is exempted.
  const resolve = value => {
    const probe = document.createElement('span'); probe.style.color = value; document.body.append(probe);
    const pixel = [...rgba(getComputedStyle(probe).color)]; probe.remove(); return pixel;
  };
  const main = resolve(accent);
  const focus = resolve(`color-mix(in srgb, ${accent} 80%, var(--hud-edge))`);
  const message = approvedAccents ? resolve(`color-mix(in oklch, ${accent} 70%, transparent)`) : [];
  const hover = resolve(`color-mix(in srgb, ${accent}, white 8%)`);
  const pressed = resolve(`color-mix(in srgb, ${accent}, white 16%)`);
  const approved = (element, property, colour) => {
    const pixel = rgba(colour), same = expected => expected.length === pixel.length && expected.every((value, at) => value === pixel[at]);
    if (property === 'stroke' && element.matches('.elpis-working-rotor')) return same(main);
    if (property === 'color' && !approvedAccents) return false;
    return same(main)
      || (property === 'background-color' && element.matches('.primary-cut:active:not(:disabled)') && same(pressed))
      || (property === 'background-color' && element.matches('.primary-cut:hover:not(:disabled)') && same(hover))
      || (/^border-.*-color$/.test(property) && element.matches('.composer, .composer-tray') && same(focus))
      || (property === 'border-right-color' && element.matches('.message.user') && same(message));
  };
  const orange = value => {
    const [r, g, b, a] = rgba(value); if (a < 40) return false;
    const [R, G, B] = [r / 255, g / 255, b / 255], max = Math.max(R, G, B), min = Math.min(R, G, B), light = (max + min) / 2, delta = max - min;
    if (!delta) return false;
    const saturation = delta / (1 - Math.abs(2 * light - 1));
    const hue = max === R ? 60 * (((G - B) / delta) % 6) : max === G ? 60 * ((B - R) / delta + 2) : 60 * ((R - G) / delta + 4);
    return hue >= 15 && hue <= 50 && saturation >= 0.5 && light >= 0.25 && light <= 0.85;
  };
  const colours = text => text.match(/(?:rgba?|color|oklab|oklch|lab|lch|hsla?)\([^()]*\)|#[0-9a-f]{3,8}\b/gi) ?? [];
  const name = element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].slice(0, 2).map(c => `.${c}`).join('')}`;
  const hits = new Set();
  for (const element of document.querySelectorAll('body *')) {
    if (exclude && element.closest(exclude)) continue;
    if (!element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const checks = [['background-color', style.backgroundColor], ['box-shadow', style.boxShadow], ['background-image', style.backgroundImage]];
    if ([...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) checks.push(['color', style.color]);
    for (const side of ['top', 'right', 'bottom', 'left']) if (parseFloat(style[`border-${side}-width`]) > 0) checks.push([`border-${side}-color`, style[`border-${side}-color`]]);
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) checks.push(['outline-color', style.outlineColor]);
    if (element instanceof SVGElement) checks.push(['fill', style.fill], ['stroke', style.stroke]);
    for (const [property, value] of checks) {
      for (const colour of colours(value ?? '')) if (orange(colour) && !approved(element, property, colour)) {
        hits.add(`${name(element)}: ${property} ${colour}`);
      }
    }
  }
  return [...hits];
}, { exclude, approvedAccents, accent: LOGO_ACCENT });
/** A87: one logo colour; other oranges (including the former Send colour and brown) still fail. */
const unapprovedOranges = (page, exclude = '') => oranges(page, exclude, true);
/** Opens a select and lists every option whose text is cut off: clipped by the menu or the option, or running under
 * the check mark. Measures the glyphs themselves (a Range), so ellipsis and overflow:hidden both count as cut. */
async function optionsCut(trigger) {
  const page = trigger.page();
  const list = await openList(trigger);
  await list.waitFor();
  const cut = await list.evaluate(listbox => {
    const box = element => element.getBoundingClientRect();
    const clips = element => { const out = []; for (let node = element; node && node !== document.body; node = node.parentElement) if (getComputedStyle(node).overflowX !== 'visible') out.push(box(node)); return out; };
    return [...listbox.querySelectorAll('[role="option"]')].flatMap(option => {
      const text = option.firstElementChild ?? option, range = document.createRange();
      range.selectNodeContents(text);
      const glyphs = [...range.getClientRects()].filter(rect => rect.width > 0), name = option.textContent.trim();
      const problems = [];
      if (text.scrollWidth > text.clientWidth + 1 && getComputedStyle(text).overflowX !== 'visible') problems.push(`${name}: text is ${text.scrollWidth}px in ${text.clientWidth}px`);
      for (const clip of clips(text)) if (glyphs.some(rect => rect.right > clip.right + 1 || rect.left < clip.left - 1)) { problems.push(`${name}: runs past the menu`); break; }
      const check = [...option.children].find(child => child !== text && child.querySelector('svg'));
      if (check && check.getClientRects().length) { const mark = box(check); if (glyphs.some(rect => rect.right > mark.left && rect.left < mark.right && rect.bottom > mark.top && rect.top < mark.bottom)) problems.push(`${name}: runs under the check mark`); }
      return problems;
    });
  });
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'hidden' });
  return cut;
}
/** A disabled primary action must name its missing requirement visibly beside the button, including for keyboard users. */
async function assertDialogActionsExplained(dialog, expected) {
  const assert = require('node:assert/strict');
  const actions = dialog.locator('[data-slot="alert-dialog-footer"] button:disabled').filter({ hasNotText: /^(Cancel|Close)$/ });
  assert.ok(await actions.count(), 'expected an unavailable action');
  for (const action of await actions.all()) {
    const description = await action.getAttribute('aria-describedby');
    assert.ok(description, `${await action.innerText()} is unavailable without an associated reason`);
    const reasons = [];
    for (const id of description.split(/\s+/)) {
      const reason = dialog.locator(`[id="${id}"]`);
      assert.equal(await reason.isVisible(), true, `reason ${id} is not visible`);
      assert.equal(await reason.evaluate(node => !!node.closest('[data-slot="alert-dialog-footer"]')), true, 'reason must be beside the action');
      reasons.push(await reason.innerText());
    }
    if (expected) assert.match(reasons.join(' '), expected);
  }
}
module.exports = { LOGO_ACCENT, assertDialogActionsExplained, chooseOption, chooseTheme, controlValue, guardDesktopStore, leaveSettings, openSettings, optionsCut, oranges, unapprovedOranges, sidebar };
