import { BridgeError } from './validate.mts';
import { CustomizePage } from './customize-page.mjs';
import { EventEmitter } from 'node:events';
import { MessageVersions } from './message-versions.mts';
import { RewindHistory } from './rewind-history.mts';
import { RewindSnapshots } from './rewind-snapshots.mts';
import { SkillTrash } from './skill-trash.mts';
import { SpawnLinks } from './spawn-links.mjs';
import { createCloudroomVm } from './cloudroom-vm.mjs';
import { createGithubConnector } from './github-connector.mjs';
import { createWorkflowHistory, createWorkflowRuns } from './workflow-acp.mjs';
import os from 'node:os';
import path from 'node:path';
import { profileEnvironment } from './profile-env.mts';
import { workflowDefaults, workflowModelRoutes } from "./workflow-models.mts";
import { MAX_BRIDGE_MESSAGE_BYTES, elpisHome, existingSocket } from './client-paths.mjs';
import { ClientState } from './client-state.mjs';
import { ArchiveHistory } from './client-archive-history.mjs';
import { internal_bind, internal_reconnect, internal_rpc } from './client-connection.mjs';
import { internal_forgetSubscription } from './client-thread-list.mjs';
import { internal_releaseNode } from './client-rewind.mjs';
import { internal_workflowEnded } from './client-workflows.mjs';
import * as clientConnection from './client-connection.mjs';
import * as clientThreadList from './client-thread-list.mjs';
import * as clientModels from './client-models.mjs';
import * as clientSettings from './client-settings.mjs';
import * as clientVoice from './client-voice.mjs';
import * as clientMcp from './client-mcp.mjs';
import * as clientContext from './client-context.mjs';
import * as clientWorkflows from './client-workflows.mjs';
import * as clientThreadActions from './client-thread-actions.mjs';
import * as clientRewind from './client-rewind.mjs';
import * as clientTurns from './client-turns.mjs';
import * as clientChanges from './client-changes.mjs';
import * as clientApprovals from './client-approvals.mjs';

export { MAX_BRIDGE_MESSAGE_BYTES, elpisHome, existingSocket } from './client-paths.mjs';
export { speechChunks } from './client-voice.mjs';
export { settledStatus } from './client-thread-list.mjs';
export { BridgeError, object, text, threadId } from './validate.mts';

/**
 * @typedef {{
 *   home?: string, timeoutMs?: number, openSocket?: () => Promise<import('./client-state.mjs').ClientSocket>,
 *   reconnectDelayMs?: number, settingsConfirmMs?: number,
 *   browserConfig?: import('./client-state.mjs').ClientStateOptions['browserConfig'],
 *   archiveDirectory?: string, rewindHome?: string, spawnLinksFile?: string, appHome?: string,
 *   githubConnector?: unknown, skillTrashOptions?: ConstructorParameters<typeof SkillTrash>[0],
 *   workflowOptions?: Record<string, unknown> & { env?: NodeJS.ProcessEnv }, cloudroom?: unknown,
 *   reportAttempts?: number, reportRetryMs?: number,
 *   socketPath?: string, beforeConnect?: () => void | Promise<void>, background?: boolean
 * }} DesktopClientOptions
 */

