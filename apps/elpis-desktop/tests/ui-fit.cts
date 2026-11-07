const assert = require('node:assert/strict');
type Box = { left: number; top: number; right: number; bottom: number };
type Container = { evaluate<T>(fn: (root: HTMLElement) => T): Promise<T> };

/** Check rendered text fragments, their clipping boxes and native field contents. Fully scrolled-out content and
 * hidden layers are not rendered text. Ellipsis is allowed only with the complete text in a title. */
async function uiFit(container: Container) {
  return container.evaluate(root => {
    const issues: string[] = [], boxes: { el: HTMLElement; box: Box; name: string }[] = [], tolerance = 1.5;
    const rect = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const meet = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const inside = (a: Box, b: Box) => a.left >= b.left - tolerance && a.right <= b.right + tolerance && a.top >= b.top - tolerance && a.bottom <= b.bottom + tolerance;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const name = (el: HTMLElement) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}: ${(el.textContent || (el as HTMLInputElement).value || '').trim().slice(0, 65)}`;
    const hidden = (el: HTMLElement) => { for (let e: HTMLElement | null = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return true;
      if (e.tagName === 'DETAILS' && !(e as HTMLDetailsElement).open && !e.querySelector(':scope > summary')?.contains(el)) return true;
    } return false; };
    const covered = (el: HTMLElement, box: Box) => {
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, (box.left + box.right) / 2), Math.min(innerHeight - 1, (box.top + box.bottom) / 2));
      const popup = hit?.closest('[role=dialog], [role=alertdialog], [role=menu], [role=listbox]');
      return popup && !popup.contains(el);
    };
    const clips = (el: HTMLElement) => { const out = []; for (let e: HTMLElement | null = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (/(hidden|clip|auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) out.push({ box: rect(e.getBoundingClientRect()), scroll: /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`) }); } return out; };
    const ellipsis = (el: HTMLElement, text: string) => { for (let e: HTMLElement | null = el; e && root.contains(e); e = e.parentElement) if (getComputedStyle(e).textOverflow === 'ellipsis' && e.title.includes(text.trim())) return true; return false; };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode, el = text.parentElement, content = text.textContent;
      if (!content?.trim() || !el || el.closest('script,style,svg,textarea') || hidden(el)) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const r of range.getClientRects()) {
        if (r.width < 0.1 || r.height < 0.1) continue;
        const raw = rect(r), clip = clips(el);
        let box = clip.filter(c => c.scroll).reduce((b, c) => ({ left: Math.max(b.left, c.box.left), top: Math.max(b.top, c.box.top), right: Math.min(b.right, c.box.right), bottom: Math.min(b.bottom, c.box.bottom) }), raw);
        if (clip.some(c => !meet(box, c.box))) continue;
        const own = rect(el.getBoundingClientRect()), allowed = ellipsis(el, content);
        if (allowed) box = [{ box: own }, ...clip].reduce((b, c) => ({ left: Math.max(b.left, c.box.left), top: Math.max(b.top, c.box.top), right: Math.min(b.right, c.box.right), bottom: Math.min(b.bottom, c.box.bottom) }), box);
        if (!inside(box, viewport)) issues.push(`outside viewport: ${name(el)}`);
        // Glyphs can exceed their line box without clipping when overflow is visible.
        if (clip.some(c => !inside(box, c.box) && !c.scroll) && !ellipsis(el, content)) issues.push(`clipped text: ${name(el)}`);
        // A popup can cover the graph beneath it; only the top text layer is visible.
        if (covered(el, box)) continue;
        boxes.push({ el, box, name: name(el) });
      }
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]; if (!a || !b || a.el === b.el || !meet(a.box, b.box)) continue;
      const intersection = { left: Math.max(a.box.left, b.box.left), top: Math.max(a.box.top, b.box.top), right: Math.min(a.box.right, b.box.right), bottom: Math.min(a.box.bottom, b.box.bottom) };
      if (!covered(a.el, intersection) && !covered(b.el, intersection)) issues.push(`text overlap: ${a.name} / ${b.name}`);
    }
    for (const el of root.querySelectorAll<HTMLElement>('button,input,textarea,[role="combobox"]')) {
      if (hidden(el)) continue;
      const clip = clips(el), raw = rect(el.getBoundingClientRect());
      if (raw.right <= raw.left || raw.bottom <= raw.top || clip.some(c => c.scroll && !meet(raw, c.box))) continue;
      const visible = clip.filter(c => c.scroll).reduce((b, c) => ({ left: Math.max(b.left, c.box.left), top: Math.max(b.top, c.box.top), right: Math.min(b.right, c.box.right), bottom: Math.min(b.bottom, c.box.bottom) }), raw);
      if (!inside(visible, viewport)) issues.push(`outside control: ${el.getAttribute('aria-label') || name(el)}`);
    }
    for (const el of root.querySelectorAll('textarea')) if (!hidden(el) && el.scrollHeight > el.clientHeight + 2) issues.push(`clipped field: ${el.getAttribute('aria-label')}`);
    return [...new Set(issues)];
  });
}
async function assertUiFit(container: Container, label: string) { assert.deepEqual(await uiFit(container), [], label); }
module.exports = { uiFit, assertUiFit };
