#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function options() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6, 'Usage: render-ledger-close-placement.cjs --evidence DIR --modules NODE_MODULES_DIR --chrome PATH');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--evidence', '--modules', '--chrome'].includes(args[i]) && !values[args[i]], `Unexpected or duplicate option: ${args[i]}`);
    values[args[i]] = fs.realpathSync(args[i + 1]);
  }
  return { evidence: values['--evidence'], modules: values['--modules'], chrome: values['--chrome'] };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

(async () => {
  const { evidence, modules, chrome } = options();
  const { chromium } = require(path.join(modules, 'playwright-core'));
  const xterm = path.join(modules, '@xterm/xterm');
  const versions = Object.fromEntries(['playwright-core', '@xterm/xterm'].map(name => [
    name, JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')).version,
  ]));
  const captures = fs.readdirSync(evidence).flatMap(name => {
    const match = name.match(/(?:^|-)(100|140)-(light|dark)-open\.ansi$/);
    return match ? [{ name, width: Number(match[1]), light: match[2] === 'light' }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const width of [100, 140]) for (const light of [false, true]) {
    assert(captures.some(capture => capture.width === width && capture.light === light), `Missing ${width}-${light ? 'light' : 'dark'}-open.ansi capture`);
  }
  const resultFile = path.join(evidence, 'render-result.json');
  for (const filename of [resultFile, ...captures.map(capture => path.join(evidence, capture.name.replace(/\.ansi$/, '.png')))]) {
    assert(!fs.existsSync(filename), `Refusing to overwrite existing evidence: ${filename}`);
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const rendered = [];
  try {
    for (const capture of captures) {
      const raw = fs.readFileSync(path.join(evidence, capture.name), 'utf8');
      const lines = raw.replaceAll('\r\n', '\n').split('\n');
      // capture-pane appends one newline; preserve every cell and all other rows.
      if (lines.at(-1) === '') lines.pop();
      const rows = Math.max(40, lines.length);
      const page = await browser.newPage({ viewport: { width: 2200, height: 1200 }, deviceScaleFactor: 1 });
      try {
        await page.route('**/*', route => route.abort());
        await page.addStyleTag({ path: path.join(xterm, 'css/xterm.css') });
        await page.addScriptTag({ path: path.join(xterm, 'lib/xterm.js') });
        const cells = await page.evaluate(async ({ width, light, rows, text }) => {
          // These defaults are exactly the native harness's tmux window-style.
          // Captured SGR foreground/background and formatting remain untouched.
          const theme = { foreground: light ? '#111111' : '#eeeeee', background: light ? '#ffffff' : '#111111' };
          document.body.style.margin = '0';
          document.body.style.background = theme.background;
          const host = document.createElement('div');
          host.id = 'terminal'; document.body.appendChild(host);
          const terminal = new Terminal({
            cols: width, rows, fontFamily: 'DejaVu Sans Mono, monospace', fontSize: 18,
            lineHeight: 1.2, theme, allowTransparency: false, allowProposedApi: true,
          });
          await document.fonts.ready;
          terminal.open(host);
          await new Promise(resolve => terminal.write(text + '\x1b[?25l', resolve));
          host.style.width = `${host.querySelector('.xterm-screen').getBoundingClientRect().width}px`;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const row = Array.from({ length: rows }, (_, y) => y).find(y => terminal.buffer.active.getLine(y)?.getCell(width - 9)?.getChars() === '✕');
          if (row === undefined) throw Error('Missing Close glyph in replayed ANSI cells');
          const color = (cell, foreground) => {
            const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
            const isRGB = foreground ? cell.isFgRGB() : cell.isBgRGB();
            const value = foreground ? cell.getFgColor() : cell.getBgColor();
            return isDefault ? { mode: 'default' } : { mode: isRGB ? 'rgb' : 'palette', value };
          };
          return { row, theme, button: Array.from({ length: 9 }, (_, offset) => {
            const cell = terminal.buffer.active.getLine(row).getCell(width - 10 + offset);
            return { text: cell.getChars(), bold: Boolean(cell.isBold()), foreground: color(cell, true), background: color(cell, false) };
          }) };
        }, { width: capture.width, light: capture.light, rows, text: lines.join('\r\n') });
        assert.equal(cells.button.map(cell => cell.text).join(''), ' ✕ Close ', 'ANSI replay must retain the native Close cells');
        const png = capture.name.replace(/\.ansi$/, '.png');
        await page.locator('#terminal').screenshot({ path: path.join(evidence, png) });
        rendered.push({ input: capture.name, png, columns: capture.width, rows, ansiSha256: sha256(Buffer.from(raw)), pngSha256: sha256(fs.readFileSync(path.join(evidence, png))), ...cells });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(resultFile, JSON.stringify({ versions, font: 'DejaVu Sans Mono, monospace', fontSize: 18, lineHeight: 1.2, captures: rendered }, null, 2) + '\n');
  console.log(JSON.stringify({ rendered: rendered.length, resultFile }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
