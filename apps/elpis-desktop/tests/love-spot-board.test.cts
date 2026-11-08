import type { LoveSpotFixture, LoveSpotOptions, SceneElement, Turn } from './love-spot-test-types.mts';
// Love Spot's board is where Matilda answers (Masih, 23 Oct: "I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda."):
// what reaches her, where her reply lands, and the board's own microphone. Her face, her painting and who she is: tests/matilda.test.cts.
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { loveSpotFixture }: { loveSpotFixture(options?: LoveSpotOptions): Promise<LoveSpotFixture> } = require('./love-spot-fixture.cts');


// Her reply no longer zooms the board (5 Nov), so a second note goes to its own empty spot, not onto the first.
async function note(f: LoveSpotFixture, text: string, { x = 450, y = 300 } = {}) {
  const bounds = await f.page.locator('.excalidraw').boundingBox(); assert.ok(bounds);
  await f.page.mouse.click(bounds.x + x, bounds.y + y); await f.page.keyboard.press('t');
  await f.page.mouse.click(bounds.x + x, bounds.y + y); await f.page.keyboard.type(text); await f.page.keyboard.press('Escape');
  return f.waitFor(s => s.elements.some(e => e.text === text), 'typed note was not saved');
}

const turn = (fixture: LoveSpotFixture, index: number): Turn => { const value = fixture.turns[index]; assert.ok(value); return value; };
const attachmentText = (value: Turn, type: 'text' | 'image') => { const item = value.attachments.find(part => part.type === type); assert.ok(item); const text = type === 'text' ? item.text : item.dataUrl; assert.ok(text); return text; };
const box = (element: SceneElement) => { const { x, y, width, height } = element; assert.ok(x !== undefined && y !== undefined && width !== undefined && height !== undefined); return { x, y, width, height }; };
const clear = (first: SceneElement, second: SceneElement) => { const a = box(first), b = box(second); return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y; };
const unit = (e: SceneElement) => e.groupIds?.at(-1) ?? e.id;
test('a drawing waits quietly for its picture and is retried after leaving and returning', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let notices = 0;
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON();
      if (body.drawingOnly && ++notices === 1) return route.fulfill({ json: { voice: { enabled: false }, waitingForPicture: true } });
      return route.fallback();
    });
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(() => notices === 1, 'the drawing did not wait for a picture', 20000);
    await f.page.waitForTimeout(1000);
    assert.equal(notices, 1, 'waiting does not repeatedly send the notice');
    assert.equal(f.turns.length, 0, 'there is no reply while the picture is unavailable');
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.open(f.page);
    await f.waitFor(() => f.turns.length === 1, 'the waiting drawing was lost on leaving', 20000);
    assert.ok(turn(f, 0).attachments.some(a => a.type === 'image'), 'the retried drawing includes its picture');
  } finally { await f.close(); }
});
test('returning while an older handover is still in flight does not send the drawing twice', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let held = false, released: () => void = () => { throw Error('Release resolver missing'); };
  const gate = new Promise<void>(resolve => { released = resolve; });
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST' || held || !route.request().postDataJSON().drawingOnly) return route.fallback();
      held = true; await gate;
      await route.fulfill({ json: { voice: { enabled: false }, waitingForPicture: true } }).catch(() => {});
    });
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(() => held, 'the first handover did not start', 20000);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.open(f.page); await f.page.waitForTimeout(1000);
    assert.equal(f.turns.length, 0, 'the new visit waits for the older handover');
    released(); await f.waitFor(() => f.turns.length === 1, 'the drawing did not resume', 20000);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.open(f.page); await f.page.waitForTimeout(1000);
    assert.equal(f.turns.length, 1, 'the late reply did not restore an already-sent drawing');
  } finally { released(); await f.close(); }
});
test('editing a note during an older handover keeps the newer words', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let held = false, released: () => void = () => { throw Error('Release resolver missing'); };
  const gate = new Promise<void>(resolve => { released = resolve; });
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST' || held) return route.fallback();
      const response = await route.fetch(); held = true; await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await f.open(f.page); await note(f, 'Original thought');
    await f.waitFor(() => held && f.turns.length === 1, 'the first handover did not start', 20000);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.open(f.page);
    const bounds = await f.page.locator('.excalidraw').boundingBox(); assert.ok(bounds);
    await f.page.mouse.dblclick(bounds.x + 455, bounds.y + 305);
    const editor = f.page.locator('textarea.excalidraw-wysiwyg'); await editor.waitFor();
    await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.type('Revised thought'); await f.page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.text === 'Revised thought'), 'the revised note did not save', 20000);
    released(); await f.waitFor(() => f.turns.length === 2, 'the new words were lost', 20000);
    assert.match(turn(f, 1).text, /Revised thought/);
  } finally { released(); await f.close(); }
});
test('a waiting drawing is retried when Matilda changes model', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let notices = 0;
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON();
      if (body.drawingOnly && ++notices === 1) return route.fulfill({ json: { voice: { enabled: false }, waitingForPicture: true } });
      return route.fallback();
    });
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(() => notices === 1, 'the drawing did not wait', 20000);
    const model = f.page.getByRole('group', { name: "Matilda's model" }).getByRole('combobox');
    await model.click(); await f.page.getByRole('option', { name: /GPT-6-Luna/ }).click();
    await f.waitFor(() => f.turns.length === 1, 'changing model did not retry the drawing', 20000);
    assert.equal(turn(f, 0).model, 'luna');
    assert.ok(turn(f, 0).attachments.some(a => a.type === 'image'));
  } finally { await f.close(); }
});
test('changing model while a drawing handover is still in flight retries it', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let held = false, released: () => void = () => { throw Error('Release resolver missing'); };
  const gate = new Promise<void>(resolve => { released = resolve; });
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST' || held || !route.request().postDataJSON().drawingOnly) return route.fallback();
      held = true; await gate;
      await route.fulfill({ json: { voice: { enabled: false }, waitingForPicture: true } }).catch(() => {});
    });
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(() => held, 'the drawing handover did not start', 20000);
    const model = f.page.getByRole('group', { name: "Matilda's model" }).getByRole('combobox');
    await model.click(); await f.page.getByRole('option', { name: /GPT-6-Luna/ }).click();
    released();
    await f.waitFor(() => f.turns.length === 1, 'the in-flight drawing was not retried', 20000);
    assert.equal(turn(f, 0).model, 'luna');
    assert.ok(turn(f, 0).attachments.some(a => a.type === 'image'));
  } finally { released(); await f.close(); }
});
test('turning replies off during a handover does not resurrect that drawing', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let held = false, released: () => void = () => { throw Error('Release resolver missing'); };
  const gate = new Promise<void>(resolve => { released = resolve; });
  try {
    await f.open(f.page);
    await f.page.route('**/api/love-spot/picture', async route => {
      if (held) return route.fallback();
      held = true; await gate; await route.continue().catch(() => {});
    });
    await f.draw(f.page); await f.waitFor(() => held, 'the picture handover did not start', 20000);
    const replies = f.page.getByRole('switch', { name: 'Matilda', exact: true });
    await replies.click(); assert.equal(await replies.getAttribute('aria-checked'), 'false');
    released(); await f.page.waitForTimeout(1000);
    await replies.click(); assert.equal(await replies.getAttribute('aria-checked'), 'true');
    await f.page.waitForTimeout(1200);
    assert.equal(f.turns.length, 0, 'the disabled batch stayed cleared');
  } finally { released(); await f.close(); }
});

