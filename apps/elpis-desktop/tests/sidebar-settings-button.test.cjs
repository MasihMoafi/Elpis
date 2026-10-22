const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.resolve(__dirname, '../app/page.tsx'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

test('the sidebar footer shows a Settings button that opens General settings', () => {
  const footer = page.slice(page.indexOf('<div className="sidebar-status">'));
  const button = footer.slice(0, footer.indexOf('</div>'));
  assert.ok(button.includes('aria-label="Settings"'), 'the sidebar status row has a Settings button');
  assert.ok(button.includes('openSettings("general")'), 'the button opens General settings');
  assert.ok(button.includes('variant="ghost" size="icon-xs"'), 'it is the shared small icon button');
  assert.match(css, /\.sidebar-status\s*\{[^}]*justify-content:space-between/, 'the button sits at the row end');
});
