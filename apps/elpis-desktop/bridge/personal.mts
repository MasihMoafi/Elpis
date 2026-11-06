import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elpisHome } from './client.mts';

const template = fileURLToPath(new URL('./resources/personal.md', import.meta.url));
const exists = (file: string) => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const marker = (home: string) => path.join(home, 'personal-tip-dismissed');

export async function personalStatus(home = elpisHome()) {
  const file = path.join(home, 'skills/personal/SKILL.md');
  return { path: file, showTip: !(await exists(file)) && !(await exists(marker(home))) };
}

export async function dismissPersonalTip(home = elpisHome()) {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(marker(home), '');
  return personalStatus(home);
}

export async function openPersonal(home = elpisHome()) {
  const { path: file } = await personalStatus(home);
  const content = await fs.readFile(template);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, content, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await fs.access(file);
  return dismissPersonalTip(home);
}