export class DesktopClient extends EventEmitter {
  /** @type {import('./client-state.mjs').ClientState} */ #state;
  /** @param {import('./client-state.mjs').ClientSocket | EventEmitter} socket @param {DesktopClientOptions} [options] */
  constructor(socket, { home, timeoutMs = 30000, openSocket, reconnectDelayMs = 500, settingsConfirmMs = 3000, browserConfig, archiveDirectory, rewindHome, spawnLinksFile, appHome = os.homedir(), githubConnector, skillTrashOptions, workflowOptions, cloudroom, reportAttempts = 4, reportRetryMs = 2000 } = {}) {
    super(); this.timeoutMs = timeoutMs;
    const workflowEnv = profileEnvironment(home, workflowOptions?.env);
    const profileHome = path.resolve(home ?? elpisHome(workflowEnv));
    archiveDirectory ??= path.join(profileHome, 'desktop-archives'); rewindHome ??= path.join(profileHome, 'desktop-rewind');
    spawnLinksFile ??= path.join(profileHome, 'desktop-spawn-links.json'); githubConnector ??= createGithubConnector({ home: profileHome });
    const archiveHistory = new ArchiveHistory(archiveDirectory);
    const spawnLinks = new SpawnLinks(spawnLinksFile, { home: path.dirname(spawnLinksFile), appHome });
    const customize = new CustomizePage({ rpc: (/** @type {string} */ method, /** @type {unknown} */ params) => internal_rpc.call(this, this.#state, method, params), mcp: () => this.mcp(), settings: () => this.settings(), saveSettings: (/** @type {unknown} */ input) => this.saveSettings(input),
      githubConnector, skillTrash: new SkillTrash(skillTrashOptions), appHome, home: () => profileHome });
    const rewindSnapshots = new RewindSnapshots(rewindHome);
    const versions = new MessageVersions(path.join(rewindHome, 'versions.json'));
    const rewindHistory = new RewindHistory(rewindHome, async (/** @type {string} */ method, /** @type {{ threadId?: unknown }} */ params) => {
      const result = await internal_rpc.call(this, this.#state, method, params);
      if (method === 'thread/archive') internal_forgetSubscription.call(this, this.#state, params.threadId);
      return result;
    });
    // His CloudRoom VM (bridge/cloudroom-vm.mjs): its sign-in lives in this profile's home, beside the provider keys.
    cloudroom ??= createCloudroomVm({ home: profileHome });
    const workflowRuns = createWorkflowRuns({ stateDir: path.join(profileHome, 'desktop-workflows'), cloudroom,
      onSession: (/** @type {unknown} */ _record, /** @type {unknown} */ _task, /** @type {string} */ id) => { this.#state.known.add(id); return () => void internal_releaseNode.call(this, this.#state, id); }, onEnd: (/** @type {import('./client-workflows.mjs').FinishedWorkflow} */ record) => internal_workflowEnded.call(this, this.#state, record),
      observeThread: (/** @type {unknown} */ id) => this.readThreadMetadata(id),
      listThreadDescendants: (/** @type {unknown} */ options) => this.listThreads(options),
      modelRoutes: async () => {
        const [catalog, providers, policy] = await Promise.all([this.models(), this.providers(), internal_rpc.call(this, this.#state, 'configRequirements/read', {}).catch(() => null)]);
        // Unknown managed policy cannot authorize a different connection.
        return policy === null ? [] : workflowModelRoutes(catalog.data ?? [], providers, policy.requirements);
      },
      // Default models for a run's agents, from the real catalogue: Antigravity's and Claude's in the main list.
      // A list that cannot be read in time leaves its default empty, so the run keeps its earlier choice.
      modelDefaults: async () => {
        // The fallback timer is cleared once the list arrives, so a closed client never waits 15 s to exit.
        /** @template T @param {Promise<T>} promise @returns {Promise<T | null>} */
        const within = promise => {
          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;
          return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, 15000, null); })]).catch(() => null).finally(() => clearTimeout(timer));
        };
        return workflowDefaults((await within(this.models()))?.data ?? []);
      }, ...workflowOptions,
      env: workflowEnv });
    const workflowHistory = createWorkflowHistory(path.join(profileHome, 'desktop-workflow-history.json'));
    const transport = /** @type {import('./client-state.mjs').ClientSocket} */ (socket);
    this.#state = new ClientState({ socket: transport, openSocket, browserConfig, archiveHistory, spawnLinks, appHome,
      rewindSnapshots, rewindHistory, versions, githubConnector: /** @type {import('./client-state.mjs').ClientStateOptions['githubConnector']} */ (githubConnector), customize, cloudroom: /** @type {import('./client-state.mjs').ClientStateOptions['cloudroom']} */ (cloudroom), workflowRuns, workflowHistory,
      reportAttempts, reportRetryMs, retryDelay: reconnectDelayMs, settingsConfirmMs });
    internal_bind.call(this, this.#state, transport);
  }
  /** @param {DesktopClientOptions} [options] */
  static async connect(options = {}) {
    const { default: WebSocket } = await import('ws');
    const openSocket = async () => {
      await options.beforeConnect?.();
      // An explicitly isolated profile must not inherit another profile's ambient socket override.
      const socketEnv = profileEnvironment(options.home);
      const socketPath = existingSocket(options.socketPath, socketEnv);
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_BRIDGE_MESSAGE_BYTES });
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new BridgeError('Bridge connection timed out', 504)); }, 10000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new BridgeError('Could not connect to the existing Elpis bridge', 503)); });
      }));
      return socket;
    };
    // In the background the client exists at once and connects, and reconnects, on its own: the window never waits for
    // a runtime that is still starting or missing, and shows it as connecting until it arrives.
    if (options.background) {
      const client = new DesktopClient({ on() {}, send() {}, terminate() {}, close() {} }, { ...options, openSocket });
      client.#state.closed = true; void internal_reconnect.call(client, client.#state);
      return client;
    }
    const client = new DesktopClient(await openSocket(), { ...options, openSocket });
    try { await client.initialize(); } catch (error) { client.close(); throw error; }
    return client;
  }
  async initialize() { return clientConnection.impl_initialize.call(this, this.#state); }
  get connected() { return clientConnection.impl_connected.call(this, this.#state); }
  get connectionError() { return clientConnection.impl_connectionError.call(this, this.#state); }
  hasLocalActivity() { return clientConnection.impl_hasLocalActivity.call(this, this.#state); }
  get pendingApprovals() { return clientConnection.impl_pendingApprovals.call(this, this.#state); }
  close() { return clientConnection.impl_close.call(this, this.#state); }
  /** @param {Parameters<typeof clientConnection.impl_sideRpc>[1]} [method] @param {Parameters<typeof clientConnection.impl_sideRpc>[2]} [params] */ async sideRpc(method, params = {}) { return clientConnection.impl_sideRpc.call(this, this.#state, method, params); }
  /** @param {Parameters<typeof clientThreadList.impl_listThreads>[1]} [options] */ async listThreads(options = {}) { return clientThreadList.impl_listThreads.call(this, this.#state, options); }
  /** @param {Parameters<typeof clientThreadList.impl_listArchivedThreads>[1]} [options] */ async listArchivedThreads(options = {}) { return clientThreadList.impl_listArchivedThreads.call(this, this.#state, options); }
  /** @param {Parameters<typeof clientThreadList.impl_readThreadMetadata>[1]} [id] */ async readThreadMetadata(id) { return clientThreadList.impl_readThreadMetadata.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientThreadList.impl_readThread>[1]} [id] @param {Parameters<typeof clientThreadList.impl_readThread>[2]} [options] */ async readThread(id, options = {}) { return clientThreadList.impl_readThread.call(this, this.#state, id, options); }
  /** @param {Parameters<typeof clientThreadList.impl_readPrompts>[1]} [id] */ async readPrompts(id) { return clientThreadList.impl_readPrompts.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientThreadList.impl_media>[1]} [id] @param {Parameters<typeof clientThreadList.impl_media>[2]} [turn] @param {Parameters<typeof clientThreadList.impl_media>[3]} [itemId] @param {Parameters<typeof clientThreadList.impl_media>[4]} [inputIndex] */ async media(id, turn, itemId, inputIndex) { return clientThreadList.impl_media.call(this, this.#state, id, turn, itemId, inputIndex); }
  /** @param {Parameters<typeof clientModels.impl_models>[1]} [options] */ async models(options = {}) { return clientModels.impl_models.call(this, this.#state, options); }
  async settings() { return clientSettings.impl_settings.call(this, this.#state); }
  /** @param {Parameters<typeof clientSettings.impl_saveSettings>[1]} [input] */ async saveSettings(input) { return clientSettings.impl_saveSettings.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_savePruner>[1]} [input] */ async savePruner(input) { return clientSettings.impl_savePruner.call(this, this.#state, input); }
  async providers() { return clientSettings.impl_providers.call(this, this.#state); }
  async providerSettings() { return clientSettings.impl_providerSettings.call(this, this.#state); }
  /** @param {Parameters<typeof clientSettings.impl_readAloudProvider>[1]} [id] */ async readAloudProvider(id) { return clientSettings.impl_readAloudProvider.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientSettings.impl_saveProviderKey>[1]} [input] */ async saveProviderKey(input) { return clientSettings.impl_saveProviderKey.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_saveProvider>[1]} [input] */ async saveProvider(input) { return clientSettings.impl_saveProvider.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_signIn>[1]} [body] */ async signIn(body) { return clientSettings.impl_signIn.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientSettings.impl_claudeAccounts>[1]} [input] */ async claudeAccounts(input) { return clientSettings.impl_claudeAccounts.call(this, this.#state, input); }
  async mcp() { return clientSettings.impl_mcp.call(this, this.#state); }
  /** @param {Parameters<typeof clientSettings.impl_customize>[1]} [cwd] */ customize(cwd) { return clientSettings.impl_customize.call(this, this.#state, cwd); }
  /** @param {Parameters<typeof clientSettings.impl_pluginCatalog>[1]} [input] */ pluginCatalog(input) { return clientSettings.impl_pluginCatalog.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_changePlugin>[1]} [input] */ changePlugin(input) { return clientSettings.impl_changePlugin.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_changeMarketplace>[1]} [input] */ changeMarketplace(input) { return clientSettings.impl_changeMarketplace.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_setGithubConnector>[1]} [input] */ setGithubConnector(input) { return clientSettings.impl_setGithubConnector.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_setSkill>[1]} [input] */ setSkill(input) { return clientSettings.impl_setSkill.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_deleteSkill>[1]} [input] */ deleteSkill(input) { return clientSettings.impl_deleteSkill.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_undoSkillDelete>[1]} [input] */ undoSkillDelete(input) { return clientSettings.impl_undoSkillDelete.call(this, this.#state, input); }
  async hooks() { return clientSettings.impl_hooks.call(this, this.#state); }
  /** @param {Parameters<typeof clientSettings.impl_saveHook>[1]} [input] */ async saveHook(input) { return clientSettings.impl_saveHook.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientSettings.impl_resetMemories>[1]} [body] */ async resetMemories(body) { return clientSettings.impl_resetMemories.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientVoice.impl_voiceStatus>[1]} [options0] */ async voiceStatus(options0 = {}) { return clientVoice.impl_voiceStatus.call(this, this.#state, options0); }
  /** @param {Parameters<typeof clientVoice.impl_setVoice>[1]} [body] */ async setVoice(body) { return clientVoice.impl_setVoice.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientVoice.impl_startVoice>[1]} [id] @param {Parameters<typeof clientVoice.impl_startVoice>[2]} [sdp] @param {Parameters<typeof clientVoice.impl_startVoice>[3]} [options2] */ async startVoice(id, sdp, options2 = {}) { return clientVoice.impl_startVoice.call(this, this.#state, id, sdp, options2); }
  /** @param {Parameters<typeof clientVoice.impl_stopVoice>[1]} [id] */ async stopVoice(id) { return clientVoice.impl_stopVoice.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientVoice.impl_createSpeechThread>[1]} [id] */ async createSpeechThread(id) { return clientVoice.impl_createSpeechThread.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientVoice.impl_startSpeechThread>[1]} [speech] @param {Parameters<typeof clientVoice.impl_startSpeechThread>[2]} [sdp] @param {Parameters<typeof clientVoice.impl_startSpeechThread>[3]} [options2] */ async startSpeechThread(speech, sdp, options2 = {}) { return clientVoice.impl_startSpeechThread.call(this, this.#state, speech, sdp, options2); }
  /** @param {Parameters<typeof clientVoice.impl_appendSpeech>[1]} [id] @param {Parameters<typeof clientVoice.impl_appendSpeech>[2]} [value] */ async appendSpeech(id, value) { return clientVoice.impl_appendSpeech.call(this, this.#state, id, value); }
  /** @param {Parameters<typeof clientVoice.impl_updateSpeechContext>[1]} [id] @param {Parameters<typeof clientVoice.impl_updateSpeechContext>[2]} [value] */ async updateSpeechContext(id, value) { return clientVoice.impl_updateSpeechContext.call(this, this.#state, id, value); }
  /** @param {Parameters<typeof clientVoice.impl_warmSpeechThread>[1]} [id] */ warmSpeechThread(id) { return clientVoice.impl_warmSpeechThread.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientVoice.impl_takeSpeechThread>[1]} [id] */ async takeSpeechThread(id) { return clientVoice.impl_takeSpeechThread.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientVoice.impl_closeSpeechThread>[1]} [id] */ async closeSpeechThread(id) { return clientVoice.impl_closeSpeechThread.call(this, this.#state, id); }
  async transcriptionDefinition() { return clientVoice.impl_transcriptionDefinition.call(this, this.#state); }
  async transcriptionEnvironment() { return clientVoice.impl_transcriptionEnvironment.call(this, this.#state); }
  async ragEnvironment() { return clientVoice.impl_ragEnvironment.call(this, this.#state); }
  async previewClaudeMcp() { return clientMcp.impl_previewClaudeMcp.call(this, this.#state); }
  /** @param {Parameters<typeof clientMcp.impl_importClaudeMcp>[1]} [input] */ async importClaudeMcp(input) { return clientMcp.impl_importClaudeMcp.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientMcp.impl_saveMcp>[1]} [input] */ async saveMcp(input) { return clientMcp.impl_saveMcp.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientContext.impl_contextFiles>[1]} [id] */ async contextFiles(id) { return clientContext.impl_contextFiles.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientContext.impl_goal>[1]} [id] */ async goal(id) { return clientContext.impl_goal.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientContext.impl_setGoal>[1]} [id] @param {Parameters<typeof clientContext.impl_setGoal>[2]} [input] */ async setGoal(id, input) { return clientContext.impl_setGoal.call(this, this.#state, id, input); }
  /** @param {Parameters<typeof clientContext.impl_sessionContext>[1]} [id] */ async sessionContext(id) { return clientContext.impl_sessionContext.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientContext.impl_createSessionIntent>[1]} [id] @param {Parameters<typeof clientContext.impl_createSessionIntent>[2]} [input] */ async createSessionIntent(id, input) { return clientContext.impl_createSessionIntent.call(this, this.#state, id, input); }
  /** @param {Parameters<typeof clientContext.impl_setContextFile>[1]} [id] @param {Parameters<typeof clientContext.impl_setContextFile>[2]} [input] */ async setContextFile(id, input) { return clientContext.impl_setContextFile.call(this, this.#state, id, input); }
  /** @param {Parameters<typeof clientContext.impl_context>[1]} [id] */ async context(id) { return clientContext.impl_context.call(this, this.#state, id); }
  async contextSwitches() { return clientContext.impl_contextSwitches.call(this, this.#state); }
  /** @param {Parameters<typeof clientContext.impl_saveContextSwitches>[1]} [input] */ async saveContextSwitches(input) { return clientContext.impl_saveContextSwitches.call(this, this.#state, input); }
  async workflowHistory() { return clientWorkflows.impl_workflowHistory.call(this, this.#state); }
  /** @param {Parameters<typeof clientWorkflows.impl_removeWorkflowHistory>[1]} [id] @param {Parameters<typeof clientWorkflows.impl_removeWorkflowHistory>[2]} [body] */ async removeWorkflowHistory(id, body) { return clientWorkflows.impl_removeWorkflowHistory.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_undoWorkflowHistory>[1]} [body] */ async undoWorkflowHistory(body) { return clientWorkflows.impl_undoWorkflowHistory.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_workflows>[1]} [id] */ async workflows(id) { return clientWorkflows.impl_workflows.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientWorkflows.impl_workflowRun>[1]} [id] */ async workflowRun(id) { return clientWorkflows.impl_workflowRun.call(this, this.#state, id); }
  /** @param {Parameters<typeof clientWorkflows.impl_workflowAgentOutput>[1]} [id] @param {Parameters<typeof clientWorkflows.impl_workflowAgentOutput>[2]} [taskId] */ async workflowAgentOutput(id, taskId) { return clientWorkflows.impl_workflowAgentOutput.call(this, this.#state, id, taskId); }
  /** @param {Parameters<typeof clientWorkflows.impl_scriptRuns>[1]} [threadIdValue] */ async scriptRuns(threadIdValue) { return clientWorkflows.impl_scriptRuns.call(this, this.#state, threadIdValue); }
  /** @param {Parameters<typeof clientWorkflows.impl_scriptRun>[1]} [runId] */ async scriptRun(runId) { return clientWorkflows.impl_scriptRun.call(this, this.#state, runId); }
  /** @param {Parameters<typeof clientWorkflows.impl_startScriptRun>[1]} [body] */ async startScriptRun(body) { return clientWorkflows.impl_startScriptRun.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_stopScriptRun>[1]} [runId] */ async stopScriptRun(runId) { return clientWorkflows.impl_stopScriptRun.call(this, this.#state, runId); }
  /** @param {Parameters<typeof clientWorkflows.impl_resumeScriptRun>[1]} [runId] */ async resumeScriptRun(runId) { return clientWorkflows.impl_resumeScriptRun.call(this, this.#state, runId); }
  /** @param {Parameters<typeof clientWorkflows.impl_skipScriptAgent>[1]} [runId] @param {Parameters<typeof clientWorkflows.impl_skipScriptAgent>[2]} [agentId] */ async skipScriptAgent(runId, agentId) { return clientWorkflows.impl_skipScriptAgent.call(this, this.#state, runId, agentId); }
  /** @param {Parameters<typeof clientWorkflows.impl_steerWorkflow>[1]} [id] @param {Parameters<typeof clientWorkflows.impl_steerWorkflow>[2]} [taskId] @param {Parameters<typeof clientWorkflows.impl_steerWorkflow>[3]} [body] */ async steerWorkflow(id, taskId, body) { return clientWorkflows.impl_steerWorkflow.call(this, this.#state, id, taskId, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_resumeWorkflow>[1]} [id] @param {Parameters<typeof clientWorkflows.impl_resumeWorkflow>[2]} [body] */ async resumeWorkflow(id, body) { return clientWorkflows.impl_resumeWorkflow.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_mergeWorkflow>[1]} [id] @param {Parameters<typeof clientWorkflows.impl_mergeWorkflow>[2]} [body] */ async mergeWorkflow(id, body) { return clientWorkflows.impl_mergeWorkflow.call(this, this.#state, id, body); }
  workflowPresets() { return clientWorkflows.impl_workflowPresets.call(this, this.#state); }
  /** @param {Parameters<typeof clientWorkflows.impl_runWorkflowPreset>[1]} [body] */ async runWorkflowPreset(body) { return clientWorkflows.impl_runWorkflowPreset.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_runWorkflow>[1]} [body] */ async runWorkflow(body) { return clientWorkflows.impl_runWorkflow.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientWorkflows.impl_cloudroom>[1]} [input] */ async cloudroom(input) { return clientWorkflows.impl_cloudroom.call(this, this.#state, input); }
  /** @param {Parameters<typeof clientThreadActions.impl_createThread>[1]} [body] */ async createThread(body) { return clientThreadActions.impl_createThread.call(this, this.#state, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_deleteThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_deleteThread>[2]} [body] */ async deleteThread(id, body) { return clientThreadActions.impl_deleteThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_shellCommand>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_shellCommand>[2]} [body] */ async shellCommand(id, body) { return clientThreadActions.impl_shellCommand.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_createSideChat>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_createSideChat>[2]} [body] */ async createSideChat(id, body) { return clientThreadActions.impl_createSideChat.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_sendSideChat>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_sendSideChat>[2]} [body] */ async sendSideChat(id, body) { return clientThreadActions.impl_sendSideChat.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_closeSideChat>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_closeSideChat>[2]} [body] */ async closeSideChat(id, body) { return clientThreadActions.impl_closeSideChat.call(this, this.#state, id, body); }
  async externalSessions() { return clientThreadActions.impl_externalSessions.call(this, this.#state); }
  /** @param {Parameters<typeof clientThreadActions.impl_registerRollout>[1]} [rollout] */ async registerRollout(rollout) { return clientThreadActions.impl_registerRollout.call(this, this.#state, rollout); }
  /** @param {Parameters<typeof clientThreadActions.impl_importExternalSessions>[1]} [sessions] */ async importExternalSessions(sessions) { return clientThreadActions.impl_importExternalSessions.call(this, this.#state, sessions); }
  /** @param {Parameters<typeof clientThreadActions.impl_forkThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_forkThread>[2]} [body] */ async forkThread(id, body) { return clientThreadActions.impl_forkThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_continueThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_continueThread>[2]} [body] */ async continueThread(id, body) { return clientThreadActions.impl_continueThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_renameThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_renameThread>[2]} [body] */ async renameThread(id, body) { return clientThreadActions.impl_renameThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_archiveThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_archiveThread>[2]} [body] */ async archiveThread(id, body) { return clientThreadActions.impl_archiveThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientThreadActions.impl_unarchiveThread>[1]} [id] @param {Parameters<typeof clientThreadActions.impl_unarchiveThread>[2]} [body] */ async unarchiveThread(id, body) { return clientThreadActions.impl_unarchiveThread.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientRewind.impl_revert>[1]} [id] @param {Parameters<typeof clientRewind.impl_revert>[2]} [body] */ async revert(id, body) { return clientRewind.impl_revert.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientRewind.impl_versions>[1]} [id] @param {Parameters<typeof clientRewind.impl_versions>[2]} [body] */ async versions(id, body) { return clientRewind.impl_versions.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientRewind.impl_rewind>[1]} [id] @param {Parameters<typeof clientRewind.impl_rewind>[2]} [body] */ async rewind(id, body) { return clientRewind.impl_rewind.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientRewind.impl_resume>[1]} [id] @param {Parameters<typeof clientRewind.impl_resume>[2]} [body] */ async resume(id, body) { return clientRewind.impl_resume.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_send>[1]} [id] @param {Parameters<typeof clientTurns.impl_send>[2]} [body] */ async send(id, body) { return clientTurns.impl_send.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_setServiceTier>[1]} [id] @param {Parameters<typeof clientTurns.impl_setServiceTier>[2]} [body] */ async setServiceTier(id, body) { return clientTurns.impl_setServiceTier.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_setEffort>[1]} [id] @param {Parameters<typeof clientTurns.impl_setEffort>[2]} [body] */ async setEffort(id, body) { return clientTurns.impl_setEffort.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_setPermissions>[1]} [id] @param {Parameters<typeof clientTurns.impl_setPermissions>[2]} [body] */ async setPermissions(id, body) { return clientTurns.impl_setPermissions.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_setFolder>[1]} [id] @param {Parameters<typeof clientTurns.impl_setFolder>[2]} [body] */ async setFolder(id, body) { return clientTurns.impl_setFolder.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_steer>[1]} [id] @param {Parameters<typeof clientTurns.impl_steer>[2]} [body] @param {Parameters<typeof clientTurns.impl_steer>[3]} [options2] */ async steer(id, body, options2 = {}) { return clientTurns.impl_steer.call(this, this.#state, id, body, options2); }
  /** @param {Parameters<typeof clientTurns.impl_interrupt>[1]} [id] @param {Parameters<typeof clientTurns.impl_interrupt>[2]} [body] */ async interrupt(id, body) { return clientTurns.impl_interrupt.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_compact>[1]} [id] @param {Parameters<typeof clientTurns.impl_compact>[2]} [body] */ async compact(id, body) { return clientTurns.impl_compact.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientTurns.impl_review>[1]} [id] @param {Parameters<typeof clientTurns.impl_review>[2]} [body] */ async review(id, body) { return clientTurns.impl_review.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientChanges.impl_git>[1]} [id] @param {Parameters<typeof clientChanges.impl_git>[2]} [view] @param {Parameters<typeof clientChanges.impl_git>[3]} [file] */ async git(id, view, file) { return clientChanges.impl_git.call(this, this.#state, id, view, file); }
  /** @param {Parameters<typeof clientChanges.impl_discardChange>[1]} [id] @param {Parameters<typeof clientChanges.impl_discardChange>[2]} [body] */ async discardChange(id, body) { return clientChanges.impl_discardChange.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientApprovals.impl_answerApproval>[1]} [id] @param {Parameters<typeof clientApprovals.impl_answerApproval>[2]} [body] */ answerApproval(id, body) { return clientApprovals.impl_answerApproval.call(this, this.#state, id, body); }
  /** @param {Parameters<typeof clientApprovals.impl_denyInstead>[1]} [id] @param {Parameters<typeof clientApprovals.impl_denyInstead>[2]} [body] */ async denyInstead(id, body) { return clientApprovals.impl_denyInstead.call(this, this.#state, id, body); }
}