test('a failed handover keeps a written note for the next visit', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let refused = false;
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() === 'POST' && !refused) { refused = true; return route.fulfill({ status: 503, json: { error: 'Test handover failure' } }); }
      return route.fallback();
    });
    await f.open(f.page); await note(f, 'Keep this thought for later');
    await f.waitFor(() => refused, 'the handover was not interrupted', 20000);
    await f.page.waitForTimeout(500);
    assert.equal(f.turns.length, 0);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.open(f.page);
    await f.waitFor(() => f.turns.length === 1, 'the failed note was lost', 20000);
    assert.match(turn(f, 0).text, /Keep this thought for later/);
  } finally { await f.close(); }
});
test('a note stays pending if its handover fails after leaving the board', { timeout: 60000 }, async () => {
  const f = await loveSpotFixture(); let held = false, released: () => void = () => { throw Error('Release resolver missing'); };
  const gate = new Promise<void>(resolve => { released = resolve; });
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'POST' || held) return route.fallback();
      held = true; await gate;
      await route.fulfill({ status: 503, json: { error: 'Test handover failure' } }).catch(() => {});
    });
    await f.open(f.page); await note(f, 'Keep this thought after I leave');
    await f.waitFor(() => held, 'the handover did not start', 20000);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    released(); await f.page.waitForTimeout(500);
    await f.open(f.page);
    await f.waitFor(() => f.turns.length === 1, 'the note was lost after leaving', 20000);
    assert.match(turn(f, 0).text, /Keep this thought after I leave/);
  } finally { released(); await f.close(); }
});
test('what he writes reaches her with the board and its picture and the main model; her black reply lands clear of everything; the sidebar chat is one and says its origin once', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await note(f, 'The secret is apricot');
    const saved = await f.waitFor(s => s.elements.some(e => e.id === 'love-reply-turn-1' && !e.isDeleted), 'reply did not land on the board', 20000);
    const answer = saved.elements.find(e => e.id === 'love-reply-turn-1'); assert.ok(answer); assert.equal(answer.text, 'I am here with you.'); assert.equal(answer.strokeColor, '#000000');
    assert.equal(f.chats.length, 1); const chat = f.chats[0]; assert.ok(chat); assert.equal(chat.name, 'Love Spot'); assert.equal(chat.cwd, f.directory);
    await f.page.locator('aside [data-thread-id="love-chat"] .thread-title').filter({ hasText: 'Matilda' }).waitFor();
    assert.deepEqual(await f.page.locator('aside [data-thread-id="love-chat"] .thread-link').allInnerTexts(), ['Matilda'], 'the Love Spot group names the origin and its chat names the character');
    assert.equal(turn(f, 0).model, 'sol', 'she answers with the main model'); assert.match(attachmentText(turn(f, 0), 'text'), /Masih.*The secret is apricot/s);
    assert.match(attachmentText(turn(f, 0), 'image'), /^data:image\/png;base64,/);
    for (const e of saved.elements.filter(e => !e.isDeleted && unit(e) !== unit(answer))) assert.ok(clear(answer, e), `her reply overlaps ${e.id}`);
    await f.page.reload(); await f.open(f.page); await note(f, 'Do you remember?');
    await f.waitFor(() => f.turns.length === 2, 'the second note was not answered', 20000);
    assert.equal(f.chats.length, 1); assert.match(attachmentText(turn(f, 1), 'text'), /agent.*I am here with you/s, 'the same chat, and she sees her own earlier reply');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a reply reaches the board after navigating away', async () => {
  const f = await loveSpotFixture({ replyDelay: 700 });
  try {
    await f.open(f.page); await note(f, 'Still here when you return');
    await f.page.waitForResponse(response => response.url().endsWith('/api/love-spot/talk') && response.request().method() === 'POST', { timeout: 20000 });
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'I am here with you.'), 'navigation lost the reply');
    await f.page.locator('.nav-list .love-unread').waitFor();
    assert.match(attachmentText(turn(f, 0), 'text'), /Still here when you return/);
    await f.open(f.page); assert.equal(f.chats.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Matilda recovers from a failed busy poll and answers later board notes', async () => {
  const f = await loveSpotFixture({ replyDelay: 2500 });
  let sawBusy = false, refused = false;
  try {
    await f.page.route('**/api/love-spot/talk', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (sawBusy && !refused) { refused = true; return route.fulfill({ status: 503, json: { error: 'Temporarily disconnected' } }); }
      const response = await route.fetch(), state = await response.json();
      if (state.busy) sawBusy = true;
      await route.fulfill({ response });
    });
    await f.open(f.page); await note(f, 'First thought before the connection wavers');
    await f.waitFor(() => refused, 'the busy poll was not interrupted', 20000);
    await f.waitFor(s => s.elements.some(e => e.id === 'love-reply-turn-1'), 'the first reply was not saved');
    await f.page.getByText('Matilda is writing…', { exact: true }).waitFor({ state: 'hidden', timeout: 8000 });
    await note(f, 'A later thought after reconnecting', { x: 700, y: 560 });
    await f.waitFor(() => f.turns.length === 2, 'a failed poll left later notes blocked', 20000);
    assert.match(attachmentText(turn(f, 1), 'text'), /A later thought after reconnecting/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 27 Oct: a note written just before leaving Love Spot was never answered; the board unmounted and its pending note was lost.
test('a note written just before leaving Love Spot still reaches Matilda once', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await note(f, 'A thought before I leave');
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(() => f.turns.length === 1, 'the note written before leaving never reached her', 20000);
    assert.match(attachmentText(turn(f, 0), 'text'), /A thought before I leave/);
    await f.open(f.page); await f.page.waitForTimeout(6000);
    assert.equal(f.turns.length, 1, 'returning to the board does not send it again');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 5 Nov (CI): leaving while the board was still handing her the note (saving its picture) lost it: the hand-over gave up
// once the board unmounted, and the leave step left the note to that hand-over.
test('a note left while the board is still handing it over reaches Matilda once', async () => {
  const f = await loveSpotFixture();
  try {
    let slow = false, held = 0;
    await f.page.route('**/api/love-spot/picture', async route => { if (slow) { held++; await new Promise(resolve => setTimeout(resolve, 2500)); } await route.continue().catch(() => {}); });
    await f.open(f.page);
    slow = true;
    await note(f, 'Said on the way out');
    await f.waitFor(() => held > 0, 'the hand-over never started', 10000);
    await f.page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(() => f.turns.length === 1, 'the note left mid hand-over never reached her', 20000);
    assert.match(attachmentText(turn(f, 0), 'text'), /Said on the way out/);
    slow = false; await f.open(f.page); await f.page.waitForTimeout(6000);
    assert.equal(f.turns.length, 1, 'returning to the board does not send it again');
  } finally { await f.close(); }
});

test('the Matilda replies switch keeps her quiet while he draws, and she answers what waited once it is on', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    const replies = f.page.getByRole('switch', { name: 'Matilda', exact: true });
    await replies.waitFor();
    assert.equal(await replies.getAttribute('aria-checked'), 'true', 'replies are on by default');
    await replies.click();
    assert.equal(await replies.getAttribute('aria-checked'), 'false');
    await note(f, 'Drawing for you, stay quiet');
    await f.page.waitForTimeout(4000);
    assert.equal(f.turns.length, 0, 'with replies off she sends nothing while he draws');
    await f.page.reload(); await f.open(f.page);
    assert.equal(await f.page.getByRole('switch', { name: 'Matilda', exact: true }).getAttribute('aria-checked'), 'false', 'the choice survives a reload');
    await f.page.getByRole('switch', { name: 'Matilda', exact: true }).click();
    await f.waitFor(() => f.turns.length === 1, 'turning replies on did not release the waiting note', 20000);
    assert.match(attachmentText(turn(f, 0), 'text'), /Drawing for you, stay quiet/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
