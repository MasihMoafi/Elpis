import type { PromptResponse, ToolCall } from "@agentclientprotocol/sdk";
export type EngineTurn = {
    id?: string;
    status?: string;
    error?: {
        message?: string;
    };
};
export type EngineItem = {
    id: string;
    type?: string;
    command?: string;
    cwd?: string;
    changes?: {
        path: string;
    }[];
    server?: string;
    tool?: string;
    arguments?: unknown;
    query?: string;
    phase?: string | null;
    text?: string;
    aggregatedOutput?: string | null;
    exitCode?: number | null;
    status?: string;
};
export type EngineParams = {
    threadId: string;
    itemId: string;
    delta: string;
    turn?: EngineTurn;
    item?: EngineItem;
    plan?: {
        step: string;
        status: string;
    }[];
    command?: string;
    cwd?: string;
    reason?: string;
    grantRoot?: string;
};
export type EngineMessage = {
    id?: string | number;
    method?: string;
    params?: EngineParams;
    result?: unknown;
    error?: {
        message?: string;
    };
};
export type EngineResponses = {
    'config/read': {
        config?: {
            mcp_servers?: Record<string, unknown>;
            [key: string]: unknown;
        };
        layers?: {
            config?: Record<string, unknown>;
        }[];
    };
    'configRequirements/read': {
        requirements?: Record<string, unknown>;
    };
    'thread/start': {
        thread?: {
            id?: string;
        };
    };
    'turn/start': {
        turn?: EngineTurn;
    };
};
export type Turn = {
    id: string | null | undefined;
    cancelled: boolean;
    interrupting: boolean;
    finish: (turn: EngineTurn) => void;
    fail: (error: unknown) => void;
    result: Promise<PromptResponse>;
    started?: Promise<EngineResponses['turn/start']>;
};
export type Tool = Pick<ToolCall, 'title' | 'kind' | 'rawInput' | 'locations'>;
export type Metadata = {
    systemPrompt?: {
        append?: unknown;
    };
    elpis?: {
        ephemeral?: boolean;
        workflow?: unknown;
        name?: unknown;
    };
};
export type ClientMcpServer = {
    name: string;
    type?: string;
    command?: string;
    args?: string[];
    env?: {
        name: string;
        value: string;
    }[];
    url?: string;
    headers?: {
        name: string;
        value: string;
    }[];
};
