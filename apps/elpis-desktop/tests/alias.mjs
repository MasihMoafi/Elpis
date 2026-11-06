// Resolves the renderer's "@/…" imports (tsconfig paths) for unit tests that import TypeScript directly:
// import './alias.mjs' first, then import the module under test with await import().
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('@/')) return next(specifier, context);
    const base = root + specifier.slice(2), file = ['', '.ts', '.tsx', '.js', '/index.ts'].map(end => base + end).find(existsSync);
    return next(file ? pathToFileURL(file).href : specifier, context);
  },
});
