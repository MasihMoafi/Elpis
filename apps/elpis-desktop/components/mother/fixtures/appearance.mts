/** Geometry assertions for the real desktop page, called by the private-display screenshot run. */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright-core'

export async function checkPanelLayout(page: Page) {
  const failures = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.dt-page')
    if (!root) return ['Elpis panel is not open']
    const problems: string[] = []
    const visibleBox = (element: HTMLElement) => {
      const box = element.getBoundingClientRect()
      let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right)
      let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom)
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
      return { left, right, top, bottom }
    }
    const shown = (element: HTMLElement) => {
      const box = visibleBox(element)
      return box.right > box.left && box.bottom > box.top && getComputedStyle(element).visibility !== 'hidden'
    }
    const name = (element: HTMLElement) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || element.tagName
    const swatch = document.createElement('span')
    swatch.style.backgroundColor = 'var(--card)'; root.append(swatch)
    const selectedBackground = getComputedStyle(swatch).backgroundColor; swatch.remove()
    for (const selected of root.querySelectorAll<HTMLElement>('.dt-tabs [aria-selected="true"]')) {
      if (getComputedStyle(selected).backgroundColor !== selectedBackground) problems.push('The selected tab does not use the shared selected surface')
    }
    const column = root.querySelector<HTMLElement>('.dt-column')
    if (column) {
      const style = getComputedStyle(root)
      const available = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const width = Math.min(available, parseFloat(style.getPropertyValue('--page-content-width')))
      if (Math.abs(column.getBoundingClientRect().width - width) > 1) problems.push('The panel does not use the shared page width')
    }
    for (const element of root.querySelectorAll<HTMLElement>('.dt-column, .dt-main, .dt-settings, .dt-settings-body, .dt-prompt, .dt-prompt-main, .dt-search-results, nav, [role="tablist"]')) {
      if (shown(element) && element.scrollWidth > element.clientWidth + 1) problems.push(`Horizontal overflow: ${name(element)}`)
    }
    if (root.scrollWidth > root.clientWidth + 1) problems.push('The panel scrolls horizontally')
    // A two-column layout may collapse to a stack, but its navigation must never cover its editor.
    for (const layout of root.querySelectorAll<HTMLElement>('.dt-settings, .dt-prompt')) {
      const [nav, body] = [...layout.children] as HTMLElement[]
      if (!nav || !body) continue
      if (layout.classList.contains('dt-settings') && column && Math.abs(layout.getBoundingClientRect().width - column.getBoundingClientRect().width) > 1) {
        problems.push('Settings navigation and rows do not fill the shared page column')
      }
      const a = nav.getBoundingClientRect(), b = body.getBoundingClientRect()
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
        problems.push(`Navigation covers content: ${layout.className}`)
      }
    }
    for (const row of root.querySelectorAll<HTMLElement>('.settings-row')) {
      if (!shown(row) || getComputedStyle(row).flexDirection !== 'column') continue
      const main = row.querySelector<HTMLElement>(':scope > .dt-row-main')
      if (!main) continue
      const children = [...main.children] as HTMLElement[]
      const contentHeight = children.reduce((height, child) => {
        const style = getComputedStyle(child)
        return height + child.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
      }, 0) + Math.max(0, children.length - 1) * (parseFloat(getComputedStyle(main).rowGap) || 0)
      if (main.getBoundingClientRect().height > Math.max(contentHeight, parseFloat(getComputedStyle(row).minHeight) || 0) + 1) {
        problems.push(`Stacked row has excess empty height: ${name(row)}`)
      }
    }
    for (const title of root.querySelectorAll<HTMLElement>('.dt-search-results button:has(.dt-mark)')) {
      if (!shown(title) || title.scrollWidth > title.clientWidth + 1) continue
      const style = getComputedStyle(title), probe = document.createElement('span')
      probe.textContent = title.textContent?.replace(/\s+/g, ' ').trim() || ''
      Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre', font: style.font, letterSpacing: style.letterSpacing })
      root.append(probe)
      const expected = probe.getBoundingClientRect(); probe.remove()
      const range = document.createRange(); range.selectNodeContents(title)
      const actual = range.getBoundingClientRect()
      if (actual.height <= expected.height + 1 && actual.width + 1 < expected.width) problems.push(`Highlighted words lose spacing: ${name(title)}`)
    }
    const controls = [...root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), textarea, a, [role="switch"]')].filter(shown)
    for (const [index, element] of controls.entries()) {
      const a = visibleBox(element)
      if (getComputedStyle(element).fontSize && parseFloat(getComputedStyle(element).fontSize) < 12) problems.push(`Text below the shared size floor: ${name(element)}`)
      if (element.tagName === 'BUTTON' && getComputedStyle(element).textOverflow !== 'ellipsis' && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)) {
        problems.push(`Button clips its label: ${name(element)}`)
      }
      for (const other of controls.slice(index + 1)) {
        if (element.contains(other) || other.contains(element)) continue
        // Sticky Save feedback covers scrolling content; its actions must remain separate from each other.
        if (Boolean(element.closest('.dt-savebar')) !== Boolean(other.closest('.dt-savebar'))) continue
        if (Boolean(element.closest('.dt-search-results')) !== Boolean(other.closest('.dt-search-results'))) continue
        const b = visibleBox(other)
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          problems.push(`Controls overlap: ${name(element)} / ${name(other)}`)
        }
      }
    }
    return problems
  })
  assert.deepEqual(failures, [], failures.join('\n'))
}

// Run against an already-open panel in a private desktop; the caller owns its launch and state setup.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'Usage: node components/mother/fixtures/appearance.mts <private-desktop-CDP-URL>')
  const browser = await chromium.connectOverCDP(process.argv[2])
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => !page.url().startsWith('devtools'))
    assert.ok(page, 'Private desktop page is missing')
    await checkPanelLayout(page)
    console.log('Panel geometry: pass')
  } finally { await browser.close() }
}
