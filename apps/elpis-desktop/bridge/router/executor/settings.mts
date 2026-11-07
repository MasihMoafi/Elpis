// Ported from dsh-superagent (MIT), src/policy.ts and src/app/assessment.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters')
export const SettingsSchema = z.object({
  policy: z.object({ rules: z.array(z.object({ id: z.string(), name: z.string(), instruction: z.string(), enabled: z.boolean().default(true) })).default([]) }).default({ rules: [] }),
  eval: z.object({ model: RoleModelSchema.nullable().default(null) }).default({ model: null }),
  executor: z.object({ model: RoleModelSchema.nullable().default(null), maxWorkers: z.number().int().min(1).default(3), directory: z.string().trim().refine(value => value === '' || value.startsWith('/'), 'An absolute directory is required').default(''), prepare: z.string().default('') }).default({ model: null, maxWorkers: 3, directory: '', prepare: '' }),
})
export type Settings = z.infer<typeof SettingsSchema>
/** Read only router settings, never credentials or provider key files. Invalid settings fail closed. */
export function readSettings(home: string): Settings {
  try { return SettingsSchema.parse(JSON.parse(readFileSync(join(home, 'router', 'settings.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return SettingsSchema.parse({}); throw error }
}
