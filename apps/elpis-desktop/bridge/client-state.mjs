/** @typedef {import('node:events').EventEmitter & { send(value: string): void, close(): void, terminate?(): void }} ClientSocket */
/**
 * @typedef {{
 *   socket: ClientSocket,
 *   openSocket: (() => Promise<ClientSocket>) | undefined,
 *   browserConfig: { forSession?: (id: string) => object, close?: (id: string) => void, bind?: (session: string, id: string) => void } | undefined,
 *   archiveHistory: import('./client-archive-history.mjs').ArchiveHistory,
 *   spawnLinks: import('./spawn-links.mjs').SpawnLinks,
 *   rewindSnapshots: import('./rewind-snapshots.mjs').RewindSnapshots,
 *   rewindHistory: import('./rewind-history.mjs').RewindHistory,
 *   versions: import('./message-versions.mjs').MessageVersions,
 *   githubConnector: ReturnType<typeof import('./github-connector.mjs').createGithubConnector>,
 *   customize: import('./customize-page.mjs').CustomizePage,
 *   cloudroom: ReturnType<typeof import('./cloudroom-vm.mjs').createCloudroomVm>,
 *   workflowRuns: ReturnType<typeof import('./workflow-acp.mjs').createWorkflowRuns>,
 *   workflowHistory: ReturnType<typeof import('./workflow-acp.mjs').createWorkflowHistory>,
 *   reportAttempts: number, reportRetryMs: number, retryDelay: number, settingsConfirmMs: number, appHome: string
 * }} ClientStateOptions
 */
// Per-client state shared by the bridge's feature modules.
export class ClientState {
  /** @param {ClientStateOptions} options */
  constructor(options) {
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
  catalog = null;
  /** @type {string | undefined} */ claudeAccountsKey;
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
  /** @type {string | null} */ opened = null;
  checkingApprovals = new Map();
  settingsWaiters = new Map();
  turnRevisions = new Map();
  disposed = false;
  reconnecting = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ retryTimer;
  retryAttempt = 0;
  /** @type {string | null} */ connectionError = null;
  /** @type {{ chatId: string, speech: Promise<{ id: string, voice: unknown }>, timer: ReturnType<typeof setTimeout> } | null} */
  warmSpeech = null;
}
