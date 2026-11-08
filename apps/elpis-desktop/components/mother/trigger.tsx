// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/trigger.tsx.
/** Trigger status view listing Threads filtered by subscription and evaluation activity. */
import { useState } from 'react'
import { THREAD_FILTERS, type ThreadFilter } from '../../bridge/router/app/api.mts'
import { usePoll } from './api.ts'
import { Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ThreadLine } from './rows.tsx'
import { Empty, LoadMore, LoadState, StatusHead } from './widgets.tsx'

export function TriggerStatus({ filter }: { filter: ThreadFilter }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error } = usePoll(() => call('GET threads', { query: { filter, limit } }), [filter, limit])
  const go = (next: ThreadFilter) => { setLimit(20); navigate({ page: 'trigger', query: next !== 'subscribed' ? { filter: next } : {} },
    true) }
  return <>
    <StatusHead hint={t('triggerIntro')} />
    <div className="dt-filters">
      {THREAD_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => go(value)}>{t(`threadFilter.${value}`)}</Pill>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Empty>{t('threadsNone')}</Empty>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}
