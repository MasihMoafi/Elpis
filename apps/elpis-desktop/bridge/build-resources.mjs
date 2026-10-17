import fs from 'node:fs/promises';
const resources = new URL('./resources/', import.meta.url);
await fs.mkdir(resources, { recursive: true });
await fs.copyFile(new URL('../../../codex-rs/core/src/prompts/rag.md', import.meta.url), new URL('./rag.md', resources));
// Excalidraw's bundled fonts stay local, including during whole-drawing PNG export.
await fs.cp(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts/', import.meta.url), new URL('../public/love-spot-assets/fonts/', import.meta.url), { recursive: true });
