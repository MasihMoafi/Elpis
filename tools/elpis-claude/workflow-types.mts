import type { Worker } from "node:worker_threads";
import type { checkSchema } from "./workflow-script.mts";
export type Schema = Parameters<typeof checkSchema>[0];
export type AgentOptions = {
    label?: string;
    phase?: string;
    schema?: Schema;
    model?: string;
    effort?: string;
    isolation?: string;
    agentType?: string;
};
export type Owner = {
    pid: number;
    token: string | null | undefined;
    instance: string;
};
export type AgentRecord = {
    id: string;
    key: string;
    label: string;
    phase: string | null;
    group: string | null;
    state: string;
    cached: boolean;
    threadId: string | null;
    model: string | null;
    startedAt: number | null;
    endedAt: number | null;
    attempts: number;
    error: string | null;
    worktree: string | null;
    worktreeBranch: string | null;
    resumed?: boolean;
};
export type Phase = {
    title: string;
    detail: string | null;
    model?: string;
    group?: string;
};
export type Run = {
    id: string;
    dir: string;
    name: string;
    description: string;
    whenToUse: string | null;
    phases: Phase[];
    status: string;
    origin: string;
    parentThreadId: string | null;
    cwd: string;
    model: string | null;
    provider: string | null;
    effort: string | null;
    args: unknown;
    argsGiven: boolean;
    budget: number | null;
    spent: number;
    scriptPath: string;
    resumedFrom: string | null;
    createdAt: number;
    updatedAt: number;
    endedAt: number | null;
    launches: number;
    result: unknown;
    error: string | null;
    logs: {
        at: number;
        message: string;
        group?: string;
    }[];
    agents: AgentRecord[];
    scriptErrors: {
        at: number;
        where: string;
        message: string;
    }[];
    notice: {
        state?: string;
        [key: string]: unknown;
    } | null;
    owner: Owner | null;
    currentPhase?: string | null;
};
export type NoticeRun = Pick<Run, 'id' | 'dir' | 'name' | 'status' | 'scriptPath' | 'createdAt' | 'updatedAt' | 'endedAt'> & {
    agents: {
        state: string;
    }[];
    result?: unknown;
    error?: string | null;
};
export type Executor = {
    open: (request: {
        runId: string;
        agentId: string;
        label: string;
        phase: string | null;
        model: string | null;
        providerName: string | null;
        effort: string | null;
        cwd: string;
        parentThreadId: string | null;
        signal: AbortSignal;
    }) => Promise<{
        threadId: string;
        model?: string | null;
    }>;
    turn: (request: {
        threadId: string;
        text: string;
        outputSchema: Schema | null;
        signal: AbortSignal;
    }) => Promise<{
        text?: string;
        outputTokens?: number;
    }>;
    close?: (threadId: string) => void;
};
export type Cache = {
    results: Map<string, {
        agentId: string;
        result: unknown;
    }[]>;
    unfinished: Map<string, string[]>;
    known: Set<string>;
    any: boolean;
};
export type LaunchState = {
    cache: Cache | null;
    copy: boolean;
    broken: boolean;
    count: number;
    previous: Map<string, AgentRecord>;
    seen: Set<string>;
};
export type Control = AbortController & {
    skipped?: boolean;
};
export type Live = {
    controller: AbortController;
    spent: SharedArrayBuffer;
    agents: Map<string, Control>;
    state: LaunchState;
    worker: Worker | null;
};
export type AgentMessage = {
    type: "agent";
    id?: number;
    prompt: string;
    opts: AgentOptions;
    phase?: string | null;
    group?: string | null;
};
export type WorkerMessage = AgentMessage | {
    type: "phase";
    id?: number;
    title: string;
} | {
    type: "log";
    id?: number;
    message: string;
    group?: string | null;
} | {
    type: "scriptError";
    id?: number;
    where: string;
    message: string;
} | {
    type: "child";
    id?: number;
    name: string;
    phases: Phase[];
} | {
    type: "workflow";
    id?: number;
    ref: unknown;
} | {
    type: "done";
    id?: number;
    value: unknown;
} | {
    type: "failed";
    id?: number;
    message: string;
};
export type RunnerOptions = {
    home: string;
    executor: Executor;
    concurrency?: number;
    retry?: {
        attempts?: number;
        delays?: number[];
    };
    schemaTries?: number;
    maxAgents?: number;
    maxItems?: number;
    log?: (message: string) => void;
    now?: () => number;
};
export type StartOptions = {
    script?: string | null;
    scriptPath?: string;
    args?: unknown;
    resumeFromRunId?: string;
    parentThreadId?: string | null;
    cwd?: string;
    model?: string | null;
    provider?: string | null;
    effort?: string | null;
    budget?: number | null;
    origin?: string;
};
