import type { ArchiveHistory } from './client-archive-history.mts';
import type { CustomizePage } from './customize-page.mts';
import type { MessageVersions } from './message-versions.mts';
import type { RewindHistory } from './rewind-history.mts';
import type { RewindSnapshots } from './rewind-snapshots.mts';
import type { SpawnLinks } from './spawn-links.mjs';
import type { createCloudroomVm } from './cloudroom-vm.mjs';
import type { createGithubConnector } from './github-connector.mts';
import type { createWorkflowHistory, createWorkflowRuns } from './workflow-acp.mts';

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
  pending = new Map();
  owned = new Set();
  known = new Set();
  models = new Set();
  historyOnly = new Set();
  catalog: Promise<{ data: { model: string; serviceTiers?: { id: string }[] }[] }> | null = null;
  claudeAccountsKey: string | undefined;
  approvals = new Map();
  mutating = new Set();
  mutationWaiters = new Map();
  closed = false;
  ready = false;
  attaching = new Map();
  context = new Map();
  restored = new Map();
  shares = new Map();
  turnModels = new Map();
  liveTurnModels = new Map();
  side = new Set();
  sideChats = new Map();
  interviewThreads = new Set();
  workflowTitles = new Map();
  workflowLookups = new Map();
  endedNodes = new Set();
  opened: string | null = null;
  checkingApprovals = new Map();
  settingsWaiters = new Map();
  turnRevisions = new Map();
  disposed = false;
  reconnecting = false;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt = 0;
  connectionError: string | null = null;
  warmSpeech: { chatId: string; speech: Promise<{ id: string; voice: unknown }>; timer: ReturnType<typeof setTimeout> } | null = null;
}
