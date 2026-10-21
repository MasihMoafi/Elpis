import fs from 'node:fs/promises';

export async function appIdentity() {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { version: pkg.version, commit: pkg.commit || null, releaseNotes: 'https://github.com/MasihMoafi/Elpis/releases' };
}
