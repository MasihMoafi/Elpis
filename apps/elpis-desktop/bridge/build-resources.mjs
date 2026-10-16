import fs from 'node:fs/promises';
const resources = new URL('./resources/', import.meta.url);
await fs.mkdir(resources, { recursive: true });
await fs.copyFile(new URL('../../../codex-rs/core/src/prompts/rag.md', import.meta.url), new URL('./rag.md', resources));
