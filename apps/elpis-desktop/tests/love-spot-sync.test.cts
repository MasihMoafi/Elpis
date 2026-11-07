import type { Page } from 'playwright-core';
import type { LoveSpotFixture, LoveSpotOptions, Scene, SceneElement } from './love-spot-test-types.mts';
type SyncTrace = { sources: number; held: { source: number; readyState: number; revision: number; elements: object[] }[]; key: { key: string; target?: string; defaultPrevented: boolean } | null; released: { source: number; readyState: number; handler: string; revision: number } | null };
type SyncWindow = typeof window & { __syncIncomingTrace: SyncTrace; __holdIncoming: boolean; __releaseIncoming: (() => void) | null };
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { loveSpotFixture }: { loveSpotFixture(options?: LoveSpotOptions): Promise<LoveSpotFixture> } = require('./love-spot-fixture.cts');

const output = path.join(os.homedir(), '.cache/elpis-tests/night-lovespot-sync');

// Clipboard Copy observes the actual editor through a user action, including
// the absence of a deleted element. Disk alone cannot prove renderer convergence.
async function copied(page: Page): Promise<SceneElement[]> {
  await page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('ControlOrMeta+c');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  try { return (JSON.parse(text) as Scene).elements.filter(e => !e.isDeleted); } catch { return []; }
}

