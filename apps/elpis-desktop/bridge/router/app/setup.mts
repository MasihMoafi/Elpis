// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/setup.ts.
import { SETUP_FIELDS, resolveDeployment, workerProbe, type Deployment, type Machine } from '../deployment.mts';
import { agentVariables, workerBin, writeEnvironment } from '../infra/environment.mts';
import { SetupError, type SetupProblem } from '../infra/setup.mts';
import type { SubprocessRuntime } from '../infra/types.mts';
import type { Settings, SettingsBlock } from '../policy.mts';
const fields = (settings: Settings) => JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => [settings.sources[id]?.enabled ?? false, ...keys.map(key => settings.sources[id]?.config[key] ?? '')]))
export const setupChanged = (before: Settings, after: Settings): boolean => fields(before) !== fields(after)
interface Host { machine: Machine; subprocess: SubprocessRuntime; lifetime: AbortSignal; restart(): void }
const problemOf = (error: unknown): SetupProblem => error instanceof SetupError ? error.problem : new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) }).problem
/** GitHub failure pauses that Source; the selected local Elpis chat remains available for setup. */
export class Setup {
  private readonly host: Host
  private resolved: Deployment
  problem: SetupProblem | undefined
  private checking: Promise<boolean> | undefined
  constructor(host: Host) {
    this.host = host
    this.resolved = { ...host.machine, repository: '', github: { cli: '', login: '', noreply: '' } }
  }
  get deployment(): Deployment { return this.resolved }
  get commandEnvironment(): Record<string, string | undefined> { return {} }
  workerEnvironment(): Record<string, string | undefined> {
    if (this.problem?.place === 'deployment') throw new Error(this.problem.detail)
    return { ...agentVariables(this.host.machine.stateDir), PATH: `${workerBin(this.host.machine.stateDir)}:${process.env.PATH ?? ''}` }
  }
  configured(): boolean { return !this.host.lifetime.aborted }
  githubReady(): boolean { return !!this.resolved.github.cli && !this.problem }
  run(settings: Settings): Promise<boolean> {
    return this.checking ??= this.resolve(settings).finally(() => { this.checking = undefined })
  }
  private async resolve(settings: Settings): Promise<boolean> {
    this.problem = undefined
    const source = settings.sources.github
    try {
      if (source?.enabled) this.resolved = await resolveDeployment(this.host.machine, source.config, this.probe())
      else this.resolved = { ...this.host.machine, repository: '', github: { cli: '', login: '', noreply: '' } }
    } catch (error) { this.problem = problemOf(error) }
    // Account failure still leaves local workers behind the same isolated command wrappers.
    try { await writeEnvironment(this.resolved, settings.executor.blockedCommands) }
    catch (error) { this.problem = problemOf(error) }
    return !this.problem
  }
  check(): void { this.restart() }
  restart(): void { if (!this.host.lifetime.aborted) setTimeout(() => { if (!this.host.lifetime.aborted) this.host.restart() }, 0) }
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    if (block === 'source:github' && settings.sources.github?.enabled) await resolveDeployment(this.host.machine, settings.sources.github.config, this.probe())
  }
  async blockCommands(blocked: readonly string[]): Promise<void> { await writeEnvironment(this.resolved, blocked) }
  private probe() { const { machine, subprocess, lifetime } = this.host; return workerProbe(subprocess, machine.stateDir, machine.stateDir, lifetime) }
}
