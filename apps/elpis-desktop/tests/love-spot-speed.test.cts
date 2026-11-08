// Masih, 29 Oct: "love-spot, in the chat, is too slow. it waited for like 4 or more minutes and it was doing nothing" (the
// board and Matilda's small chat). A chat sends its whole history with every request, and her chat carried the board's
// picture from every turn: 30 pictures, 5.4 MB of the 7.6 MB each request uploaded, where an ordinary chat of the same
// length uploads its text. Here the stand-in provider waits for what the chat carries, as his connection did. An ordinary
// chat's message adds a few hundred bytes, so its wait hardly grows; hers must not grow by pictures while the drawing is
// unchanged, and a new drawing must still reach her. The small chat asks once a second while she writes: 1.5 s of slack.
import type { LoveSpotFixture, LoveSpotOptions, Turn } from './love-spot-test-types.mts';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { loveSpotFixture }: { loveSpotFixture(options: LoveSpotOptions): Promise<LoveSpotFixture> } = require('./love-spot-fixture.cts');

// His link at 06:59 UTC on 29 Oct: the Love Spot request (7.6 MB) took 208 s before its first token, about 36 kB/s.
const RATE = 36000;
const carried = (turn: Turn) => Buffer.byteLength(turn.text) + (turn.attachments ?? []).reduce((sum, a) => sum + Buffer.byteLength(a.text ?? a.dataUrl ?? ''), 0);
const pictured = (turn: Turn) => (turn.attachments ?? []).some(a => a.type === 'image');
/** The provider: its first reply waits until everything this chat carries has been uploaded at RATE. */
function uplink() {
  const model = { waits: [] as number[], bytes: [] as number[] };
  const delay = (turns: Turn[]) => {
    const last = turns.at(-1); assert.ok(last);
    const bytes = turns.filter(turn => turn.id === last.id).reduce((sum, turn) => sum + carried(turn), 0);
    const wait = Math.round(bytes / RATE * 1000);
    model.bytes.push(bytes); model.waits.push(wait); return wait;
  };
  return Object.assign(model, { delay });
}
async function note(f: LoveSpotFixture, text: string, at = { x: 450, y: 300 }) {
  const bounds = await f.page.locator('.excalidraw').boundingBox();
  assert.ok(bounds);
  await f.page.mouse.click(bounds.x + at.x, bounds.y + at.y); await f.page.keyboard.press('t');
  await f.page.mouse.click(bounds.x + at.x, bounds.y + at.y); await f.page.keyboard.type(text); await f.page.keyboard.press('Escape');
  return f.waitFor(s => s.elements.some(e => e.text === text), 'typed note was not saved')
    .catch(async e => { await f.page.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'lovespot-note-failure.png') }); throw e; });
}

test('the small chat: her reply starts as soon at the fourth message as at the first while the drawing is unchanged', { timeout: 240000 }, async t => {
  const model = uplink(), f = await loveSpotFixture({ replyDelay: model.delay });
  t.after(() => f.close());
  const page = f.page;
  await f.open(page); await f.draw(page, 300);
  await f.waitFor(s => s.elements.some(e => e.type === 'rectangle' && !e.isDeleted), 'the drawing was not saved');
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true }), field = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });
  const replies = mini.locator('.matilda-mini-message[data-speaker="matilda"]'), took = [];
  for (let n = 1; n <= 4; n++) {
    // The picture is exported after each change; she is asked once it shows the board as it stands.
    await page.waitForTimeout(1200);
    await field.fill(`Message ${n}`); const start = Date.now(); await field.press('Enter');
    await page.waitForFunction(count => document.querySelectorAll('.matilda-mini-message[data-speaker="matilda"]').length >= count, n, { timeout: 90000 })
      .catch(async (e: Error) => { throw new Error(`${e.message}; turns ${f.turns.length}, waits ${model.waits}; small chat: ${(await mini.innerText().catch(() => 'gone')).slice(0, 400)}`); });
    took.push(Date.now() - start);
  }
  t.diagnostic(`send to reply shown, ms: ${took.join(', ')}; provider waits, ms: ${model.waits.join(', ')}; bytes carried: ${model.bytes.join(', ')}; pictures: ${f.turns.map(pictured).join(', ')}`);
  assert.equal(await replies.count(), 4);
  const firstTurn = f.turns[0], firstTime = took[0], fourthTime = took[3];
  assert.ok(firstTurn && firstTime !== undefined && fourthTime !== undefined);
  assert.ok(pictured(firstTurn), 'the first message shows her the board');
  assert.ok(fourthTime <= firstTime + 1500, `the fourth reply took ${took[3]} ms, the first ${took[0]} ms`);
  assert.deepEqual(f.errors, []);
});

test('the board: her reply starts as soon at the third note as at the first, and a new drawing still reaches her', { timeout: 240000 }, async t => {
  const model = uplink(), f = await loveSpotFixture({ replyDelay: model.delay });
  t.after(() => f.close());
  await f.open(f.page); await f.draw(f.page, 300);
  const took = [];
  // Her reply lands under his note: each note gets room of its own.
  for (let n = 1; n <= 3; n++) {
    await note(f, `Note ${n}`, { x: 300, y: 100 + 230 * (n - 1) }); const start = Date.now();
    await f.waitFor(s => s.elements.some(e => e.id === `love-reply-turn-${n}` && !e.isDeleted), `note ${n} was not answered`, 90000);
    took.push(Date.now() - start);
  }
  t.diagnostic(`note saved to reply on the board, ms: ${took.join(', ')}; provider waits, ms: ${model.waits.join(', ')}; bytes carried: ${model.bytes.join(', ')}`);
  const firstTime = took[0], thirdTime = took[2]; assert.ok(firstTime !== undefined && thirdTime !== undefined);
  assert.ok(thirdTime <= firstTime + 1500, `the third reply took ${took[2]} ms, the first ${took[0]} ms`);
  // He draws again: she must see it.
  await f.draw(f.page, 380); await note(f, 'What about this one?', { x: 1000, y: 100 });
  await f.waitFor(() => f.turns.length === 4, 'the new drawing was not answered', 60000);
  const latest = f.turns[3]; assert.ok(latest);
  assert.ok(pictured(latest), 'a changed drawing goes with the next message');
  assert.match(latest.text, /I drew something on the board/);
  assert.deepEqual(f.errors, []);
});