for (const colorScheme of ['light'] as const) test(`two windows keep a real delete after a delayed equal-version live edit · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  let release: (() => void) | undefined, held: Scene | undefined;
  try {
    await fs.mkdir(output, { recursive: true });
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'initial shape did not save')).elements[0]; assert.ok(original);
    const stale = await f.newPage();
    // Freeze this client's event stream before it opens the board, so its real
    // keyboard edit and the other client's Delete share the same base version.
    await stale.route('**/api/love-spot/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: ': paused\n\n' }));
    await f.open(stale);
    await f.waitFor(async () => (await copied(stale))[0]?.id === original.id, 'second canvas did not load the original shape');
    const gate = new Promise<void>(resolve => { release = resolve; });
    await stale.route('**/api/love-spot', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const drawing = route.request().postDataJSON() as Scene;
      const live = drawing.elements.find(e => e.id === original.id && !e.isDeleted);
      if (!held && live) {
        held = drawing;
        await gate;
        // Nonces are random. Force the adversarial tie order without changing
        // the real keyboard-generated version or deletion flag.
        live.versionNonce = 0;
        return route.continue({ postData: JSON.stringify(drawing) });
      }
      return route.continue();
    });
    await stale.keyboard.press('ArrowRight');
    await f.waitFor(() => held, 'stale keyboard edit was not queued');
    await f.page.bringToFront();
    assert.equal((await copied(f.page))[0]?.id, original.id);
    await f.page.route('**/api/love-spot', route => {
      if (route.request().method() !== 'POST') return route.continue();
      const drawing = route.request().postDataJSON() as Scene;
      const deleted = drawing.elements.find(e => e.id === original.id && e.isDeleted);
      if (deleted) deleted.versionNonce = 2147483647;
      return route.continue({ postData: JSON.stringify(drawing) });
    });
    await f.page.keyboard.press('Delete');
    const deleted = (await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'real Delete did not save')).elements.find(e => e.id === original.id); assert.ok(deleted);
    const heldDrawing = held as Scene | undefined; assert.ok(heldDrawing); const heldShape = heldDrawing.elements.find(e => e.id === original.id); assert.ok(heldShape);
    assert.equal(heldShape.version, deleted.version, 'the eval must exercise an equal-version conflict');
    const saved = stale.waitForResponse(response => new URL(response.url()).pathname === '/api/love-spot' && response.request().method() === 'POST');
    assert.ok(release); release(); await saved;
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'delayed live save revived the delete');
    await stale.bringToFront();
    await f.waitFor(async () => (await copied(stale)).length === 0, 'the stale renderer ignored the winning tombstone');
    // Resume real synchronization and check that subsequent actions cannot
    // republish the stale shape from either window.
    await stale.unroute('**/api/love-spot/events?*');
    await stale.reload(); await stale.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open(stale);
    await f.draw(stale, 140);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1 && s.elements.find(e => e.id === original.id)?.isDeleted, 'next edit revived the deleted shape');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 1, 'surviving addition did not reach both windows');
    await f.page.keyboard.press('Escape');
    await f.page.screenshot({ path: path.join(output, `delete-${colorScheme}.png`) });
    await fs.writeFile(path.join(output, `conflict-${colorScheme}.json`), JSON.stringify({ original, deleted, delayed: heldDrawing.elements, final: (await f.scene()).elements }, null, 2));
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});

test('a legacy live snapshot cannot revive an equal-version local Delete while its save is pending', async () => {
  const f = await loveSpotFixture();
  let releaseLive: () => void = () => { throw Error('Live resolver missing'); }, releaseDelete: () => void = () => { throw Error('Delete resolver missing'); };
  const liveGate = new Promise<void>(resolve => { releaseLive = resolve; });
  const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
  let heldLive: Scene | undefined, heldDelete: Scene | undefined;
  try {
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'shape did not save')).elements.find(e => !e.isDeleted); assert.ok(original);
    const other = await f.newPage(); await f.open(other);
    await f.waitFor(async () => (await copied(other)).some(e => e.id === original.id), 'other canvas did not receive the shape');
    await other.route('**/api/love-spot', async route => {
      if (route.request().method() !== 'POST' || heldLive) return route.continue();
      const drawing = route.request().postDataJSON() as Scene;
      const live = drawing.elements.find(e => e.id === original.id && !e.isDeleted);
      if (!live) return route.continue();
      delete live.index; heldLive = drawing; await liveGate;
      return route.continue({ postData: JSON.stringify(drawing) });
    });
    await other.keyboard.press('ArrowRight');
    await f.waitFor(() => heldLive, 'live keyboard edit was not held');
    await f.page.bringToFront(); await copied(f.page);
    await f.page.route('**/api/love-spot', async route => {
      if (route.request().method() !== 'POST' || heldDelete) return route.continue();
      const drawing = route.request().postDataJSON() as Scene;
      if (!drawing.elements.some(e => e.id === original.id && e.isDeleted)) return route.continue();
      heldDelete = drawing; await deleteGate; return route.continue();
    });
    await f.page.keyboard.press('Delete');
    await f.waitFor(() => heldDelete, 'local Delete was not held');
    const live = heldLive as Scene | undefined, deleted = heldDelete as Scene | undefined; assert.ok(live && deleted);
    const liveShape = live.elements.find(e => e.id === original.id), deletedShape = deleted.elements.find(e => e.id === original.id); assert.ok(liveShape && deletedShape); assert.equal(liveShape.version, deletedShape.version);
    const published = other.waitForResponse(r => new URL(r.url()).pathname === '/api/love-spot' && r.request().method() === 'POST');
    releaseLive(); await published;
    await f.page.waitForTimeout(300); // Admit the published scene while Delete still awaits disk acknowledgement.
    assert.equal((await copied(f.page)).length, 0, 'repairing a missing layer index must not turn a stale live snapshot into a newer edit');
    releaseDelete();
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'Delete did not save');
    await f.waitFor(async () => (await copied(other)).length === 0, 'other canvas revived the winning deletion');
    assert.deepEqual(f.errors, []);
  } finally { releaseLive(); releaseDelete(); await f.close(); }
});

test('remote deletion is not a local undo step; deliberate delete undo and redo synchronize', async () => {
  const f = await loveSpotFixture();
  try {
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'initial shape did not save')).elements[0]; assert.ok(original);
    const other = await f.newPage(); await f.open(other);
    await f.waitFor(async () => (await copied(other))[0]?.id === original.id, 'second window did not load');
    await other.keyboard.press('Delete');
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'delete did not save');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 0, 'remote delete did not arrive');
    await f.page.keyboard.press('ControlOrMeta+z');
    await f.page.waitForTimeout(500);
    assert.equal((await f.scene()).elements.find(e => e.id === original.id)?.isDeleted, true, 'undo in the receiving window must not undo a remote deletion');
    assert.equal((await copied(f.page)).length, 0);
    await other.bringToFront();
    await other.keyboard.press('ControlOrMeta+z');
    await f.waitFor(s => !s.elements.find(e => e.id === original.id)?.isDeleted, 'deliberate undo did not restore');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).some(e => e.id === original.id), 'undo did not reach the other canvas');
    await other.bringToFront(); await other.keyboard.press('ControlOrMeta+Shift+z');
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'redo did not delete');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 0, 'redo did not reach the other canvas');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('placing a screenshot remains a deliberate local undo and redo action', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(f.screenshots, 'undo.png'), png);
    await f.page.getByRole('button', { name: 'Add undo.png to drawing', exact: true }).click();
    const scene = await f.waitFor(s => s.elements.some(e => e.type === 'image' && !e.isDeleted), 'placement did not save');
    const image = scene.elements.find(e => e.type === 'image'); assert.ok(image); const id = image.id;
    await f.page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
    await f.page.keyboard.press('ControlOrMeta+z');
    await f.waitFor(s => s.elements.find(e => e.id === id)?.isDeleted, 'undo could not remove the placed screenshot');
    await f.page.keyboard.press('ControlOrMeta+Shift+z');
    await f.waitFor(s => s.elements.some(e => e.id === id && !e.isDeleted) && Object.keys(s.files).length === 1, 'redo could not restore screenshot pixels');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('a remote delete inside a real embedded arrow-key batch stays outside Undo', async t => {
  const f = await loveSpotFixture();
  let other: Page | undefined, original: SceneElement | undefined, beforeArrow: object[] | undefined, lastVisible: object[] | undefined;
  const metadata = (elements: SceneElement[]) => elements.slice(0, 20).map(({ id, version, versionNonce, isDeleted, index, x, y }) => ({ id, version, versionNonce, isDeleted, index, x, y }));
  try {
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const shape = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'shape did not save')).elements.find(e => !e.isDeleted); assert.ok(shape); original = shape;
    const view = other = await f.newPage();
    await view.evaluate(() => {
      const target = window as SyncWindow, trace: SyncTrace = target.__syncIncomingTrace = { sources: 0, held: [], key: null, released: null };
      window.EventSource = class extends window.EventSource {
        constructor(...args: ConstructorParameters<typeof EventSource>) {
          super(...args);
          const source = ++trace.sources;
          this.addEventListener('message', event => {
            const data: { type: string; scene: Scene; revision: number } = JSON.parse(event.data);
            if (target.__holdIncoming && data.type === 'scene' && data.scene.elements.some(e => e.isDeleted)) {
              event.stopImmediatePropagation();
              trace.held.push({ source, readyState: this.readyState, revision: data.revision,
                elements: data.scene.elements.slice(0, 20).map(({ id, version, versionNonce, isDeleted, index, x, y }) => ({ id, version, versionNonce, isDeleted, index, x, y })) });
              if (trace.held.length > 8) trace.held.shift();
              target.__releaseIncoming = () => {
                trace.released = { source, readyState: this.readyState, handler: typeof this.onmessage, revision: data.revision };
                this.onmessage?.(event);
              };
            }
          });
        }
      };
    });
    await f.open(view);
    await f.waitFor(async () => {
      const elements = await copied(view); beforeArrow = metadata(elements);
      return elements.some(e => e.id === shape.id);
    }, 'receiver did not load the shape');
    await view.evaluate(() => { (window as SyncWindow).__holdIncoming = true; });
    await copied(f.page); await f.page.keyboard.press('Delete');
    await f.waitFor(s => s.elements.find(e => e.id === shape.id)?.isDeleted, 'delete did not save');
    await view.waitForFunction(() => typeof (window as SyncWindow).__releaseIncoming === 'function');
    await view.evaluate(() => window.addEventListener('keydown', event => {
      const target = window as SyncWindow; target.__syncIncomingTrace.key = { key: event.key, ...(event.target instanceof Element ? { target: event.target.tagName } : {}), defaultPrevented: event.defaultPrevented };
      if (event.key === 'ArrowRight') { target.__holdIncoming = false; if (!target.__releaseIncoming) throw Error('Release missing'); target.__releaseIncoming(); target.__releaseIncoming = null; }
    }, { once: true }));
    await view.bringToFront(); await view.keyboard.press('ArrowRight');
    assert.equal(await view.evaluate(() => (window as SyncWindow).__syncIncomingTrace.key?.key === 'ArrowRight' && !!(window as SyncWindow).__syncIncomingTrace.released), true, 'ArrowRight listener did not release the held deletion');
    await f.waitFor(async scene => {
      const elements = await copied(view); lastVisible = metadata(elements);
      // Replies may arrive while the deletion is held: only the target disappears, and other saved drawing stays.
      return scene.elements.find(e => e.id === shape.id)?.isDeleted === true
        && !elements.some(e => e.id === shape.id)
        && scene.elements.filter(e => !e.isDeleted).every(saved => elements.some(e => e.id === saved.id));
    }, 'receiver did not apply the deletion');
    await view.keyboard.press('ControlOrMeta+z'); await view.waitForTimeout(600);
    assert.equal((await f.scene()).elements.find(e => e.id === shape.id)?.isDeleted, true, 'Undo captured the remote deletion during the key batch');
    await f.page.keyboard.press('ControlOrMeta+z');
    await f.waitFor(s => !s.elements.find(e => e.id === shape.id)?.isDeleted, 'owner cannot undo its own delete');
  } catch (cause) {
    const gate = await other?.evaluate(() => ({ ...(window as SyncWindow).__syncIncomingTrace, focused: document.hasFocus(),
      activeElement: document.activeElement?.outerHTML.slice(0, 300) })).catch(error => ({ error: error.message }));
    const disk = await f.scene().then(scene => metadata(scene.elements)).catch(error => ({ error: error.message }));
    t.diagnostic(`arrow-key sync failure: ${JSON.stringify({ original: original && metadata([original])[0], beforeArrow, lastVisible, gate, disk, errors: f.errors.slice(-10) })}`);
    throw cause;
  } finally { await f.close(); }
});
