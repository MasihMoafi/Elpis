// Ported from dsh-superagent (MIT), src/kv.ts
import type { Retry } from './github.mts'

export type Key<V> = string & { readonly __value?: V }
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
export const record = <V,>(key: string): Key<V> => key as Key<V>
export function family<V, A extends unknown[] = [string]>(prefix: string): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${name.join(':')}` as Key<V>, { prefix })
}
export const KV = {
  elpisChat: { cursor: family<string>('elpis-chat-cursor:') },
  github: {
    since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:'),
  },
}
