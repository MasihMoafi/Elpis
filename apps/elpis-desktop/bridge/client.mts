import { BridgeError } from './validate.mts';
import { CustomizePage } from './customize-page.mts';
import { EventEmitter } from 'node:events';
import { MessageVersions } from './message-versions.mts';
import { RewindHistory } from './rewind-history.mts';
import { RewindSnapshots } from './rewind-snapshots.mts';
import { SkillTrash } from './skill-trash.mts';
import { SpawnLinks } from './spawn-links.mts';
import { createCloudroomVm } from './cloudroom-vm.mts';
import { createGithubConnector } from './github-connector.mts';
import { createWorkflowHistory, createWorkflowRuns } from './workflow-acp.mts';
import os from 'node:os';
import path from 'node:path';
import { profileEnvironment } from './profile-env.mts';
import { workflowDefaults, workflowModelRoutes } from "./workflow-models.mts";
import { MAX_BRIDGE_MESSAGE_BYTES, elpisHome, existingSocket } from './client-paths.mts';
import { ClientState } from './client-state.mts';
import type { ClientSocket, ClientStateOptions } from './client-state.mts';
import { ArchiveHistory } from './client-archive-history.mts';
import { internal_rpc } from './client-rpc.mts';
import { internal_bind, internal_reconnect } from './client-connection.mts';
import { internal_forgetSubscription } from './client-thread-list.mts';
import { internal_releaseNode } from './client-rewind.mts';
import { internal_workflowEnded } from './client-workflows.mts';
import type { FinishedWorkflow } from './client-workflows.mts';
import * as clientConnection from './client-connection.mts';
import * as clientThreadList from './client-thread-list.mts';
import * as clientModels from './client-models.mts';
import * as clientSettings from './client-settings.mts';
import * as clientVoice from './client-voice.mts';
import * as clientMcp from './client-mcp.mts';
import * as clientContext from './client-context.mts';
import * as clientWorkflows from './client-workflows.mts';
import * as clientThreadActions from './client-thread-actions.mts';
import * as clientRewind from './client-rewind.mts';
import * as clientTurns from './client-turns.mts';
import * as clientChanges from './client-changes.mts';
import * as clientApprovals from './client-approvals.mts';
import { ElpisChatHistory } from './router/sources/elpis-chat-history.mts';

export { MAX_BRIDGE_MESSAGE_BYTES, elpisHome, existingSocket } from './client-paths.mts';
export { speechChunks } from './client-voice.mts';
export { settledStatus } from './client-thread-list.mts';
export { BridgeError, object, text, threadId } from './validate.mts';

export type DesktopClientOptions = {
  home?: string | undefined;
  timeoutMs?: number | undefined;
  openSocket?: (() => Promise<ClientSocket>) | undefined;
  reconnectDelayMs?: number | undefined;
  settingsConfirmMs?: number | undefined;
  browserConfig?: ClientStateOptions['browserConfig'] | undefined;
  archiveDirectory?: string | undefined;
  rewindHome?: string | undefined;
  spawnLinksFile?: string | undefined;
  appHome?: string | undefined;
  githubConnector?: unknown;
  skillTrashOptions?: ConstructorParameters<typeof SkillTrash>[0] | undefined;
  workflowOptions?: (Record<string, unknown> & { env?: NodeJS.ProcessEnv | undefined }) | undefined;
  cloudroom?: unknown;
  reportAttempts?: number | undefined;
  reportRetryMs?: number | undefined;
  socketPath?: string | undefined;
  beforeConnect?: (() => void | Promise<void>) | undefined;
  background?: boolean | undefined;
};

