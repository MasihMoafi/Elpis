const test = require('node:test');
const assert = require('node:assert/strict');
const { chromeBrands, chromeIdentity } = require('./browser-identity.cjs');

// Measured on 29 Oct from /usr/bin/google-chrome 156.0.8078.47 on Linux, loading a local page.
test('the brand list is what stock Google Chrome 156 sends', () => {
  assert.deepEqual(chromeBrands('156.0.8078.47'), [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }, { brand: 'Google Chrome', version: '156' }]);
  assert.deepEqual(chromeBrands('156.0.8078.47', true), [{ brand: 'Not:A-Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '156.0.8078.47' }, { brand: 'Google Chrome', version: '156.0.8078.47' }]);
  assert.equal(chromeIdentity('156.0.8078.47', 'linux', 'x64').userAgent, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
});

// Electron 44's Chromium 152 sends this GREASE brand itself (beside "Chromium" only).
test('the GREASE brand follows the version, as Chromium 152 sends it', () => {
  const grease = chromeBrands('152.0.7977.130').filter(item => item.brand.startsWith('Not'));
  assert.deepEqual(grease, [{ brand: 'Not?A_Brand', version: '24' }]);
  assert.throws(() => chromeBrands('nightly'), /Not a Chrome version/);
});
