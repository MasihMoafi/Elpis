// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/prompts.ts.
/** Manages versioned role prompts, behavioral policies, and operational skills independently of access settings. */
import { z } from 'zod';
import { UserError, key } from '../core/index.mts';
import { policyVersion, type Settings, type SettingsOrigin } from '../policy.mts';
import { masterPrompt, workerPrompt, sharedPrompt, guides, mainAdmissionPolicy, handoffPolicy, teamDefaults, sourceSkills, cliNotes } from './context.mts';
import { environmentLines, type Variable } from '../executor/execution-environment.mts';
import { promptsNotice } from './notices.mts';
import type { Sessions } from '../executor/sessions.mts';
import type { Store } from './store.mts';
import { Versions } from './versions.mts';
import { KV } from '../sources/kv.mts';

/** Prompt sections the team writes; the built-in parts follow dsh-superagent's text until the team overrides them. */
export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type TeamSection = typeof TEAM_SECTIONS[number]
/** Markdown headings for each team section; fixed prompt sections refer to them by these exact names. */
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
/** Prefix prepended to skill names when registering them in DSH Sessions. */
export const SKILL_PREFIX = 'mother-'
const SkillNameSchema = z.string().regex(SKILL_NAME).refine(name => !(Object.keys(sourceSkills) as string[]).includes(name),
  'This name belongs to a built-in skill')
/** The built-in parts a team may override, by key: both roles' parts, the Source skills, and the generated parts' templates. */
const PART_KEYS = ['runtime/shared', 'runtime/orchestrator', 'runtime/worker', 'runtime/subscriptions', 'runtime/replies',
  'runtime/dispatch', 'runtime/work', 'runtime/admission', 'runtime/handoff/orchestrator', 'runtime/handoff/worker', 'runtime/environment',
  'runtime/policy', 'runtime/policy/none', 'skill/elpis-chat', 'skill/github'] as const
export type PartKey = typeof PART_KEYS[number]
/** A team's text for a built-in part, and `base`, the key of the built-in text it was edited from. */
const OverrideSchema = z.object({ text: z.string(),
  base: z.string().optional().describe('Key of the built-in text it was edited from; copy as read, or omit.') }).strict()
/**
 * A configuration, whose overrides may name a part a later version no longer has, which `Prompts.validate` drops when the
 * saved version holds it and refuses otherwise.
 */
export const PromptConfigSchema = z.object({ communication: z.string(), scope: z.string(), delivery: z.string(),
  skills: z.record(SkillNameSchema, z.string()), overrides: z.record(z.string(), OverrideSchema).optional()
    .describe('Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.') }).strict()
export type PromptConfig = z.infer<typeof PromptConfigSchema>
export interface PromptVersion { revision: number; previousRevision: number | null; savedAt: string; source: string; config: PromptConfig;
  /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
  legacy?: { config: unknown } }
export const defaultPrompts = (): PromptConfig => ({ ...teamDefaults, skills: {} })

const ENVIRONMENT_HEADING = 'Execution environment (from this installation\'s settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:'
const POLICY_HEAD = '## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.'
type Role = 'orchestrator' | 'worker'
/** A built-in part a team may override: the roles that read it, its text, and the placeholders a template's override keeps. */
interface BuiltInPart { roles: readonly Role[]; text: string; placeholders?: readonly string[] }
const BOTH: readonly Role[] = ['orchestrator', 'worker'], MAIN: readonly Role[] = ['orchestrator'], WORKER: readonly Role[] = ['worker']
let parts: Readonly<Record<PartKey, BuiltInPart>> | undefined
/**
 * The built-in parts of both roles' prompts, the two Source skills, and the templates of the generated parts, whose data the
 * system fills in, by the key an override names them by. Cached on first use.
 */
export const builtInParts = (): Readonly<Record<PartKey, BuiltInPart>> => parts ??= {
  'runtime/shared': { roles: BOTH, text: sharedPrompt }, 'runtime/orchestrator': { roles: MAIN, text: masterPrompt },
  'runtime/worker': { roles: WORKER, text: workerPrompt },
  'runtime/subscriptions': { roles: BOTH, text: `## subscriptions\n${guides.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## replies\n${guides.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## dispatch\n${guides.dispatch}` }, 'runtime/work': { roles: WORKER, text: `## work\n${guides.work}` },
  'runtime/admission': { roles: MAIN, text: mainAdmissionPolicy },
  'runtime/handoff/orchestrator': { roles: MAIN, text: handoffPolicy('orchestrator') },
  'runtime/handoff/worker': { roles: WORKER, text: handoffPolicy('worker') },
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEADING}\n{variables}`, placeholders: ['{variables}'] },
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD} The enabled rules, by name and id:\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD} No rule is enabled: a proactive candidate can only be ignored.`,
    placeholders: ['{version}', '{mode}'] },
  'skill/elpis-chat': { roles: BOTH, text: `${sourceSkills['elpis-chat']}\n\n## CLI usage\n${cliNotes}` },
  'skill/github': { roles: BOTH, text: `${sourceSkills.github}\n\n## CLI usage\n${cliNotes}` },
}
/** The key of a built-in text, which an override's `base` records. */
export const builtInBase = (text: string): string => key('prompt-built-in', text)
/** The built-in part a key names, if any; a name an object's prototype has names none. */
export const builtInPart = (part: string): BuiltInPart | undefined =>
  Object.hasOwn(builtInParts(), part) ? builtInParts()[part as PartKey] : undefined
