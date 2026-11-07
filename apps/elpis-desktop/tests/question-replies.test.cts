import type { TestContext } from 'node:test';
const { test }: typeof import('node:test') = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
type Bounds = { x: number; width: number };
type Locator = { locator(selector: string): Locator; nth(index: number): Locator; last(): Locator; getByText(text: string, options: object): Locator; getByRole(role: string, options: object): Locator; count(): Promise<number>; innerText(): Promise<string>; inputValue(): Promise<string>; waitFor(options?: object): Promise<void>; click(): Promise<void>; fill(text: string): Promise<void>; press(key: string): Promise<void>; evaluate<T>(fn: (node: Element) => T): Promise<T>; boundingBox(): Promise<Bounds | null> };
type Page = Locator & { screenshot(options: { path: string }): Promise<void>; waitForFunction(fn: () => boolean): Promise<void> };
type Post = { path: string; body: { text: string; beforeTurnId?: string } };
type Fixture = { page: Page; composer: Locator; errors: string[]; posts: Post[]; open(id: string): Promise<void>; close(): Promise<void>; copied(): Promise<string> };
type Options = { colorScheme?: string; chat?: string[][]; routes?: Record<string, () => object> };
const { fixture } = require('./parity-fixture.cjs') as { fixture(options: Options & { height: number }): Promise<Fixture> };

const first = {
  answer: 'Reusable agent instructions (Recommended)',
  question: 'For plug-and-play reuse, should the deliverable be instructions that an agent follows, or a callable program that invokes the agent?',
  questionItemId: '["request_user_input_async","call_eb0cdac965de4c438faaa1b0964fb41d",0]',
};
const second = { answer: 'فارسی، با مثال‌های کوتاه', question: 'ترجمه‌ها به چه زبانی باشند؟', questionItemId: '["request_user_input_async","call-fixture",1]' };
type Reply = typeof first;
const envelope = (value: Reply | Reply[]) => `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
const readable = (replies: Reply[]) => replies.map(({ question, answer }) => `${question}\n${answer}`).join('\n\n');
const noEnvelope = (value: string) => assert.doesNotMatch(value, /<send_user_message|\{|questionItemId|call_eb0cdac/);
async function using(t: TestContext, options: Options = {}) {
  const f = await fixture({ height: 960, ...options });
  t.after(() => f.close());
  await f.open('chat-a');
  return f;
}

for (const colorScheme of ['light']) test(`stored question replies show muted questions and answers without protocol text (${colorScheme})`, async t => {
  const f = await using(t, { colorScheme, chat: [
    ['single', envelope([first]), 'Instructions selected.'],
    ['batch', envelope([first, second]), 'Both answers received.'],
  ] });
  const bubbles = f.page.locator('.message.user');
  assert.equal(await bubbles.count(), 2);
  for (const [index, replies] of [[0, [first]], [1, [first, second]]] as [number, Reply[]][]) {
    const bubble = bubbles.nth(index);
    const shown = await bubble.innerText();
    noEnvelope(shown);
    for (const reply of replies) {
      await bubble.getByText(reply.question, { exact: true }).waitFor();
      await bubble.getByText(reply.answer, { exact: true }).waitFor();
      const question = bubble.getByText(reply.question, { exact: true });
      const answer = bubble.getByText(reply.answer, { exact: true });
      assert.notEqual(await question.evaluate(node => getComputedStyle(node).color), await answer.evaluate(node => getComputedStyle(node).color), 'the question is muted');
      const bounds = await bubble.boundingBox();
      const questionBounds = await question.boundingBox();
      if (!bounds || !questionBounds) throw new Error('Expected visible message and question');
      assert.ok(questionBounds.x >= bounds.x && questionBounds.x + questionBounds.width <= bounds.x + bounds.width + 1, 'question fits inside the message');
    }
  }
  await fs.mkdir('/tmp/a86-shots', { recursive: true });
  await f.page.screenshot({ path: `/tmp/a86-shots/question-replies-${colorScheme}.png` });
  assert.deepEqual(f.errors, []);
});

test('copy and edit use readable question replies; unchanged edits preserve the original payload', async t => {
  const raw = ` \n${envelope([first, second])}\n `;
  const f = await using(t, { chat: [['reply', raw, 'Both answers received.']], routes: {
    '/api/threads/chat-a/revert': () => ({ turn: { id: 'edited-turn' } }),
  } });
  const turn = f.page.locator('.user-turn');
  const expected = readable([first, second]);
  await turn.getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await f.copied(), expected);
  for (const name of ['Copy text', 'Copy as Markdown']) {
    await turn.getByRole('button', { name: 'More message actions', exact: true }).click();
    await f.page.getByRole('menuitem', { name, exact: true }).click();
    assert.equal(await f.copied(), expected);
  }
  await turn.getByRole('button', { name: 'Edit message', exact: true }).click();
  const edit = f.page.getByRole('textbox', { name: 'Edited message', exact: true });
  assert.equal(await edit.inputValue(), expected);
  await edit.fill('Cancelled revision');
  await edit.press('Escape');
  noEnvelope(await turn.innerText());
  assert.equal(f.posts.filter(post => post.path.endsWith('/revert')).length, 0);
  await turn.getByRole('button', { name: 'Edit message', exact: true }).click();
  await f.page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(f.posts.find(post => post.path.endsWith('/revert'))?.body, { beforeTurnId: 'reply', text: raw });
  assert.deepEqual(f.errors, []);
});

test('sending an envelope keeps the exact agent payload while the immediate message is readable', async t => {
  const f = await using(t, { chat: [['earlier', 'Earlier message', 'Earlier answer']] });
  const raw = envelope(first);
  await f.composer.fill(raw);
  await f.composer.press('Enter');
  await f.page.waitForFunction(() => { const composer = document.querySelector('textarea[aria-label="Message Elpis"]'); return composer instanceof HTMLTextAreaElement && !composer.value; });
  const sent = f.posts.find(post => post.path.endsWith('/turns'));
  assert.equal(sent?.body.text, raw);
  const bubble = f.page.locator('.message.user').last();
  noEnvelope(await bubble.innerText());
  await bubble.getByText(first.question, { exact: true }).waitFor();
  await bubble.getByText(first.answer, { exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});

test('an intentional edit sends the readable revised message', async t => {
  const f = await using(t, { chat: [['reply', envelope([first]), 'Instructions selected.']], routes: {
    '/api/threads/chat-a/revert': () => ({ turn: { id: 'edited-turn' } }),
  } });
  await f.page.locator('.user-turn').getByRole('button', { name: 'Edit message', exact: true }).click();
  const edit = f.page.getByRole('textbox', { name: 'Edited message', exact: true });
  assert.equal(await edit.inputValue(), readable([first]));
  const revised = `${first.question}\nA callable program instead.`;
  await edit.fill(revised);
  await f.page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(f.posts.find(post => post.path.endsWith('/revert'))?.body, { beforeTurnId: 'reply', text: revised });
  assert.deepEqual(f.errors, []);
});