export class DesktopClient extends EventEmitter {
  #state: ClientState;
  timeoutMs: number;
  constructor(socket: ClientSocket | EventEmitter, { home, timeoutMs = 30000, openSocket, reconnectDelayMs = 500, settingsConfirmMs = 3000, browserConfig, archiveDirectory, rewindHome, spawnLinksFile, appHome = os.homedir(), githubConnector, skillTrashOptions, workflowOptions, cloudroom, reportAttempts = 4, reportRetryMs = 2000 }: DesktopClientOptions = {}) {
    super(); this.timeoutMs = timeoutMs;
    const workflowEnv = profileEnvironment(home, workflowOptions?.env);
    const profileHome = path.resolve(home ?? elpisHome(workflowEnv));
    archiveDirectory ??= path.join(profileHome, 'desktop-archives'); rewindHome ??= path.join(profileHome, 'desktop-rewind');
    spawnLinksFile ??= path.join(profileHome, 'desktop-spawn-links.json'); githubConnector ??= createGithubConnector({ home: profileHome });
    const archiveHistory = new ArchiveHistory(archiveDirectory);
    const spawnLinks = new SpawnLinks(spawnLinksFile, { home: path.dirname(spawnLinksFile), appHome });
    const customize = new CustomizePage({ rpc: (method: string, params: unknown) => internal_rpc(this, this.#state, method, params), mcp: () => this.mcp(), settings: () => this.settings(), saveSettings: (input: unknown) => this.saveSettings(input),
      githubConnector: githubConnector as ClientStateOptions['githubConnector'], skillTrash: new SkillTrash(skillTrashOptions), appHome, home: () => profileHome });
    const rewindSnapshots = new RewindSnapshots(rewindHome);
    const versions = new MessageVersions(path.join(rewindHome, 'versions.json'));
    const rewindHistory = new RewindHistory(rewindHome, async (method: string, params: Record<string, unknown>) => {
      const result = await internal_rpc(this, this.#state, method, params);
      if (method === 'thread/archive') internal_forgetSubscription.call(this, this.#state, params.threadId);
      return result as Awaited<ReturnType<ConstructorParameters<typeof RewindHistory>[1]>>;
    });
    // His CloudRoom VM (bridge/cloudroom-vm.mts): its sign-in lives in this profile's home, beside the provider keys.
    cloudroom ??= (createCloudroomVm as (options: { home: string }) => ReturnType<typeof createCloudroomVm>)({ home: profileHome });
    const workflowRuns = (createWorkflowRuns as (options: Record<string, unknown>) => ReturnType<typeof createWorkflowRuns>)({ stateDir: path.join(profileHome, 'desktop-workflows'), cloudroom,
      onSession: (_record: unknown, _task: unknown, id: string) => { this.#state.known.add(id); return () => void internal_releaseNode.call(this, this.#state, id); }, onEnd: (record: FinishedWorkflow) => internal_workflowEnded.call(this, this.#state, record),
      observeThread: (id: unknown) => this.readThreadMetadata(id),
      listThreadDescendants: (options: Parameters<DesktopClient['listThreads']>[0]) => this.listThreads(options),
      modelRoutes: async () => {
        const [catalog, providers, policy] = await Promise.all([this.models(), this.providers(), internal_rpc(this, this.#state, 'configRequirements/read', {}).catch(() => null)]);
        // Unknown managed policy cannot authorize a different connection.
        return policy === null ? [] : workflowModelRoutes(catalog.data ?? [], providers, policy.requirements as Parameters<typeof workflowModelRoutes>[2]);
      },
      // Default models for a run's agents, from the real catalogue: Antigravity's and Claude's in the main list.
      // A list that cannot be read in time leaves its default empty, so the run keeps its earlier choice.
      modelDefaults: async () => {
        // The fallback timer is cleared once the list arrives, so a closed client never waits 15 s to exit.
        const within = <T,>(promise: Promise<T>): Promise<T | null> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(resolve, 15000, null); })]).catch(() => null).finally(() => clearTimeout(timer));
        };
        return workflowDefaults((await within(this.models()))?.data ?? []);
      }, ...workflowOptions,
      env: workflowEnv });
    const workflowHistory = createWorkflowHistory(path.join(profileHome, 'desktop-workflow-history.json'));
    const transport = socket as ClientSocket;
    this.#state = new ClientState({ socket: transport, openSocket, browserConfig, archiveHistory, spawnLinks, appHome, chatHistory: new ElpisChatHistory(profileHome),
      rewindSnapshots, rewindHistory, versions, githubConnector: githubConnector as ClientStateOptions['githubConnector'], customize, cloudroom: cloudroom as ClientStateOptions['cloudroom'], workflowRuns: workflowRuns as unknown as ClientStateOptions['workflowRuns'], workflowHistory,
      reportAttempts, reportRetryMs, retryDelay: reconnectDelayMs, settingsConfirmMs });
    internal_bind.call(this, this.#state, transport);
  }
  static async connect(options: DesktopClientOptions = {}) {
    const { default: WebSocket } = await import('ws' as string) as { default: new (address: string, options?: { maxPayload?: number }) => ClientSocket & { once(event: string, listener: (...args: unknown[]) => void): void; terminate(): void } };
    const openSocket = async () => {
      await options.beforeConnect?.();
      // An explicitly isolated profile must not inherit another profile's ambient socket override.
      const socketEnv = profileEnvironment(options.home);
      const socketPath = existingSocket(options.socketPath, socketEnv);
      const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: MAX_BRIDGE_MESSAGE_BYTES });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new BridgeError('Bridge connection timed out', 504)); }, 10000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new BridgeError('Could not connect to the existing Elpis bridge', 503)); });
      });
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
  async sideRpc(method: Parameters<typeof clientConnection.impl_sideRpc>[1], params: Parameters<typeof clientConnection.impl_sideRpc>[2] = {}) { return clientConnection.impl_sideRpc.call(this, this.#state, method, params); }
  async listThreads(options: Parameters<typeof clientThreadList.impl_listThreads>[1] = {}) { return clientThreadList.impl_listThreads.call(this, this.#state, options); }
  async listArchivedThreads(options: Parameters<typeof clientThreadList.impl_listArchivedThreads>[1] = {}) { return clientThreadList.impl_listArchivedThreads.call(this, this.#state, options); }
  async readThreadMetadata(id?: unknown) { return clientThreadList.impl_readThreadMetadata.call(this, this.#state, id); }
  async readThread(id: unknown, options: Parameters<typeof clientThreadList.impl_readThread>[2] = {}) { return clientThreadList.impl_readThread.call(this, this.#state, id, options); }
  async appendAssistant(id: string, reply: { id: string; text: string }) { return clientThreadActions.impl_appendAssistant.call(this, this.#state, id, reply); }
  async appendUser(id: string, message: import('./router/sources/elpis-chat-history.mts').ChatMessage) { return clientThreadActions.impl_appendUser.call(this, this.#state, id, message); }
  async readPrompts(id?: unknown) { return clientThreadList.impl_readPrompts.call(this, this.#state, id); }
  async media(id?: unknown, turn?: unknown, itemId?: unknown, inputIndex?: unknown) { return clientThreadList.impl_media.call(this, this.#state, id, turn, itemId, inputIndex); }
  async models(options: Parameters<typeof clientModels.impl_models>[1] = {}) { return clientModels.impl_models.call(this, this.#state, options); }
  async settings() { return clientSettings.impl_settings.call(this, this.#state); }
  async saveSettings(input?: unknown) { return clientSettings.impl_saveSettings.call(this, this.#state, input); }
  async savePruner(input?: unknown) { return clientSettings.impl_savePruner.call(this, this.#state, input); }
  async providers() { return clientSettings.impl_providers.call(this, this.#state); }
  async providerSettings() { return clientSettings.impl_providerSettings.call(this, this.#state); }
  async readAloudProvider(id?: unknown) { return clientSettings.impl_readAloudProvider.call(this, this.#state, id); }
  async saveProviderKey(input?: unknown) { return clientSettings.impl_saveProviderKey.call(this, this.#state, input); }
  async saveProvider(input?: unknown) { return clientSettings.impl_saveProvider.call(this, this.#state, input); }
  async signIn(body?: unknown) { return clientSettings.impl_signIn.call(this, this.#state, body); }
  async claudeAccounts(input?: unknown) { return clientSettings.impl_claudeAccounts.call(this, this.#state, input); }
  async mcp() { return clientSettings.impl_mcp.call(this, this.#state); }
  customize(cwd?: Parameters<typeof clientSettings.impl_customize>[1]) { return clientSettings.impl_customize.call(this, this.#state, cwd); }
  pluginCatalog(input?: Parameters<typeof clientSettings.impl_pluginCatalog>[1]) { return clientSettings.impl_pluginCatalog.call(this, this.#state, input); }
  changePlugin(input?: unknown) { return clientSettings.impl_changePlugin.call(this, this.#state, input); }
  changeMarketplace(input?: unknown) { return clientSettings.impl_changeMarketplace.call(this, this.#state, input); }
  setGithubConnector(input?: unknown) { return clientSettings.impl_setGithubConnector.call(this, this.#state, input); }
  setSkill(input?: unknown) { return clientSettings.impl_setSkill.call(this, this.#state, input); }
  deleteSkill(input?: unknown) { return clientSettings.impl_deleteSkill.call(this, this.#state, input); }
  undoSkillDelete(input?: unknown) { return clientSettings.impl_undoSkillDelete.call(this, this.#state, input); }
  async hooks() { return clientSettings.impl_hooks.call(this, this.#state); }
  async saveHook(input?: unknown) { return clientSettings.impl_saveHook.call(this, this.#state, input); }
  async resetMemories(body?: unknown) { return clientSettings.impl_resetMemories.call(this, this.#state, body); }
  async voiceStatus(options0: Parameters<typeof clientVoice.impl_voiceStatus>[1] = {}) { return clientVoice.impl_voiceStatus.call(this, this.#state, options0); }
  async setVoice(body?: unknown) { return clientVoice.impl_setVoice.call(this, this.#state, body); }
  async startVoice(id: unknown, sdp: unknown, options2: Parameters<typeof clientVoice.impl_startVoice>[3] = {}) { return clientVoice.impl_startVoice.call(this, this.#state, id, sdp, options2); }
  async stopVoice(id?: unknown) { return clientVoice.impl_stopVoice.call(this, this.#state, id); }
  async createSpeechThread(id?: unknown) { return clientVoice.impl_createSpeechThread.call(this, this.#state, id); }
  async startSpeechThread(speech: unknown, sdp: unknown, options2: Parameters<typeof clientVoice.impl_startSpeechThread>[3] = {}) { return clientVoice.impl_startSpeechThread.call(this, this.#state, speech, sdp, options2); }
  async appendSpeech(id?: unknown, value?: unknown) { return clientVoice.impl_appendSpeech.call(this, this.#state, id, value); }
  async updateSpeechContext(id?: unknown, value?: unknown) { return clientVoice.impl_updateSpeechContext.call(this, this.#state, id, value); }
  warmSpeechThread(id?: unknown) { return clientVoice.impl_warmSpeechThread.call(this, this.#state, id); }
  async takeSpeechThread(id?: unknown) { return clientVoice.impl_takeSpeechThread.call(this, this.#state, id); }
  async closeSpeechThread(id?: unknown) { return clientVoice.impl_closeSpeechThread.call(this, this.#state, id); }
  async transcriptionDefinition() { return clientVoice.impl_transcriptionDefinition.call(this, this.#state); }
  async transcriptionEnvironment() { return clientVoice.impl_transcriptionEnvironment.call(this, this.#state); }
  async ragEnvironment() { return clientVoice.impl_ragEnvironment.call(this, this.#state); }
  async previewClaudeMcp() { return clientMcp.impl_previewClaudeMcp.call(this, this.#state); }
  async importClaudeMcp(input?: unknown) { return clientMcp.impl_importClaudeMcp.call(this, this.#state, input); }
  async saveMcp(input?: unknown) { return clientMcp.impl_saveMcp.call(this, this.#state, input); }
  async contextFiles(id?: unknown) { return clientContext.impl_contextFiles.call(this, this.#state, id); }
  async goal(id?: unknown) { return clientContext.impl_goal.call(this, this.#state, id); }
  async setGoal(id?: unknown, input?: unknown) { return clientContext.impl_setGoal.call(this, this.#state, id, input); }
  async sessionContext(id?: unknown) { return clientContext.impl_sessionContext.call(this, this.#state, id); }
  async createSessionIntent(id?: unknown, input?: unknown) { return clientContext.impl_createSessionIntent.call(this, this.#state, id, input); }
  async setContextFile(id?: unknown, input?: unknown) { return clientContext.impl_setContextFile.call(this, this.#state, id, input); }
  async context(id?: unknown) { return clientContext.impl_context.call(this, this.#state, id); }
  async contextSwitches() { return clientContext.impl_contextSwitches.call(this, this.#state); }
  async saveContextSwitches(input?: unknown) { return clientContext.impl_saveContextSwitches.call(this, this.#state, input); }
  async workflowHistory() { return clientWorkflows.impl_workflowHistory.call(this, this.#state); }
  async removeWorkflowHistory(id?: unknown, body?: unknown) { return clientWorkflows.impl_removeWorkflowHistory.call(this, this.#state, id, body); }
  async undoWorkflowHistory(body?: unknown) { return clientWorkflows.impl_undoWorkflowHistory.call(this, this.#state, body); }
  async workflows(id?: unknown) { return clientWorkflows.impl_workflows.call(this, this.#state, id); }
  async workflowRun(id?: unknown) { return clientWorkflows.impl_workflowRun.call(this, this.#state, id); }
  async workflowAgentOutput(id?: unknown, taskId?: unknown) { return clientWorkflows.impl_workflowAgentOutput.call(this, this.#state, id, taskId); }
  async scriptRuns(threadIdValue?: unknown) { return clientWorkflows.impl_scriptRuns.call(this, this.#state, threadIdValue); }
  async scriptRun(runId?: unknown) { return clientWorkflows.impl_scriptRun.call(this, this.#state, runId); }
  async startScriptRun(body?: unknown) { return clientWorkflows.impl_startScriptRun.call(this, this.#state, body); }
  async stopScriptRun(runId?: unknown) { return clientWorkflows.impl_stopScriptRun.call(this, this.#state, runId); }
  async resumeScriptRun(runId?: unknown) { return clientWorkflows.impl_resumeScriptRun.call(this, this.#state, runId); }
  async skipScriptAgent(runId?: unknown, agentId?: unknown) { return clientWorkflows.impl_skipScriptAgent.call(this, this.#state, runId, agentId); }
  async steerWorkflow(id?: unknown, taskId?: unknown, body?: unknown) { return clientWorkflows.impl_steerWorkflow.call(this, this.#state, id, taskId, body); }
  async resumeWorkflow(id?: unknown, body?: unknown) { return clientWorkflows.impl_resumeWorkflow.call(this, this.#state, id, body); }
  async mergeWorkflow(id?: unknown, body?: unknown) { return clientWorkflows.impl_mergeWorkflow.call(this, this.#state, id, body); }
  workflowPresets() { return clientWorkflows.impl_workflowPresets.call(this, this.#state); }
  async runWorkflowPreset(body?: unknown) { return clientWorkflows.impl_runWorkflowPreset.call(this, this.#state, body); }
  async runWorkflow(body?: unknown) { return clientWorkflows.impl_runWorkflow.call(this, this.#state, body); }
  async cloudroom(input?: unknown) { return clientWorkflows.impl_cloudroom.call(this, this.#state, input); }
  async createThread(body?: unknown) { return clientThreadActions.impl_createThread.call(this, this.#state, body); }
  async deleteThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_deleteThread.call(this, this.#state, id, body); }
  async shellCommand(id?: unknown, body?: unknown) { return clientThreadActions.impl_shellCommand.call(this, this.#state, id, body); }
  async createSideChat(id?: unknown, body?: unknown) { return clientThreadActions.impl_createSideChat.call(this, this.#state, id, body); }
  async sendSideChat(id?: unknown, body?: unknown) { return clientThreadActions.impl_sendSideChat.call(this, this.#state, id, body); }
  async closeSideChat(id?: unknown, body?: unknown) { return clientThreadActions.impl_closeSideChat.call(this, this.#state, id, body); }
  async externalSessions() { return clientThreadActions.impl_externalSessions.call(this, this.#state); }
  async registerRollout(rollout?: unknown) { return clientThreadActions.impl_registerRollout.call(this, this.#state, rollout); }
  async importExternalSessions(sessions?: unknown) { return clientThreadActions.impl_importExternalSessions.call(this, this.#state, sessions); }
  async forkThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_forkThread.call(this, this.#state, id, body); }
  async continueThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_continueThread.call(this, this.#state, id, body); }
  async renameThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_renameThread.call(this, this.#state, id, body); }
  async archiveThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_archiveThread.call(this, this.#state, id, body); }
  async unarchiveThread(id?: unknown, body?: unknown) { return clientThreadActions.impl_unarchiveThread.call(this, this.#state, id, body); }
  async revert(id?: unknown, body?: unknown) { return clientRewind.impl_revert.call(this, this.#state, id, body); }
  async versions(id?: unknown, body?: unknown) { return clientRewind.impl_versions.call(this, this.#state, id, body); }
  async rewind(id?: unknown, body?: unknown) { return clientRewind.impl_rewind.call(this, this.#state, id, body); }
  async resume(id?: unknown, body?: unknown) { return clientRewind.impl_resume.call(this, this.#state, id, body); }
  async send(id?: unknown, body?: unknown) { return clientTurns.impl_send.call(this, this.#state, id, body); }
  async setServiceTier(id?: unknown, body?: unknown) { return clientTurns.impl_setServiceTier.call(this, this.#state, id, body); }
  async setEffort(id?: unknown, body?: unknown) { return clientTurns.impl_setEffort.call(this, this.#state, id, body); }
  async setPermissions(id?: unknown, body?: unknown) { return clientTurns.impl_setPermissions.call(this, this.#state, id, body); }
  async setFolder(id?: unknown, body?: unknown) { return clientTurns.impl_setFolder.call(this, this.#state, id, body); }
  async steer(id: unknown, body: unknown, options2: Parameters<typeof clientTurns.impl_steer>[3] = {}) { return clientTurns.impl_steer.call(this, this.#state, id, body, options2); }
  async interrupt(id?: unknown, body?: unknown) { return clientTurns.impl_interrupt.call(this, this.#state, id, body); }
  async compact(id?: unknown, body?: unknown) { return clientTurns.impl_compact.call(this, this.#state, id, body); }
  async review(id?: unknown, body?: unknown) { return clientTurns.impl_review.call(this, this.#state, id, body); }
  async git(id?: unknown, view?: unknown, file?: unknown) { return clientChanges.impl_git.call(this, this.#state, id, view, file); }
  async discardChange(id?: unknown, body?: unknown) { return clientChanges.impl_discardChange.call(this, this.#state, id, body); }
  answerApproval(id?: unknown, body?: unknown) { return clientApprovals.impl_answerApproval.call(this, this.#state, id, body); }
  async denyInstead(id?: unknown, body?: unknown) { return clientApprovals.impl_denyInstead.call(this, this.#state, id, body); }
}
