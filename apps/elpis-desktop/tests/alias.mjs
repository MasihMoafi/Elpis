// Resolves the renderer's "@/…" imports (tsconfig paths) and its extensionless relative imports ("./api") for unit
// tests that import TypeScript directly:
// import './alias.mjs' first, then import the module under test with await import().
import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    const relative = specifier.startsWith('.') && context.parentURL?.match(/\.tsx?$/) && !/\.[cm]?[jt]sx?$/.test(specifier);
    if (!specifier.startsWith('@/') && !relative) return next(specifier, context);
    const base = relative ? fileURLToPath(new URL(specifier, context.parentURL)) : root + specifier.slice(2);
    const file = ['', '.ts', '.tsx', '.js', '/index.ts'].map(end => base + end).find(name => statSync(name, { throwIfNoEntry: false })?.isFile());
    return next(file ? pathToFileURL(file).href : specifier, context);
  },
});
