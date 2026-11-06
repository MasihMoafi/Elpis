import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli } from './tools.mts';

/** gh owns credentials. Elpis saves only whether new chats should receive its GitHub login. */
export function createGithubConnector({ home, run = runCli }: { home: string; run?: (command: string, args: string[], options: { timeout: number }) => Promise<string> }) {
  const file = path.join(home, 'github-connector.json');
  async function enabled() {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { enabled: unknown };
      if (typeof saved.enabled !== 'boolean') throw Error('Invalid GitHub preference.');
      return saved.enabled;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async function login() {
    try {
      const value = (await run('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { timeout: 5000 })).trim();
      return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) ? value : null;
    } catch { return null; }
  }
  return {
    async snapshot() { return { name: 'GitHub', transport: 'gh', enabled: await enabled(), login: await login() }; },
    async setEnabled(value: boolean) {
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ enabled: value }) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    },
    async instructions() {
      if (!await enabled()) return null;
      const account = await login();
      return account ? `gh is signed in as ${account} on github.com and may be used for GitHub work.` : null;
    },
  };
}
