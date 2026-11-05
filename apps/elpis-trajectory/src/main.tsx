import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { TrajectoryDocument } from '../../../docs/specs/trajectory-contract'
import { TrajectoryView } from './TrajectoryView'
import './base.css'
import './design-platform.css'
import './gradient-shadow-text.css'
import './app.css'

async function loadTrajectory(): Promise<TrajectoryDocument> {
  try {
    const response = await fetch(`/api/trajectory${location.search}`, {  // the desktop passes ?thread=<id>; the TUI's server ignores it
      headers: { Accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const document: unknown = await response.json()
    if (typeof document !== 'object' || document === null || !('version' in document) || document.version !== 1 || !('turns' in document) || !Array.isArray(document.turns) || !('requestNumbers' in document) || !Array.isArray(document.requestNumbers)) throw new Error('Invalid trajectory document')
    return document as TrajectoryDocument
  } catch (error) {
    if (import.meta.env.DEV) return (await import('../fixtures/sample.json')).default as TrajectoryDocument
    throw error
  }
}
function App() {
  const [document, setDocument] = useState<TrajectoryDocument>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => { if (media.matches) documentBody().setAttribute('data-ds-dark-theme', ''); else documentBody().removeAttribute('data-ds-dark-theme') }
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => { let active = true; loadTrajectory().then(value => { if (active) setDocument(value) }).catch(reason => { if (active) setError(String(reason)) }); return () => { active = false } }, [])
  if (error) return <main className="message" role="alert">Could not load trajectory: {error}</main>
  if (!document) return <main className="message" role="status">Loading trajectory…</main>
  return <TrajectoryView document={document} />
}
function documentBody(): HTMLElement { return window.document.body }
createRoot(document.getElementById('root')!).render(<App />)
