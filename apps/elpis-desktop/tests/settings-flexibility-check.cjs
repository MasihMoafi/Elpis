const navigation = page => page.getByRole('navigation', { name: 'Settings navigation' });
const layout = page => navigation(page).locator('.settings-nav-group').evaluateAll(groups => groups.map(group => ({
  name: group.querySelector('.section-label').textContent,
  pages: [...group.querySelectorAll('[role="tab"]')].map(row => row.id),
})));

module.exports = { layout };