/** The text of a built-in part: the team's override, else the built-in one. */
const builtIn = (config: PromptConfig, part: PartKey): string =>
  (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part]!.text : undefined) ?? builtInParts()[part].text
/** Fill a template's placeholders in one pass, so text filled in is not read for placeholders again. */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match)
/** The execution environment part: its template with the variables, or, while setup waits, that it waits. */
export function environmentSection(config: PromptConfig, variables: Variable[] | undefined): string {
  return variables ? fill(builtIn(config, 'runtime/environment'), { variables: environmentLines(variables) })
    : 'Execution environment: dsh-superagent is waiting for setup; the management panel names what is missing.'
}
/**
 * The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every enabled
 * rule, as the settings hold them, each on one line, so a line of an instruction reads as no rule or heading of its own; the
 * settings bound each instruction (`LIMITS.ruleInstruction`). `key` names the template it was filled from.
 */
export function policySection(settings: Settings, config: PromptConfig = defaultPrompts()): { key: string; text: string } {
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ')
  const rules = settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`)
  const part = rules.length ? 'runtime/policy' : 'runtime/policy/none'
  return { key: part, text: fill(builtIn(config, part), { version: policyVersion(settings), mode: settings.eval.mode, rules: rules.join('\n') }) }
}
/**
 * Assemble a role's system prompt sections in order from fixed templates, team sections, the generated execution environment
 * and, last, the main Session's generated Policy section, which nothing follows, and whose change leaves the rest unchanged.
 */
export function promptParts(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }) {
  // A built-in part names the key its text is overridden by, which for the handoff names the role.
  const fixed = (name: string, part = name) => ({ name, kind: 'fixed' as const, key: part, text: builtIn(config, part as PartKey) })
  const team = (name: TeamSection) => ({ name, kind: 'team' as const, heading: `## ${TEAM_HEADINGS[name]}`,
    text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : '' })
  return [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(team),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed('runtime/handoff', `runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated' as const, key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated' as const, ...policy }] : [],
  ].filter(part => part.text)
}
export function composePrompt(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }): string {
  return promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')
}
export function composeSkill(config: PromptConfig, name: string): string {
  return name === 'elpis-chat' || name === 'github' ? builtIn(config, `skill/${name}`) : config.skills[name] ?? ''
}

/** An override whose built-in text changed since its `base`, with that text when kept, or whose part this version no longer has. */
export interface DefaultChange { part: string; base?: string; previous?: string; removed?: true }
/**
 * Indicates an optimistic concurrency conflict when saving a prompt configuration against a stale base revision.
 * Thrown by `Prompts.save` and translated into an HTTP 409 response by the management routes.
 */
export class PromptConflict extends Error {}
/**
 * Stores numbered prompt configurations in `Store` via `Versions` and composes role system prompts and skills with the execution environment.
 * `Sessions` reads the composed prompts and skills for orchestrator and worker runs, while management routes and tools validate, preview, and save revisions through it.
 */
export class Prompts {
  private readonly versions: Versions<PromptVersion>
  private readonly store: Store
  private readonly maxChars: () => number
  private readonly environment: () => Variable[] | undefined
  private readonly chat: () => boolean
  constructor(store: Store, maxChars: () => number, environment: () => Variable[] | undefined,
    chat: () => boolean) {
    this.store = store
    this.maxChars = maxChars
    this.environment = environment
    this.chat = chat

    this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version)
  }
  /** A role's prompt; the main Session's Policy section follows the settings as they are now, at each model request. */
  compose(config: PromptConfig, role: Role, variables = this.environment()): string {
    return composePrompt(config, role, environmentSection(config, variables), role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
  }
  /** Returns skills to register in every Session: built-in Source skills (`feishu` only when a Feishu bot is configured) followed by team skills. */
  skills(config: PromptConfig): [string, string][] {
    return [...this.chat() ? ['elpis-chat'] : [], 'github', ...Object.keys(config.skills)].map(name => [name, composeSkill(config, name)])
  }
  current(): PromptVersion {
    const revision = this.versions.revision()
    return revision ? this.version(revision) : { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() }
  }
  /** Reads a revision by number; revision 0 resolves to built-in defaults before the first save persists it. */
  version(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0 ? this.current() : undefined)
    if (!version) throw new UserError('unknownPromptRevision', { revision: String(revision) })
    return version
  }
  /**
   * Parse a configuration: an override names a built-in part, holds text and keeps its template's placeholders, and records the
   * built-in text it was edited from: the saved override's unless it names one, else the current one. It goes once its text is
   * the built-in text again, and so does one of a part this version no longer has, which the saved version holds.
   */
  validate(value: unknown): PromptConfig {
    const { overrides, ...config } = PromptConfigSchema.parse(value)
    const saved = this.current().config.overrides ?? {}
    const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
      const part = builtInPart(name)
      if (!part && Object.hasOwn(saved, name)) return []
      if (!part) throw new UserError('unknownPromptPart', { part: name })
      if (!override.text.trim()) throw new UserError('promptPartEmpty', { part: name })
      const missing = (part.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) throw new UserError('promptPlaceholders', { part: name, placeholders: missing.join(', ') })
      const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name]!.base : undefined) ?? builtInBase(part.text)
      return override.text === part.text ? [] : [[name, { text: override.text, base }] as const]
    })
    const result: PromptConfig = { ...config, ...kept.length ? { overrides: Object.fromEntries(kept) } : {} }
    const limit = this.maxChars()
    if (JSON.stringify(result).length > limit) throw new UserError('promptTooLong', { limit: String(limit) })
    return result
  }
  /**
   * The overrides of `config` whose built-in part changed since the team edited it, by the `base` they were edited from, each
   * with the built-in text of that base when this installation kept it, and those of a part this version no longer has.
   */
  defaultChanged(config: PromptConfig): DefaultChange[] {
    return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]): DefaultChange[] => {
      const now = builtInPart(part)
      if (!now) return [{ part, ...base === undefined ? {} : { base }, removed: true as const }]
      if (base === undefined || base === builtInBase(now.text)) return []
      const previous = this.store.get(KV.prompts.builtIn(base))
      return [{ part, base, ...previous === undefined ? {} : { previous } }]
    })
  }
  preview(value: unknown) {
    const config = this.validate(value)
    const environment = environmentSection(config, this.environment()), policy = policySection(this.store.settings(), config)
    return { orchestrator: composePrompt(config, 'orchestrator', environment, policy), worker: composePrompt(config, 'worker', environment),
      parts: { orchestrator: promptParts(config, 'orchestrator', environment, policy), worker: promptParts(config, 'worker', environment) },
      skills: Object.fromEntries(this.skills(config)), scope: 'Team sections, skills, and overrides of built-in parts, which follow their built-in text until overridden. Workers additionally inherit the host prompt and repository AGENTS.md. Prompt text changes what the agents are told, not what dsh-superagent allows: tool permissions, the gate and account wrappers stay.' }
  }
  save(value: unknown, baseRevision: number, source: SettingsOrigin): PromptVersion {
    const config = this.validate(value)
    return this.store.atomic(() => {
      const previous = this.current()
      if (previous.revision !== baseRevision) throw new PromptConflict(`Prompt version changed to ${previous.revision}; compare the latest version before saving`)
      // Persist the built-in defaults as revision 0 before recording the first custom revision.
      if (previous.revision === 0 && !this.versions.get(0)) this.versions.keep(previous)
      // The built-in text each override was edited from, kept to show what an upgrade changed in it.
      for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
        const text = builtInParts()[part as PartKey].text
        if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === undefined) this.store.set(KV.prompts.builtIn(base), text)
      }
      return this.versions.save(revision => ({ revision, previousRevision: previous.revision, savedAt: new Date().toISOString(), source, config }))
    })
  }
  history(offset = 0, limit = 20) {
    const current = this.current()
    const revisions = Array.from({ length: Math.min(limit, Math.max(0, current.revision + 1 - offset)) }, (_, i) => {
      const version = current.revision - offset - i === 0 && current.revision === 0 ? current : this.version(current.revision - offset - i)
      const { config, ...summary } = version
      const previous = version.previousRevision === null ? undefined : this.versions.get(version.previousRevision)?.config
      // Pre-team-section revisions are not comparable field-by-field.
      const legacy = version.legacy || (version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy)
      if (legacy) return { ...summary, changed: ['legacy'] }
      const entries = (value: PromptConfig) => ({ communication: value.communication, scope: value.scope, delivery: value.delivery,
        ...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ['skill/' + name, text])),
        // An override changes with its text or with the built-in text it was edited from.
        ...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)])) })
      const before = previous ? entries(previous) : {}
      const after = entries(config)
      const changed = previous ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before as Record<string, string>)[name] !== (after as Record<string, string>)[name]) : []
      return { ...summary, changed }
    })
    return { revisions, next_offset: offset + revisions.length <= current.revision ? offset + revisions.length : null }
  }
}
/** Save a new prompt revision and notify the main Session when the change originated outside its own tool call. */
export async function savePrompts(host: { store: Pick<Store, 'atomic'>; prompts: Pick<Prompts, 'save'>; sessions: Pick<Sessions, 'notify' | 'delivery'> },
  config: unknown, baseRevision: number, origin: SettingsOrigin) {
  const version = host.store.atomic(() => {
    const saved = host.prompts.save(config, baseRevision, origin)
    if (origin !== 'tool') host.sessions.notify(...promptsNotice(saved.revision))
    return saved
  })
  return { revision: version.revision, effect: 'next-request' as const, context_delivery: await host.sessions.delivery('prompts') }
}
