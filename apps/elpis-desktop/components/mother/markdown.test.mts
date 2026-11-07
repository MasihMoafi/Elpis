// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/markdown.spec.ts.
import { it } from 'node:test'
import { expect } from 'expect'
import { inlines, linkify, markdownBlocks } from './markdown.ts'

it('reads headings, paragraphs and lists, a list ending at a blank line or at an item of the other kind', () => {
  expect(markdownBlocks('# Plan\nFirst line\n- a\n- b\n\n- c\n1. d\n\n')).toEqual([{ kind: 'heading', text: 'Plan' },
    { kind: 'paragraph', text: 'First line' }, { kind: 'list', ordered: false, items: ['a', 'b'] }, { kind: 'list', ordered: false,
      items: ['c'] }, { kind: 'list', ordered: true, items: ['d'] }])
})

it('reads bold, inline code and links, and shows a bare address by its host and a short path', () => {
  const log = 'https://ci.example.com/runs/123456789012345678901234/log'
  expect(inlines(`**Done**: \`npm test\` in [the PR](https://github.com/acme/widgets/pull/42), log at ${log}`))
    .toEqual([{ kind: 'bold', text: 'Done' }, { kind: 'text', text: ': ' }, { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' in ' }, { kind: 'link', text: 'the PR', url: 'https://github.com/acme/widgets/pull/42' },
      { kind: 'text', text: ', log at ' },
      { kind: 'link', text: 'ci.example.com/runs/123456789012345678…', url: log }])
  expect(linkify('<b>**not bold**</b>')).toEqual([{ kind: 'text', text: '<b>**not bold**</b>' }])
})

it('keeps a link to anything but a web address as text, and leaves the punctuation after a bare address out of it', () => {
  for (const text of ['[x](javascript:alert(1))', '[x](data:text/html,<b>hi</b>)']) {
    expect(inlines(text).every(part => part.kind === 'text')).toBe(true)
    expect(inlines(text).map(part => part.text).join('')).toBe(text)
  }
  expect(linkify('See https://example.com/a. Then (https://example.com/b) and https://example.com/c?')).toEqual([
    { kind: 'text', text: 'See ' }, { kind: 'link', text: 'example.com/a', url: 'https://example.com/a' }, { kind: 'text', text: '. Then (' },
    { kind: 'link', text: 'example.com/b', url: 'https://example.com/b' }, { kind: 'text', text: ') and ' },
    { kind: 'link', text: 'example.com/c', url: 'https://example.com/c' }, { kind: 'text', text: '?' }])
})
