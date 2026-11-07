// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/policy.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsSchema } from '../policy.mts'
import { storedSettings } from '../app/store.mts'
export { SettingsSchema, RoleModelSchema } from '../policy.mts'
export type { Settings, RoleModel } from '../policy.mts'
export { WorktreeNameSchema } from '../app/assessment.mts'
/** Read legacy router settings for first-run migration. No credential files are read. */
export function readSettings(home: string) {
  const saved = storedSettings(join(home, 'router', 'orchestrator.sqlite'))
  if (saved) return saved
  try { return SettingsSchema.parse(JSON.parse(readFileSync(join(home, 'router', 'settings.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return SettingsSchema.parse({}); throw error }
}
