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
module.exports = { chooseOption, controlValue, leaveSettings, sidebar };
