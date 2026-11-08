import type { ArchiveHistory } from './client-archive-history.mts';
import type { CustomizePage } from './customize-page.mts';
import type { MessageVersions } from './message-versions.mts';
import type { RewindHistory } from './rewind-history.mts';
import type { RewindSnapshots } from './rewind-snapshots.mts';
import type { SpawnLinks } from './spawn-links.mts';
import type { createCloudroomVm } from './cloudroom-vm.mts';
import type { createGithubConnector } from './github-connector.mts';
import type { createWorkflowHistory, createWorkflowRuns } from './workflow-acp.mts';
import type { ElpisChatHistory } from './router/sources/elpis-chat-history.mts';
import type { RpcResponse } from './client-wire.mts';
import type { ElicitationParams } from '../lib/approvals.ts';
import type { restoredTokenUsage, rolloutShares, rolloutTurnModels, smartPruneSnapshot, tokenUsageSnapshot } from './elpis-features.mts';

type PendingRpc = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string; reading: boolean };
export type ApprovalParams = ElicitationParams & { threadId?: unknown; turnId?: unknown; permissions?: unknown; questions?: { id: string }[] | undefined; availableDecisions?: unknown[] | undefined; [key: string]: unknown };
type Approval = { id: string; wireId: unknown; method: string; params: ApprovalParams; supported: boolean; ownerThreadId: unknown; thread?: unknown };
type Cached<T> = { key: string; value: T };

export type ClientSocket = {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  send(value: string): void;
  close(): void;
  terminate?(): void;
};

export type BrowserConfig = {
  forSession?: ((id: string) => Record<string, unknown>) | undefined;
  close?: ((id: string) => void) | undefined;
  bind?: ((session: string, id: string) => void) | undefined;
  [key: string]: unknown;
};

export type ClientStateOptions = {
  chatHistory: ElpisChatHistory;
  socket: ClientSocket;
  openSocket: (() => Promise<ClientSocket>) | undefined;
  browserConfig: BrowserConfig | undefined;
  archiveHistory: ArchiveHistory;
  spawnLinks: SpawnLinks;
  rewindSnapshots: RewindSnapshots;
  rewindHistory: RewindHistory;
  versions: MessageVersions;
  githubConnector: ReturnType<typeof createGithubConnector>;
  customize: CustomizePage;
  cloudroom: ReturnType<typeof createCloudroomVm>;
  workflowRuns: ReturnType<typeof createWorkflowRuns>;
  workflowHistory: ReturnType<typeof createWorkflowHistory>;
  reportAttempts: number;
  reportRetryMs: number;
  retryDelay: number;
  settingsConfirmMs: number;
  appHome: string;
};

// Per-client state shared by the bridge's feature modules.
export interface ClientState extends ClientStateOptions {}
export class ClientState {
  constructor(options: ClientStateOptions) {
    this.chatHistory = options.chatHistory;
    this.socket = options.socket;
    this.openSocket = options.openSocket;
    this.browserConfig = options.browserConfig;
    this.archiveHistory = options.archiveHistory;
    this.spawnLinks = options.spawnLinks;
    this.rewindSnapshots = options.rewindSnapshots;
    this.rewindHistory = options.rewindHistory;
    this.versions = options.versions;
    this.githubConnector = options.githubConnector;
    this.customize = options.customize;
    this.cloudroom = options.cloudroom;
    this.workflowRuns = options.workflowRuns;
    this.workflowHistory = options.workflowHistory;
    this.reportAttempts = options.reportAttempts;
    this.reportRetryMs = options.reportRetryMs;
    this.retryDelay = options.retryDelay;
    this.settingsConfirmMs = options.settingsConfirmMs;
    this.appHome = options.appHome;
  }
  pending = new Map<string | number, PendingRpc>();
  owned = new Set<unknown>();
  known = new Set<unknown>();
  models = new Set<unknown>();
  historyOnly = new Set<unknown>();
  catalog: Promise<{ data: { model: string; serviceTiers?: { id: string }[] }[] }> | null = null;
  claudeAccountsKey: string | undefined;
  approvals = new Map<unknown, Approval>();
  mutating = new Set<unknown>();
  mutationWaiters = new Map<unknown, (() => void)[]>();
  closed = false;
  ready = false;
  attaching = new Map<unknown, Promise<{ thread: RpcResponse<'thread/read'>['thread']; followingLive?: boolean }>>();
  context = new Map<unknown, { tokenUsage?: ReturnType<typeof tokenUsageSnapshot>; smartPrune?: ReturnType<typeof smartPruneSnapshot> }>();
  restored = new Map<unknown, Cached<Awaited<ReturnType<typeof restoredTokenUsage>>>>();
  shares = new Map<unknown, Cached<Awaited<ReturnType<typeof rolloutShares>>>>();
  turnModels = new Map<unknown, Cached<Awaited<ReturnType<typeof rolloutTurnModels>>>>();
  liveTurnModels = new Map<string, string>();
  side = new Set<unknown>();
  sideChats = new Map<unknown, { turnId: string | null | undefined; starting: boolean; pending: Promise<unknown> | null; closing: boolean }>();
  interviewThreads = new Set<unknown>();
  workflowTitles = new Map<unknown, { source: string; title: string; rootThreadId: string }>();
  workflowLookups = new Map<unknown, Promise<RpcResponse<'workGraph/list'> | null>>();
  endedNodes = new Set<unknown>();
  opened: string | null = null;
  checkingApprovals = new Map<unknown, object>();
  settingsWaiters = new Map<unknown, Set<(settings: unknown) => void>>();
  turnRevisions = new Map<unknown, number>();
  disposed = false;
  reconnecting = false;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt = 0;
  connectionError: string | null = null;
  warmSpeech: { chatId: string; speech: Promise<{ id: string; voice: unknown }>; timer: ReturnType<typeof setTimeout> } | null = null;
}
