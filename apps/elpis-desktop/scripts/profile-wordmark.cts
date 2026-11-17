import type { Page } from 'playwright-core';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { fixture }: typeof import('../tests/parity-fixture.cts') = require('../tests/parity-fixture.cts');
type Mode = 'baseline' | 'variant';
type Sample = { mode: Mode; elapsedMs: number; rendererCpuPercent: number; taskPercent: number; processes: number[] };
type ProfileWindow = Window & { __wordmarks?: string[] };
const destination = process.env.ELPIS_PROFILE_OUTPUT;
if (!destination) throw new Error('Set ELPIS_PROFILE_OUTPUT to the evidence directory.');

async function setMode(page: Page, mode: Mode) {
  await page.evaluate(mode => {
    const win = window as ProfileWindow;
    const roots = [...document.querySelectorAll<HTMLElement>('[data-profile-wordmark]')];
    win.__wordmarks ??= roots.map(root => root.outerHTML);
    roots.forEach((root, index) => { root.outerHTML = win.__wordmarks![index]!; });
    for (const svg of document.querySelectorAll<SVGSVGElement>('[data-profile-wordmark]')) {
      const original = svg.querySelector<SVGElement>('.light');
      if (!original) throw new Error('Missing original sweep');
      original.setAttribute('data-profile-light', '');
      if (mode === 'baseline') continue;
      const box = svg.getBoundingClientRect();
      const silhouette = svg.querySelector('[id$="-shape"]')!.cloneNode(true) as SVGElement;
      for (const item of silhouette.querySelectorAll('path')) item.setAttribute('fill', 'white');
      const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 5 224 110">${silhouette.outerHTML}</svg>`;
      const wrapper = document.createElement('span');
      wrapper.className = svg.getAttribute('class') ?? '';
      wrapper.setAttribute('data-profile-wordmark', '');
      Object.assign(wrapper.style, { position: 'relative', display: 'inline-block', width: `${box.width}px`, height: `${box.height}px` });
      svg.replaceWith(wrapper); wrapper.append(svg);
      svg.removeAttribute('data-profile-wordmark');
      svg.style.cssText = 'display:block;width:100%;height:100%';
      original.remove();
      const clip = document.createElement('span');
      Object.assign(clip.style, { position: 'absolute', inset: '0', pointerEvents: 'none',
        maskImage: `url("data:image/svg+xml,${encodeURIComponent(mask)}")`, maskSize: '100% 100%', maskRepeat: 'no-repeat' });
      const light = document.createElement('span');
      light.setAttribute('data-profile-light', '');
      Object.assign(light.style, { position: 'absolute', left: `${-60 / 224 * 100}%`, top: `${-5 / 110 * 100}%`,
        width: `${60 / 224 * 100}%`, height: `${128 / 110 * 100}%`, opacity: '0', willChange: 'transform, opacity',
        background: 'linear-gradient(to right, transparent, rgb(255 255 255 / .4), transparent)',
        animation: 'profile-sweep 6s 1.05s ease-in-out infinite' });
      clip.append(light); wrapper.append(clip);
    }
    for (const node of document.querySelectorAll('[data-profile-light]')) {
      for (const animation of node.getAnimations()) { animation.currentTime = 1050; animation.play(); }
    }
  }, mode);
}

async function scenario(name: string, dark: boolean, newChat: boolean) {
  const f = await fixture({ colorScheme: dark ? 'dark' : 'light', width: 1440, height: 900 });
  const page = f.page as unknown as Page;
  const browser = page.context().browser(); assert.ok(browser);
  const cdp = await page.context().newCDPSession(page), processCdp = await browser.newBrowserCDPSession();
  await cdp.send('Performance.enable');
  const cpu = async () => (await processCdp.send('SystemInfo.getProcessInfo')).processInfo
    .filter(item => item.type === 'renderer').map(({ id, cpuTime }) => ({ id, cpuTime })).sort((a, b) => a.id - b.id);
  const task = async () => (await cdp.send('Performance.getMetrics')).metrics.find(item => item.name === 'TaskDuration')!.value;
  const samples: Sample[] = [];
  try {
    if (newChat) await page.getByRole('button', { name: 'New chat', exact: true }).click();
    else await f.open('chat-a');
    await page.locator('.brand .size-wordmark').waitFor();
    await page.addStyleTag({ content: `@keyframes profile-sweep {
      0% { opacity:0;transform:translateX(0) } 4%,18% { opacity:1 }
      28%,100% { opacity:0;transform:translateX(516.6666667%) }
    }` });
    await page.evaluate(() => {
      for (const svg of document.querySelectorAll('.brand .size-wordmark, .empty-state .empty-mark')) svg.setAttribute('data-profile-wordmark', '');
    });
    await page.waitForTimeout(1500);
    for (const mode of ['baseline', 'variant', 'variant', 'baseline'] as const) {
      await setMode(page, mode);
      await page.waitForTimeout(1200);
      const text = await page.locator('body').innerText(), before = await cpu(), beforeTask = await task(), start = performance.now();
      await page.waitForTimeout(6000);
      const end = performance.now(), afterTask = await task(), after = await cpu();
      assert.equal(await page.locator('body').innerText(), text, 'visible content changed during the sample');
      assert.deepEqual(after.map(p => p.id), before.map(p => p.id), 'renderer processes changed during the sample');
      const elapsedMs = end - start;
      const rendererCpuPercent = after.reduce((sum, item, i) => sum + item.cpuTime - before[i]!.cpuTime, 0) * 100_000 / elapsedMs;
      samples.push({ mode, elapsedMs, rendererCpuPercent, taskPercent: (afterTask - beforeTask) * 100_000 / elapsedMs, processes: before.map(p => p.id) });
    }
    for (const mode of ['baseline', 'variant'] as const) {
      await setMode(page, mode);
      await page.waitForTimeout(1200);
      for (const time of [1350, 1950, 2550]) {
        await page.evaluate(time => {
          for (const node of document.querySelectorAll('[data-profile-light]')) for (const a of node.getAnimations()) { a.pause(); a.currentTime = time; }
        }, time);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator('.brand [data-profile-wordmark]').screenshot({ path: path.join(destination!, `${name}-${mode}-${time}.png`) });
      }
    }
    assert.deepEqual(f.errors, []);
    return { name, browser: browser.version(), samples };
  } finally { await f.close(); }
}

async function main() {
  await fs.mkdir(destination!, { recursive: true });
  const result: { name: string; browser: string; samples: Sample[] }[] = [];
  for (const [name, dark, newChat] of [['light-chat', false, false], ['dark-chat', true, false], ['light-new-chat', false, true]] as const) {
    result.push(await scenario(name, dark, newChat));
    await fs.writeFile(path.join(destination!, 'samples.json'), JSON.stringify({ source: await fs.readFile(path.join(__dirname, '../out/.commit'), 'utf8'),
      machine: { platform: os.platform(), cpus: os.cpus().map(c => c.model) }, result }, null, 2));
    console.log(JSON.stringify(result.at(-1)));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
