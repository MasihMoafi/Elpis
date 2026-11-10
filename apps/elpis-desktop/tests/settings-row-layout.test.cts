// Settings spec (specs/settings.md), measured against the ChatGPT and Claude apps on 10 Nov:
// each row's control sits on the right, centred on the row (S3), and a group's rows share one box with hairlines
// between them, never a box per item (S4). Every Settings page is checked at a desktop width.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings } = require('./controls.cts');

type Finding = string;

test('every Settings row puts its control on the right, centred, and each group keeps its rows in one box (S3, S4)', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1280, height: 900 }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    const tabs = page.locator('.settings-nav [role="tab"]');
    const names: string[] = await tabs.evaluateAll((all: Element[]) => all.map(tab => (tab.textContent ?? '').trim()));
    assert.ok(names.length >= 8, `Settings has its pages (${names.join(', ')})`);
    const findings: Finding[] = [];
    for (const [index, name] of names.entries()) {
      await tabs.nth(index).click();
      await page.waitForTimeout(300);
      findings.push(...await page.locator('.settings-page').evaluate((pageEl: HTMLElement, tab: string) => {
        const out: string[] = [];
        const panel = [...pageEl.querySelectorAll('[role="tabpanel"]')].find(el => !(el as HTMLElement).hidden) ?? pageEl;
        for (const row of panel.querySelectorAll<HTMLElement>('[data-slot="settings-row"]:not(.stacked):not(.settings-actions)')) {
          const control = row.querySelector<HTMLElement>(':scope > .settings-row-control');
          if (!control || !row.offsetParent) continue;
          const r = row.getBoundingClientRect(), c = control.getBoundingClientRect();
          const title = (row.querySelector('.settings-row-text')?.textContent ?? '').trim().slice(0, 40);
          const pad = parseFloat(getComputedStyle(row).paddingRight);
          if (Math.abs(r.right - pad - c.right) > 2) out.push(`${tab} › ${title}: control ends ${Math.round(r.right - pad - c.right)}px from the right`);
          if (Math.abs((r.top + r.bottom) / 2 - (c.top + c.bottom) / 2) > 3) out.push(`${tab} › ${title}: control not centred on the row`);
          if (c.top >= (row.querySelector('.settings-row-text')?.getBoundingClientRect().bottom ?? Infinity) - 1) out.push(`${tab} › ${title}: control sits under its text`);
        }
        for (const group of panel.querySelectorAll<HTMLElement>('.settings-group')) {
          if (!group.offsetParent) continue;
          const boxes = [...group.querySelectorAll('.settings-rows, .settings-card')].filter(box => !box.parentElement?.closest('.settings-rows, .settings-card'));
          const perItem = group.querySelectorAll('.settings-rows .settings-card').length;
          const label = group.getAttribute('aria-label') ?? '';
          if (boxes.length > 1) out.push(`${tab} › ${label}: ${boxes.length} boxes in one group`);
          if (perItem > 1) out.push(`${tab} › ${label}: ${perItem} cards inside the group's box`);
        }
        return out;
      }, name));
    }
    assert.deepEqual(findings, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
