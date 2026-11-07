'use client'
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/index.tsx.
import { useEffect, useRef } from 'react'
import { openKnownSession, type SessionCatalog } from './navigation'
import { App } from './app'
import { en } from './locales'
import type { T } from './text'
const t: T = (key, values) => (en[key] ?? key).replace(/\{(\w+)\}/g, (all, name: string) => String(values?.[name] ?? all))
/** Mother is an ordinary Elpis page; native sessions open through the workspace's existing chat selection. */
export default function MotherPage({ onOpenThread }: { onOpenThread: (id: string) => void }) {
  const navigation = useRef<AbortController | null>(null)
  useEffect(() => () => navigation.current?.abort(), [])
  async function openSession(id: string) {
    navigation.current?.abort()
    const controller = new AbortController(); navigation.current = controller
    let state: ReturnType<SessionCatalog['list']['getSnapshot']> = { phase: 'pending', byId: {} }
    const sessions: SessionCatalog = { list: { getSnapshot: () => state }, refresh: async () => {
    const response = await fetch(`/api/mother/sessions/${encodeURIComponent(id)}`, { headers: { 'x-orchestrator-request': '1' } })
    const data = await response.json() as { threadId?: string | undefined; error?: string | undefined }
    if (!response.ok || !data.threadId) throw new Error(data.error ?? 'The session is unavailable')
      state = { phase: 'ready', byId: { [id]: data.threadId } }
    } }
    await openKnownSession(sessions, id, key => onOpenThread(String(state.byId[key])), controller.signal)
  }
  return <App t={t} openSession={openSession} deploymentForm={undefined} />
}
