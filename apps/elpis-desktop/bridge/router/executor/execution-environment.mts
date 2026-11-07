// Ported from dsh-superagent (MIT), src/app/execution-environment.ts
import { join } from 'node:path'
import type { Settings } from './settings.mts'
export interface Variable { key: string; value: string; description?: { en: string; zh: string }; owner?: string }
export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')
