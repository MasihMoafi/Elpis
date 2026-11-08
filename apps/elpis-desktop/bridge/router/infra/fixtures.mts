// Ported from dsh-superagent (MIT), tests/fixtures/deployment.ts and tests/fixtures/git.ts
import { GIT_LOCATION } from './environment.mts';
import type { Deployment } from './types.mts';
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
    stateDir: '/tmp/dsh-superagent-test', repository: 'acme/widgets',
    github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
});
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra });
