// Ported from dsh-superagent (MIT), tests/github-read.spec.ts
import { afterEach, it } from 'node:test';
import { expect } from 'expect';
import { ModuleMocker } from 'jest-mock';
const mocks = new ModuleMocker(globalThis)
import { Commands } from '../infra/commands.mts';
import { testDeployment } from '../infra/fixtures.mts';
import { readGithub, pullChecks } from './github-read.mts';

const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
afterEach(() => mocks.restoreAllMocks())

it('reads a bounded comment page and exposes the next page reference', async () => {
  const gh = mocks.spyOn(commands, 'gh').mockResolvedValue(Array.from({ length: 20 }, (_, id) => ({ id, body: 'comment' })))
  expect(await readGithub(commands, 'github/issues/123/comments/2')).toMatchObject({ next_resource: 'github/issues/123/comments/3' })
  expect(gh).toHaveBeenCalledWith(['api', 'repos/acme/widgets/issues/123/comments?per_page=20&page=2'])
})

it('rejects unsupported or escaping paths without making a request', async () => {
  const gh = mocks.spyOn(commands, 'gh')
  for (const resource of ['github/../outside', 'github/issues/1/reviews', 'github/pulls/1/checks/2', 'github/issues/1?repo=other']) {
    await expect(readGithub(commands, resource)).rejects.toThrow()
  }
  expect(gh).not.toHaveBeenCalled()
})

it('reads checks across pages and canonicalizes the latest status per context', async () => {
  mocks.spyOn(commands, 'gh').mockResolvedValue([{ check_runs: [{ name: 'z', status: 'completed', conclusion: 'success' }] }, { check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] }])
  mocks.spyOn(commands, 'pages').mockResolvedValue([{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }])
  const result = await pullChecks(commands, 'abc')
  expect(result.checks.map((check: { name: string }) => check.name)).toEqual(['a', 'z'])
  expect(result.statuses).toEqual([{ context: 'build', state: 'success' }])
})

it('reads any requested PR’s CI on demand without restricting the author', async () => {
  const gh = mocks.spyOn(commands, 'gh').mockResolvedValueOnce({ head: { sha: 'abc' }, user: { login: 'another-author' } }).mockResolvedValueOnce([{ check_runs: [] }])
  mocks.spyOn(commands, 'pages').mockResolvedValue([])
  expect(await readGithub(commands, 'github/pulls/123/checks')).toEqual({ head: 'abc', checks: [], statuses: [] })
  expect(gh).toHaveBeenCalledTimes(2)
})

/** Fake GitHub REST API pull request review comment payload. */
const reviewComment = (id: number, reply?: number) => ({ id, url: `https://api.github.com/repos/acme/widgets/pulls/comments/${id}`,
  pull_request_review_id: 77, node_id: 'PRRC_x', path: 'src/render.ts', line: 43, original_line: 43, side: 'RIGHT', commit_id: 'abc',
  diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8',
  user: { login: id === 2 ? 'review-bot[bot]' : 'carol', id: 5, type: id === 2 ? 'Bot' : 'User', avatar_url: 'https://avatars/5', html_url: 'https://github.com/carol' },
  body: `comment ${id}`, created_at: `2026-09-09T00:00:0${id}Z`, updated_at: `2026-09-09T00:00:0${id}Z`,
  html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`, author_association: 'MEMBER', reactions: { total_count: 0 },
  _links: { self: { href: 'x' } }, ...reply ? { in_reply_to_id: reply } : {} })
it('reads a page of review comments as messages: id, author, time, text, the comment each answers, and the file and line', async () => {
  mocks.spyOn(commands, 'gh').mockResolvedValue([reviewComment(1), reviewComment(2, 1)])
  expect(await readGithub(commands, 'github/pulls/9/comments/1')).toEqual({ messages: [
    { id: '1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'comment 1', url: 'https://github.com/acme/widgets/pull/9#discussion_r1',
      path: 'src/render.ts', line: 43 },
    { id: '2', from: 'review-bot[bot]', at: '2026-09-09T00:00:02Z', text: 'comment 2', bot: true, reply_to: '1',
      url: 'https://github.com/acme/widgets/pull/9#discussion_r2', path: 'src/render.ts', line: 43 }] })
})
it('reads a review thread from any of its comments, the first with its file, line and diff lines', async () => {
  mocks.spyOn(commands, 'pages').mockResolvedValue([reviewComment(3), reviewComment(2, 1), reviewComment(1), reviewComment(4, 3)].map(item => ({
    ...item, user: { login: item.user.login, type: item.user.type } })))
  const thread = await readGithub(commands, 'github/pulls/9/thread/2') as { messages: { id: string; text: string; reply_to?: string }[] }
  expect(thread.messages.map(message => [message.id, message.reply_to])).toEqual([['1', undefined], ['2', '1']])
  expect(thread.messages[0]!.text).toBe('src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1')
  await expect(readGithub(commands, 'github/issues/9/thread/2')).rejects.toThrow('require a pull request')
})
it('reads an Issue or PR as its author, time, title, state, description and a PR\'s branches', async () => {
  mocks.spyOn(commands, 'gh').mockResolvedValue({ number: 9, id: 1, title: 'Fix the margin', state: 'open', body: 'Details', draft: true,
    user: { login: 'carol', type: 'User' }, created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/9',
    head: { ref: 'agent/fix', sha: 'abc', repo: {} }, base: { ref: 'main' }, labels: [{ name: 'ui', color: 'fff' }], node_id: 'x', _links: {} })
  expect(await readGithub(commands, 'github/pulls/9')).toEqual({ number: 9, title: 'Fix the margin', state: 'open', draft: true, head: 'agent/fix',
    base: 'main', labels: ['ui'], id: '9', from: 'carol', at: '2026-09-09T00:00:00Z', text: 'Details', url: 'https://github.com/acme/widgets/pull/9' })
})
