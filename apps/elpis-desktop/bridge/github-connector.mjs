import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCli } from './tools.mjs';

/** gh owns credentials. Elpis saves only whether new chats should receive its GitHub login. */
export function createGithubConnector({ home, run = runCli }) {
  const file = path.join(home, 'github-connector.json');
  async function enabled() {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (typeof saved.enabled !== 'boolean') throw Error('Invalid GitHub preference.');
      return saved.enabled;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function login() {
    try {
      const value = (await run('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { timeout: 5000 })).trim();
      return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value) ? value : null;
    } catch { return null; }
  }
  return {
    async snapshot() { return { name: 'GitHub', transport: 'gh', enabled: await enabled(), login: await login() }; },
    async setEnabled(value) {
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
