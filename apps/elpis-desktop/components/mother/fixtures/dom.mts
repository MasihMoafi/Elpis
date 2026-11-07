/** Local DOM and TSX loading for the panel's node:test interaction cases. */
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'

const appRoot = new URL('../../../', import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/') || specifier.startsWith('.') && context.parentURL?.startsWith(appRoot.href) && !context.parentURL.includes('/node_modules/')) {
      const base = specifier.startsWith('@/') ? new URL(specifier.slice(2), appRoot) : new URL(specifier, context.parentURL)
      for (const candidate of [base.href, ...['.ts', '.tsx', '.mts', '.cts'].map(extension => `${base.href}${extension}`)]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.startsWith(appRoot.href) && url.endsWith('.tsx')) {
      const result = ts.transpileModule(readFileSync(new URL(url), 'utf8'), { fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX } })
      return { format: 'module', source: result.outputText, shortCircuit: true }
    }
    return next(url, context)
  },
})

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true })
const window = dom.window
const replace = new Set(['window', 'document', 'navigator', 'Event', 'EventTarget', 'Node', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'getComputedStyle'])
for (const name of Object.getOwnPropertyNames(window)) {
  if (name in globalThis && !replace.has(name)) continue
  const value: unknown = Reflect.get(window, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
class Pointer extends window.MouseEvent { readonly pointerId = 1; readonly pointerType = 'mouse'; readonly isPrimary = true }
Object.defineProperty(globalThis, 'PointerEvent', { configurable: true, value: Pointer })
Object.defineProperty(window, 'PointerEvent', { configurable: true, value: Pointer })
class Resize { observe(): void {} unobserve(): void {} disconnect(): void {} }
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Resize })
Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: Resize })
window.HTMLElement.prototype.scrollIntoView = () => {}
window.HTMLElement.prototype.scrollTo = () => {}
window.HTMLElement.prototype.hasPointerCapture = () => false
window.HTMLElement.prototype.setPointerCapture = () => {}
window.HTMLElement.prototype.releasePointerCapture = () => {}
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
