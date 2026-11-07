// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/prompts.spec.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { expect } from 'expect'
import { Store } from './store.mts'
import { Prompts, builtInBase, composePrompt, defaultPrompts, policySection, promptParts, type PromptConfig } from './prompts.mts'
import { USER_ERRORS, UserError } from '../core/index.mts'
import { KV } from '../sources/kv.mts'
import { SettingsSchema, policyVersion } from '../policy.mts'
import { guides, handoffPolicy, mainAdmissionPolicy, masterPrompt, sharedPrompt, workerPrompt } from './context.mts'
import { promptFile } from './skill-files.mts'
import { packagePath } from '../infra/paths.mts'
import type { Variable } from '../executor/execution-environment.mts'

/** The execution environment outside any ticket, as the runtime passes it once setup has finished. */
const variables = (): Variable[] => [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', value: 'acme/widgets', description: { zh: '仓库', en: 'The repository' }, owner: 'github' }]
const ENVIRONMENT_LINE = '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets": The repository.'
const promptsOf = (store: Store, maxChars = 100000) => new Prompts(store, () => maxChars, variables, () => true)
function withStore(body: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-')); const store = new Store(join(dir, 'db'))
  try { body(store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('saves team sections and skills as versions that survive a restart, with history and rollback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-config-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = promptsOf(store)
    expect(prompts.current().config).toEqual(defaultPrompts())
    const config = { ...defaultPrompts(), scope: 'Finish what was asked.', delivery: '', skills: { release: 'Tag releases on Fridays.' } }
    prompts.save(config, 0, 'panel')
    expect(composePrompt(prompts.current().config, 'worker')).toContain('## Ticket scope\nFinish what was asked.')
    // An empty team section leaves the prompt; the fixed sections stay.
    expect(promptParts(config, 'worker').map(part => part.name)).not.toContain('delivery')
    expect(store.get('settings-revision')).toBeUndefined()
    store.close(); store = new Store(join(dir, 'db')); prompts = promptsOf(store)
    expect(prompts.current()).toMatchObject({ revision: 1, config })
    prompts.save(prompts.version(0).config, 1, 'tool')
    expect(prompts.current()).toMatchObject({ revision: 2, previousRevision: 1, config: defaultPrompts() })
    expect(prompts.history(0, 1)).toMatchObject({ revisions: [{ revision: 2 }], next_offset: 1 })
    expect(prompts.history(2, 1).next_offset).toBeNull()
    expect(prompts.history(1, 1).revisions[0]).toMatchObject({ revision: 1, changed: ['scope', 'delivery', 'skill/release'] })
    expect(() => prompts.save(config, 1, 'panel')).toThrow('version changed')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('assembles every role from fixed sections around the team sections, whatever the configuration says', () => {
  const config = { communication: 'Say little.', scope: '', delivery: 'Attach screenshots.', skills: {} }
  for (const role of ['orchestrator', 'worker'] as const) {
    const names = promptParts(config, role, 'env').map(part => part.name)
    expect(names).toEqual(['runtime/shared', `runtime/${role}`, 'communication', 'delivery', 'runtime/subscriptions', 'runtime/replies', role === 'orchestrator' ? 'runtime/dispatch' : 'runtime/work', ...role === 'orchestrator' ? ['runtime/admission'] : [], 'runtime/handoff', 'runtime/environment'])
    const prompt = composePrompt(config, role)
    for (const fixed of [sharedPrompt, role === 'orchestrator' ? masterPrompt : workerPrompt, guides.subscriptions!, guides.replies!, handoffPolicy(role)]) expect(prompt).toContain(fixed)
    expect(prompt.endsWith(handoffPolicy(role))).toBe(true)
  }
  expect(composePrompt(config, 'orchestrator')).toContain(mainAdmissionPolicy)
  expect(composePrompt(config, 'worker')).not.toContain(mainAdmissionPolicy)
})

it('reads a prompt file whatever its line ends and blank lines, and names a missing or empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-file-'))
  // promptFile resolves paths relative to prompts/; use a relative path to reach the temp dir.
  const name = (file: string) => relative(packagePath('bridge', 'router', 'prompts'), join(dir, file))
  try {
    writeFileSync(join(dir, 'crlf.md'), 'One.\r\nTwo. \r\n \t\r\n\r\nThree.\r\n')
    writeFileSync(join(dir, 'blank.md'), ' \n\t\n')
    expect(promptFile(name('crlf'))).toBe('One. Two.\nThree.')
    expect(() => promptFile(name('blank'))).toThrow(`Empty packaged file: ${join(dir, 'blank.md')}`)
    expect(() => promptFile(name('absent'))).toThrow(`Missing packaged file: ${join(dir, 'absent.md')}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('leaves the UI before-and-after evidence to the delivery requirements, which a team can change', () => {
  const config = { ...defaultPrompts(), delivery: 'Only capture the finished screen.' }
  for (const role of ['orchestrator', 'worker'] as const) expect(composePrompt(config, role)).not.toContain('Before and After visual evidence')
})

for (const role of ['orchestrator', 'worker'] as const) it('ends the %s prompt with the fixed handoff rules and the execution environment, and the main Session\'s with its Policy', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    const preview = prompts.preview(defaultPrompts())
    expect(promptParts(defaultPrompts(), role).at(-1)).toEqual({ name: 'runtime/handoff', kind: 'fixed', key: `runtime/handoff/${role}`,
      text: handoffPolicy(role) })
    expect(preview[role]).toBe(prompts.compose(defaultPrompts(), role))
    expect(preview[role]).toContain(`${handoffPolicy(role)}\n\nExecution environment`)
    if (role === 'worker') expect(preview[role].endsWith(ENVIRONMENT_LINE)).toBe(true)
    // Nothing follows the main Session's Policy section, so a Policy change leaves the rest of its prompt as it was.
    else expect(preview[role].endsWith(`${ENVIRONMENT_LINE}\n\n${policySection(store.settings()).text}`)).toBe(true)
    expect(preview.parts[role].at(-1)!.name).toBe(role === 'orchestrator' ? 'runtime/policy' : 'runtime/environment')
  })
})

it('rejects unknown keys, built-in skill names and oversized configuration before persisting', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    expect(() => prompts.save({ ...defaultPrompts(), shared: 'x' }, 0, 'panel')).toThrow()
    expect(() => prompts.save({ communication: '', scope: '' }, 0, 'panel')).toThrow()
    for (const name of ['github', 'elpis-chat']) expect(() => prompts.save({ ...defaultPrompts(), skills: { [name]: 'mine' } }, 0, 'panel')).toThrow('built-in skill')
    expect(() => prompts.save({ ...defaultPrompts(), skills: { 'Bad Name': 'x' } }, 0, 'panel')).toThrow()
    expect(() => promptsOf(store, 1000).save(defaultPrompts(), 0, 'panel')).toThrow('exceeds')
    expect(prompts.current().revision).toBe(0)
  })
})

it('lists a ticket\'s execution environment in its prompt, and says setup is incomplete before setup finished', () => {
  withStore(store => {
    const ticket: Variable[] = [{ key: 'DSH_SUPERAGENT_DIR', value: '/srv/work/fix-1', description: { zh: '', en: 'This ticket\'s directory' }, owner: 'executor' }]
    expect(promptsOf(store).compose(defaultPrompts(), 'worker', ticket).endsWith('- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": This ticket\'s directory.')).toBe(true)
    expect(promptParts(defaultPrompts(), 'worker', 'env').at(-1)).toEqual({ name: 'runtime/environment', kind: 'generated', key: 'runtime/environment',
      text: 'env' })
    expect(new Prompts(store, () => 100000, () => undefined, () => false).compose(defaultPrompts(), 'worker')).toContain('dsh-superagent is waiting for setup')
  })
})

it('registers the built-in Source skills, Elpis chat when enabled, before the team skills', () => {
  withStore(store => {
    const config = { ...defaultPrompts(), skills: { release: 'Tag releases.' } }
    const skills = promptsOf(store).skills(config)
    expect(skills.map(([name]) => name)).toEqual(['elpis-chat', 'github', 'release'])
    expect(skills[1]![1]).toContain('## CLI usage')
    expect(skills[2]![1]).toBe('Tag releases.')
    expect(new Prompts(store, () => 100000, variables, () => false).skills(config).map(([name]) => name)).toEqual(['github', 'release'])
  })
})


describe('overrides of built-in parts', () => {
  const settings = () => SettingsSchema.parse({})
  const config = (overrides: PromptConfig['overrides']) => ({ ...defaultPrompts(), overrides })
  it('compose in place of the built-in texts, for the roles that read each, the handoff per role and the Source skills', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/shared': { text: 'Shared, the team way.' }, 'runtime/dispatch': { text: '## dispatch\nRoute well.' },
        'runtime/handoff/worker': { text: 'Hand off as a worker.' }, 'skill/github': { text: 'GitHub, the team way.' } }))
      const main = prompts.compose(edited, 'orchestrator'), worker = prompts.compose(edited, 'worker')
      for (const prompt of [main, worker]) expect(prompt.startsWith('Shared, the team way.\n\n')).toBe(true)
      expect(main).toContain('## dispatch\nRoute well.')
      expect(main).not.toContain(guides.dispatch)
      expect(worker).toContain('Hand off as a worker.')
      expect(main).toContain(handoffPolicy('orchestrator'))
      expect(prompts.skills(edited)).toContainEqual(['github', 'GitHub, the team way.'])
      // The parts say what they are edited by.
      expect(promptParts(edited, 'worker').find(part => part.name === 'runtime/handoff')).toMatchObject({ key: 'runtime/handoff/worker',
        text: 'Hand off as a worker.' })
    })
  })
  it('fill the templates of the generated parts with the data, which stays generated', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const edited = prompts.validate(config({ 'runtime/environment': { text: 'Where you work:\n{variables}\nAsk nobody for more.' },
        'runtime/policy': { text: '## Policy\nRules of {version} in {mode} mode:\n{rules}' },
        'runtime/policy/none': { text: '## Policy\n{version}, {mode}: nothing to accept.' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`Where you work:\n${ENVIRONMENT_LINE}\nAsk nobody for more.`)).toBe(true)
      const policy = policySection(settings(), edited)
      expect(policy).toEqual({ key: 'runtime/policy', text: `## Policy\nRules of ${policyVersion(settings())} in ${settings().eval.mode} mode:\n`
        + settings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n') })
      const none = SettingsSchema.parse({ policy: { rules: [] } })
      expect(policySection(none, edited)).toEqual({ key: 'runtime/policy/none', text: `## Policy\n${policyVersion(none)}, ${none.eval.mode}: nothing to accept.` })
      // A rule's text that names a placeholder is not filled again.
      const named = SettingsSchema.parse({ policy: { rules: [{ id: 'x', name: 'X', enabled: true, instruction: 'Keep {mode} and $& as written.' }] } })
      expect(policySection(named, edited).text.endsWith('- X (x): Keep {mode} and $& as written.')).toBe(true)
    })
  })
  it('refuses an unknown part and a template that drops a placeholder, and drops an override equal to the built-in text', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      expect(() => prompts.validate(config({ 'runtime/nothing': { text: 'x' } }))).toThrow(new UserError('unknownPromptPart', { part: 'runtime/nothing' }))
      expect(() => prompts.validate(config({ 'runtime/policy': { text: '## Policy\n{version} {mode}' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/policy', placeholders: '{rules}' }))
      expect(() => prompts.validate(config({ 'runtime/environment': { text: 'Where you work.' } })))
        .toThrow(new UserError('promptPlaceholders', { part: 'runtime/environment', placeholders: '{variables}' }))
      // Back to the built-in text: the part follows the built-in text again, so a later upgrade updates it.
      expect(prompts.validate(config({ 'runtime/shared': { text: sharedPrompt } }))).not.toHaveProperty('overrides')
      // The whole configuration, overrides included, stays within the limit.
      expect(() => promptsOf(store, 5000).validate(config({ 'runtime/shared': { text: 'x'.repeat(5000) } }))).toThrow(UserError)
    })
  })
  it('records the built-in text an override was edited from, and lists the overrides whose built-in text changed since', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      // An override edited from today's built-in text has nothing to show.
      const saved = prompts.save(config({ 'runtime/dispatch': { text: '## dispatch\nRoute well.' } }), 0, 'panel')
      expect(saved.config.overrides!['runtime/dispatch']!.base).toBe(builtInBase(`## dispatch\n${guides.dispatch}`))
      expect(prompts.defaultChanged(saved.config)).toEqual([])
      // One edited from a built-in text an earlier version shipped, which this installation kept when it was saved.
      const earlier = '## replies\nAn earlier built-in text.'
      store.set(KV.prompts.builtIn(builtInBase(earlier)), earlier)
      const upgraded = prompts.save(config({ ...saved.config.overrides, 'runtime/replies': { text: 'Our replies.', base: builtInBase(earlier) },
        'runtime/work': { text: 'Our work.', base: 'unknown' } }), saved.revision, 'panel')
      expect(prompts.defaultChanged(upgraded.config)).toEqual([{ part: 'runtime/replies', base: builtInBase(earlier), previous: earlier },
        { part: 'runtime/work', base: 'unknown' }])
      // Kept as it was: an upgrade never replaces the team's text.
      expect(prompts.compose(prompts.current().config, 'worker')).toContain('Our replies.')
    })
  })
  it('reads a configuration saved before overrides existed unchanged', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const saved = prompts.save({ ...defaultPrompts(), communication: 'Ours.' }, 0, 'panel')
      expect(saved.config).toEqual({ ...defaultPrompts(), communication: 'Ours.' })
      expect(prompts.compose(saved.config, 'orchestrator')).toBe(prompts.compose({ ...defaultPrompts(), communication: 'Ours.', overrides: {} }, 'orchestrator'))
    })
  })
  it('drops an override of a part a later version no longer has, which the saved version holds, and lists it as removed', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const config = { ...defaultPrompts(), overrides: { 'runtime/retired': { text: 'Old.', base: 'b' } } }
      // Only a part the saved version holds goes quietly; one a client makes up is refused.
      expect(() => prompts.validate(config)).toThrow(new UserError('unknownPromptPart', { part: 'runtime/retired' }))
      store.set(KV.prompts.version(1), { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config }); store.set(KV.prompts.revision, 1)
      expect(prompts.defaultChanged(config)).toEqual([{ part: 'runtime/retired', base: 'b', removed: true }])
      expect(prompts.validate(config)).toEqual(defaultPrompts())
      expect(USER_ERRORS.unknownPromptPart[0]).toBe('refused')
    })
  })
  it('keeps the base of the saved override of a part when a save omits it, and shows a re-based override as a change', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      const first = prompts.save(config({ 'runtime/shared': { text: 'Ours.', base: 'earlier' } }), 0, 'panel')
      const second = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.' } }), first.revision, 'tool')
      expect(second.config.overrides!['runtime/shared']).toEqual({ text: 'Ours, edited.', base: 'earlier' })
      // Keeping the team's text after an upgrade changes only the base, which the history names.
      const rebased = prompts.save(config({ 'runtime/shared': { text: 'Ours, edited.', base: builtInBase(sharedPrompt) } }), second.revision, 'panel')
      expect(prompts.history().revisions.find(version => version.revision === rebased.revision)!.changed).toEqual(['runtime/shared'])
    })
  })
  it('refuses a part an object\'s prototype names, and empty text, and fills no placeholder a prototype names', () => {
    withStore(store => {
      const prompts = promptsOf(store)
      for (const part of ['constructor', 'toString']) {
        expect(() => prompts.validate(config(JSON.parse(`{"${part}": { "text": "x" }}`)))).toThrow(new UserError('unknownPromptPart', { part }))
      }
      // The parser drops a __proto__ key, which sets no prototype.
      expect(prompts.validate(config(JSON.parse('{"__proto__": { "text": "x" }}')))).toEqual(defaultPrompts())
      expect(() => prompts.validate(config({ 'runtime/shared': { text: ' \n ' } }))).toThrow(new UserError('promptPartEmpty', { part: 'runtime/shared' }))
      const edited = prompts.validate(config({ 'runtime/environment': { text: '{constructor} {toString}\n{variables}' } }))
      expect(prompts.compose(edited, 'worker').endsWith(`{constructor} {toString}\n${ENVIRONMENT_LINE}`)).toBe(true)
    })
  })
  it('keeps the environment heading as it was, naming the prepare command', () => {
    expect(composePrompt(defaultPrompts(), 'worker', 'x')).not.toContain('The prepare command')
    withStore(store => {
      expect(promptsOf(store).compose(defaultPrompts(), 'worker')).toContain('an empty value means that part is not configured here). '
        + `The prepare command of a ticket directory reads the same variables:\n${ENVIRONMENT_LINE}`)
    })
  })
})
