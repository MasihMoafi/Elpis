const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { BUILT_IN_THEMES } = require('../lib/theme-palettes.ts');

test('screenshot preload forwards palette colors to the thumbnail', () => {
  const Module = require('node:module');
  const original = Module._load;
  let exposed: { onShow(fn: (shot: { colors: Record<string, string> }) => void): void } | undefined;
  let receive: ((_event: unknown, shot: unknown) => void) | undefined;
  Module._load = function (name: string, ...args: unknown[]) {
    if (name === 'electron') return {
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof exposed) => { exposed = value; } },
      ipcRenderer: { on: (_name: string, fn: typeof receive) => { receive = fn; } },
    };
    return original.call(this, name, ...args);
  };
  try { require('../desktop/screenshot-popup-preload.cts'); } finally { Module._load = original; }
  let colors: Record<string, string> | undefined;
  exposed!.onShow(shot => { colors = shot.colors; });
  receive!(null, { colors: { card: '#132322' } });
  assert.deepEqual(colors, { card: '#132322' });
});

test('palette surfaces and screenshot thumbnail use the selected dark palette', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html class="dark" data-accent="violet" data-custom-palette><body><main class="dark">' +
      '<div class="segmented">Map</div><div class="model-provider-tabs"><button data-active>All</button></div></main></body></html>');
    for (const name of ['foundation', 'conversation', 'panels']) await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../app/styles', `${name}.css`), 'utf8') });
    for (const id of ['palette-teal', 'palette-green', 'palette-plum']) {
      const colors = BUILT_IN_THEMES.find((theme: { id: string }) => theme.id === id).dark;
      const result = await page.evaluate((colors: Record<string, string>) => {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(colors)) root.style.setProperty(`--palette-dark-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value);
        const shell = document.querySelector('main')!;
        const style = getComputedStyle(shell);
        const pixel = (element: Element) => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d')!; ctx.fillStyle = style.getPropertyValue('--background'); ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = getComputedStyle(element).backgroundColor; ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        return { segmented: pixel(document.querySelector('.segmented')!), selected: pixel(document.querySelector('[data-active]')!),
          colors: { card: style.getPropertyValue('--card'), foreground: style.getPropertyValue('--foreground'),
            'muted-foreground': style.getPropertyValue('--muted-foreground'), border: style.getPropertyValue('--border') } };
      }, colors);
      if (id !== 'palette-plum') for (const [name, rgb] of Object.entries(result).filter(([name]) => name !== 'colors') as [string, number[]][])
        assert.ok((rgb[0] ?? 0) <= (rgb[1] ?? 0), `${id} ${name}: ${rgb}`);
      const popup = await browser.newPage();
      await popup.addInitScript(() => {
        const target = window as unknown as { elpisScreenshot: unknown; showShot: (shot: unknown) => void };
        target.elpisScreenshot = { onShow: (fn: (shot: unknown) => void) => { target.showShot = fn; }, dismiss() {}, choose() {} };
      });
      await popup.goto(`file://${path.join(__dirname, '../desktop/screenshot-popup.html')}`);
      await popup.evaluate((colors: Record<string, string>) => {
        const target = window as unknown as { showShot: (shot: unknown) => void };
        target.showShot({ dark: true, count: 1, image: '', name: '', colors });
      }, result.colors);
      const expected = await page.evaluate((color: string) => {
        const el = document.createElement('div'); el.style.backgroundColor = color; document.body.append(el);
        const value = getComputedStyle(el).backgroundColor; el.remove(); return value;
      }, colors.surface);
      assert.equal(await popup.locator('.shot').evaluate((el: Element) => getComputedStyle(el).backgroundColor), expected, `${id} screenshot card`);
      await popup.close();
    }
  } finally { await browser.close(); }
});

test('automation schedule stays clear of delete on hover and focus', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="automation-heading"><button class="automation-summary">' +
      '<span class="automation-title">Weekly PhD portal watch</span><span class="automation-when">' +
      'Every week at 09:00 (Asia/Tehran) · next Wed, Dec 2, 09:00 AM</span></button><button class="automation-delete">Delete</button></div>');
    const css = fs.readFileSync(path.join(__dirname, '../components/automations-view.css'), 'utf8');
    await page.addStyleTag({ content: `* { box-sizing:border-box; } .automation-delete { width:28px; height:28px; }\n${css}` });
    for (const width of [860, 650, 440]) {
      await page.locator('.automation-heading').evaluate((el: HTMLElement, width: number) => { el.style.width = `${width}px`; }, width);
      await page.mouse.move(0, 0);
      const schedule = page.locator('.automation-when'), before = await schedule.boundingBox();
      await page.locator('.automation-summary').hover();
      const after = await schedule.boundingBox(), deletion = await page.locator('.automation-delete').boundingBox();
      assert.deepEqual(after, before, `schedule moves at ${width}px`);
      assert.ok(after && deletion && after.x + after.width <= deletion.x, `delete covers schedule at ${width}px`);
      await page.locator('.automation-delete').focus();
      assert.deepEqual(await schedule.boundingBox(), before, `schedule moves on focus at ${width}px`);
    }
  } finally { await browser.close(); }
});
