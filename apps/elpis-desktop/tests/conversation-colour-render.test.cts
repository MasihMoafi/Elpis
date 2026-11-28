const { test, after }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { chromium }: typeof import('playwright-core') = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const styles = ['foundation.css', 'conversation.css', 'panels.css'].map(name => fs.readFileSync(path.join(__dirname, '../app/styles', name), 'utf8')).join('\n');
const browser = chromium.launch({ headless: true, ...(process.env.ELPIS_CHROMIUM ? { executablePath: process.env.ELPIS_CHROMIUM } : {}) });
after(async () => (await browser).close());

for (const state of ['idle', 'unread', 'working', 'waiting', 'error']) test(`conversation colour is visible and resets in the ${state} state`, async () => {
  const page = await (await browser).newPage();
  try {
    const mark = state === 'working' ? '<svg class="elpis-working-mark"><path></path></svg>' : '';
    await page.setContent(`<style>${styles}</style><div class="thread-row active"><div class="conversation-state-slot">
      <span class="thread-dot" data-state="${state}">${mark}</span></div></div>
      <div class="task-tab chat-tab active"><button role="tab"><svg></svg></button></div>
      <div class="chat-view"><div class="chat-scroll"><div class="turn-working"><svg class="elpis-working-mark"></svg></div></div>
      <div class="composer-working"><div class="turn-working"><svg class="elpis-working-mark"></svg></div></div></div>`);
    await page.evaluate(() => document.documentElement.setAttribute('data-accent', 'teal'));
    const sample = () => page.evaluate(() => {
      const row = document.querySelector('.thread-row')!, tab = document.querySelector('.task-tab')!;
      const dot = row.querySelector('.thread-dot')!, mark = dot.querySelector('svg');
      return {
        dot: getComputedStyle(mark || dot)[mark ? 'color' : 'backgroundColor'],
        row: getComputedStyle(row, '::before').borderColor,
        tab: getComputedStyle(tab.querySelector('svg')!).color,
        outline: getComputedStyle(tab, '::before').borderColor,
        transcript: getComputedStyle(document.querySelector('.chat-scroll .elpis-working-mark')!).color,
        composer: getComputedStyle(document.querySelector('.composer-working .elpis-working-mark')!).color,
      };
    });
    const before = await sample();
    await page.evaluate(() => document.querySelectorAll('.thread-row, .task-tab, .chat-view').forEach(element => element.setAttribute('data-conversation-colour', 'amber')));
    const amber = await sample();
    for (const key of ['dot', 'row', 'tab', 'outline'] as const) assert.notEqual(amber[key], before[key], `${state}: ${key} uses the chosen colour`);
    assert.equal(amber.dot, amber.tab, 'the indicator and tab use the same colour');
    assert.equal(amber.transcript, amber.tab, 'the transcript working mark uses the chosen colour');
    assert.equal(amber.composer, amber.tab, 'the composer working mark uses the chosen colour');
    await page.evaluate(() => document.querySelectorAll('.thread-row, .task-tab, .chat-view').forEach(element => element.removeAttribute('data-conversation-colour')));
    assert.deepEqual(await sample(), before, 'reset restores the original appearance');
  } finally { await page.close(); }
});
