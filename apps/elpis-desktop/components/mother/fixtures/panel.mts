// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/fixtures/panel.tsx.
// Uses the real Mother HTTP routes and SQLite state instead of reproducing the API in a fake server.
import './dom.mts'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { fixture } from '../../../bridge/router/fixtures/app.mts'
import { handleMotherHttp } from '../../../bridge/router/app/http.mts'
import { en } from '../locales.ts'
import type { T } from '../text.ts'
import type { Route } from '../route.ts'
const { App } = await import('../app.tsx')
const update = (action: () => void) => act(() => Promise.resolve().then(action))
const t: T = (key, values) => (en[key] ?? key).replace(/\{(\w+)\}/g, (all, name: string) => String(values?.[name] ?? all))

export async function panel(route?: Route, prepare?: (h: ReturnType<typeof fixture>) => Promise<void>) {
  sessionStorage.clear()
  if (route) sessionStorage.setItem('mother/route', JSON.stringify({ route, stack: [] }))
  const h = fixture(), opened: string[] = [], requests: string[] = [], originalFetch = globalThis.fetch
  let port = 0, pending = 0
  const server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); void handleMotherHttp(h.app.http(), req, res, port) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string'); port = address.port
  globalThis.fetch = async (input, init) => {
    pending++
    try { return await originalFetch(typeof input === 'string' ? new URL(input, `http://127.0.0.1:${port}`).href : input, init) }
    finally { pending-- }
  }
  const container = document.createElement('div'); document.body.append(container)
  let root = createRoot(container)
  const render = async () => { await update(() => { root.render(createElement(App, { t, openSession: id => { opened.push(id); return Promise.resolve() }, deploymentForm: undefined })) }); await settle() }
  async function settle() {
    for (let attempt = 0, quiet = 0; attempt < 100 && quiet < 3; attempt++) {
      await act(() => delay(5))
      quiet = pending ? 0 : quiet + 1
    }
    assert.equal(pending, 0, 'Panel requests must settle')
  }
  async function close() {
    await update(() => { root.unmount() }); container.remove()
    await settle(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    globalThis.fetch = originalFetch; await h.close()
  }
  async function remount() { await update(() => { root.unmount() }); root = createRoot(container); await render() }
  try { if (prepare) await prepare(h); await render() } catch (error) { await close(); throw error }
  return { h, opened, requests, close, settle, remount,
    text: () => document.body.textContent ?? '',
    async click(name: string, within: ParentNode = document) {
      const matches = [...within.querySelectorAll<HTMLElement>('button, [role="tab"], [role="switch"]')].filter(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name)
      assert.equal(matches.length, 1, `Expected one control named ${name}`)
      await update(() => { matches[0]!.click() }); await settle()
    },
    async fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      await update(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }); await settle()
    },
  }
}

export function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labels = [...document.querySelectorAll('label')].filter(element => element.textContent === label).map(element => element.htmlFor)
  const found = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find(element => element.getAttribute('aria-label') === label || labels.includes(element.id))
  assert.ok(found, `Missing field ${label}`); return found
}
