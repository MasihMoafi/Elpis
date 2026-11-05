/* Source: packages/client/ui-trajectory/src/client/layout.ts · Copyright (c) 2026 DeepSeek, MIT License */
import type { TrajectoryCellProps } from './trajectory-record'
export interface TrajectoryGroupModel { title: string; description?: string; cells: readonly TrajectoryCellProps[] }
export interface TrajectoryTurnModel { turn: number | null; groups: readonly TrajectoryGroupModel[] }
