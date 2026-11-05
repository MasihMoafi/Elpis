/* Adapted from packages/client/ui-trajectory/src/client/TrajectoryView.tsx · Copyright (c) 2026 DeepSeek, MIT License */
import { useCallback, useMemo, useState } from 'react'
import type { TrajectoryDocument } from '../../../docs/specs/trajectory-contract'
import { TrajectoryToolbar } from './TrajectoryToolbar'
import { TrajectoryTimeline } from './TrajectoryTimeline'
import { TrajectoryTable } from './TrajectoryTable'
import { trajectoryRecordId, type TrajectoryCellProps } from './trajectory-record'
import { trajectoryTimelineFocusIndexes, type TrajectoryTimeRange, type TrajectoryTimelineMode } from './timeline'
import { t } from './locales'
import css from './views.module.css'

function toggled<T>(current: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}
function toggleAll<T>(current: ReadonlySet<T>, ids: readonly T[]): Set<T> {
  const next = new Set(current)
  const remove = ids.length > 0 && ids.every(id => next.has(id))
  for (const id of ids) { if (remove) next.delete(id); else next.add(id) }
  return next
}

export function TrajectoryView({ document }: { document: TrajectoryDocument }) {
  const turns = document.turns
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(new Set())
  const [collapsedTools, setCollapsedTools] = useState<ReadonlySet<string>>(new Set())
  const [actualDuration, setActualDuration] = useState(false)
  const [actualTime, setActualTime] = useState(false)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [recordSelection, setRecordSelection] = useState<{ index: number } | null>(null)
  const [recordFocus, setRecordFocus] = useState<{ index: number } | null>(null)
  const mode: TrajectoryTimelineMode = actualDuration ? actualTime ? 'actual' : 'duration' : actualTime ? 'time' : 'sequence'
  // The contract has request entries but no separator-only cell. Preserve every request,
  // including retries and requests for an empty group, as local boundary markers.
  const tableTurns = useMemo(() => {
    const requestsByGroup = new Map<string, TrajectoryDocument['requestNumbers']>()
    for (const request of document.requestNumbers) {
      const key = `${request.turn}\u0000${request.group}`
      const requests = requestsByGroup.get(key) ?? []
      requests.push(request)
      requestsByGroup.set(key, requests)
    }
    return turns.map(turn => ({
      ...turn,
      groups: turn.groups.map(group => {
        const requests = requestsByGroup.get(`${turn.turn}\u0000${group.title}`) ?? []
        const hasAnchor = group.cells.some(cell => !['user', 'context', 'system'].includes(cell.kind))
        const boundaries: TrajectoryCellProps[] = (hasAnchor ? requests.slice(0, -1) : requests).map(request => ({
          index: -request.number, recordId: `request-boundary-${request.number}`, kind: 'message', text: '',
          timeSeconds: null, requestOnly: true, requestNumber: request.number,
        }))
        return { ...group, cells: [...boundaries, ...group.cells] }
      }),
    }))
  }, [turns, document.requestNumbers])
  const turnIds = useMemo(() => turns.filter(turn => turn.turn !== null && turn.groups.flatMap(group => group.cells).filter(cell => cell.kind !== 'system').length > 1).map(turn => turn.turn as number), [turns])
  const assistantIds = useMemo(() => turns.flatMap(turn => {
    const cells = turn.groups.flatMap(group => group.cells)
    return cells.flatMap((cell, i) => cell.kind === 'message' && ['tool', 'subtool'].includes(cells[i + 1]?.kind ?? '') ? [trajectoryRecordId(cell)] : [])
  }), [turns])
  const toolIds = useMemo(() => turns.flatMap(turn => turn.groups.flatMap(group => group.cells.flatMap((cell, i) => cell.kind === 'tool' && group.cells[i + 1]?.kind === 'subtool' ? [trajectoryRecordId(cell)] : []))), [turns])
  const allTurnsCollapsed = turnIds.length > 0 && turnIds.every(id => collapsedTurns.has(id))
  const allAssistantsCollapsed = assistantIds.length > 0 && assistantIds.every(id => collapsedAssistants.has(id))
  const allToolsCollapsed = toolIds.length > 0 && toolIds.every(id => collapsedTools.has(id))
  const searchMatches = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return null
    return new Set(turns.flatMap(turn => turn.groups.flatMap(group => group.cells.filter(cell => {
      const text = [cell.text, cell.previewMarkdown, cell.inputDetail, cell.outputDetail, cell.thinkingDetail, cell.result, cell.toolName].filter(Boolean).join(' ').toLocaleLowerCase()
      return words.every(word => text.includes(word))
    }).map(cell => cell.index))))
  }, [query, turns])
  const timelineMatches = useMemo(() => range === null ? null : trajectoryTimelineFocusIndexes(turns, range, mode), [turns, range, mode])
  const visibleMatches = useMemo(() => {
    if (timelineMatches === null) return searchMatches
    if (searchMatches === null) return timelineMatches
    return new Set([...timelineMatches].filter(index => searchMatches.has(index)))
  }, [searchMatches, timelineMatches])
  const selectFromTimeline = useCallback((index: number) => { setRange(null); setRecordSelection({ index }); setSelectedIndex(index) }, [])
  return <div className={css.root}>
    <TrajectoryToolbar t={t} actualDuration={actualDuration} onActualDurationChange={value => { setActualDuration(value); setRange(null) }} actualTime={actualTime} onActualTimeChange={value => { setActualTime(value); setRange(null) }} allTurnsCollapsed={allTurnsCollapsed} onToggleAllTurns={() => setCollapsedTurns(current => toggleAll(current, turnIds))} allAssistantsCollapsed={allAssistantsCollapsed} onToggleAllAssistants={() => setCollapsedAssistants(current => toggleAll(current, assistantIds))} allSubCallsCollapsed={allToolsCollapsed} onToggleAllSubCalls={() => setCollapsedTools(current => toggleAll(current, toolIds))} searchQuery={query} onSearchQueryChange={setQuery} />
    <TrajectoryTimeline t={t} turns={turns} mode={mode} range={range} selectedIndex={selectedIndex} searchMatchIndexes={searchMatches} onRangeChange={setRange} onRecordSelect={selectFromTimeline} onRecordFocus={index => setRecordFocus({ index })} />
    {document.truncated && <div className="notice" role="status">The trajectory ended before the rollout was fully read.</div>}
    <div className={css.ledger}>
      <TrajectoryTable t={t} turns={tableTurns} requestNumbers={document.requestNumbers} renderSlot={() => null} loadImage={() => undefined} searchMatchIndexes={visibleMatches} timelineFocusIndexes={timelineMatches} onSelectedIndexChange={setSelectedIndex} onRecordSelect={index => { if (timelineMatches && !timelineMatches.has(index)) setRange(null) }} recordSelection={recordSelection} recordFocus={recordFocus} onClearSelection={() => setRange(null)} collapsedTurns={collapsedTurns} onToggleTurn={id => setCollapsedTurns(current => toggled(current, id))} collapsedAssistants={collapsedAssistants} onToggleAssistant={id => setCollapsedAssistants(current => toggled(current, id))} collapsedTools={collapsedTools} onToggleTool={id => setCollapsedTools(current => toggled(current, id))} />
    </div>
  </div>
}
