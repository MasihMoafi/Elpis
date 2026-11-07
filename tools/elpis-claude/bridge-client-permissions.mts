import { wireId,wireObject } from "./bridge-wire.mts";
import { createHelperPermissions } from "./bridge-helper-permissions.mts";
import type { BridgeError,RequestId,BridgeClient,BridgeMessage,ProviderOwner,BridgeResponses,Ceiling } from "./bridge-types.mts";
import type WebSocket from "ws";
import { defaultPermissionMode,defaultPermissionSettings,permissionSettingsAllowed,permissionSettings,permissionMode } from './permission-policy.mts';
import type { BridgeEnvironment } from "./bridge-server.mts";

type Dependencies = Pick<BridgeEnvironment, "automaticThreads" | "blockedAutomaticThreads" | "ceilingOf" | "explicitChatChoices" | "helperConns" | "helperScope" | "loadStoreSnapshot" | "permissionChoices" | "providerOwners" | "updateStore"> & {
  boundAccess: ReturnType<typeof createHelperPermissions>["boundAccess"];
  claudeModel: Map<string, string>;
  engineCall: { <K extends keyof BridgeResponses>(method: K, params: object, timeoutMs?: number): Promise<BridgeResponses[K]>; <T = unknown>(method: string, params: object, timeoutMs?: number): Promise<T> };
  handleMessage: (data: WebSocket.RawData | string) => void;
  permissionRefreshes: Set<RequestId>;
  permissionWrites: Map<RequestId, { threadId?: string; settings: { permissions?: string; inherit?: boolean; automatic?: boolean }; ephemeral?: boolean }>;
  toTui: (message: BridgeMessage) => void;
  ws: BridgeClient;
};

/** Apply the confirmed permission choice before routing a frontend request. */
export function createClientPermissions({ automaticThreads, blockedAutomaticThreads, boundAccess, ceilingOf, claudeModel, engineCall, explicitChatChoices, handleMessage, helperConns, helperScope, loadStoreSnapshot, permissionChoices, permissionRefreshes, permissionWrites, providerOwners, toTui, updateStore, ws }: Dependencies) {
  // Frontends send their cached engine settings on starts/resumes/turns. Those are
  // not a user choice. Only the chat menu (settings/update), or an explicitly marked
  // new-chat choice, detaches a chat from Settings > Default permissions.
  async function withPermissions(data: WebSocket.RawData | string) {
    type PermissionParams = { threadId?: string | null; elpisPermissionSource?: string | null; elpisParentThreadId?: string | null; ephemeral?: boolean | null; model?: string | null; sandbox?: string | null; permissions?: string | null; approvalPolicy?: string | null; cwd?: string | null; edits?: { keyPath: string }[] | null; [key: string]: unknown };
    let value: unknown;
    try { value = JSON.parse(String(data)); } catch { handleMessage(data); return; }
    if (!wireObject(value) || !wireId(value.id) || typeof value.method !== 'string' || !wireObject(value.params)) { handleMessage(data); return; }
    const p = value.params;
    const strings = ['threadId', 'elpisPermissionSource', 'elpisParentThreadId', 'sandbox', 'permissions', 'approvalPolicy', 'cwd'];
    if (strings.some(key => p[key] != null && typeof p[key] !== 'string')
      || (p.model != null && typeof p.model !== 'string') || (p.ephemeral != null && typeof p.ephemeral !== 'boolean')
      || (p.edits != null && (!Array.isArray(p.edits) || !p.edits.every(edit => wireObject(edit) && typeof edit.keyPath === 'string')))) { handleMessage(data); return; }
    const msg = value as { id: RequestId; method: string; params: PermissionParams };
    const method = msg.method, params = msg.params, tid = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (method === 'thread/settings/update' && p.elpisPermissionSource == null && !helperConns.has(ws) && p.model == null
      && ['approvalPolicy', 'permissions', 'sandboxPolicy'].some(key => p[key] != null)) p.elpisPermissionSource = 'chat';
    const owner = tid === undefined ? undefined : providerOwners.get(tid);
    if (owner && tid !== undefined && owner.ws !== ws && ['thread/resume', 'thread/settings/update', 'turn/start'].includes(method)) { owner.dispatch({ ...msg, params: { ...params, threadId: tid } }, ws); return; }
    if (method === 'config/batchWrite' && params.edits?.some(edit => ['approval_policy', 'approvals_reviewer', 'default_permissions', 'sandbox_mode'].includes(edit.keyPath))) permissionRefreshes.add(msg.id);
    if (!['thread/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'turn/start'].includes(method)) { handleMessage(data); return; }
    if (method !== 'thread/start' && tid === undefined) { handleMessage(data); return; }
    const source = params.elpisPermissionSource;
    delete params.elpisPermissionSource;
    const fields = ['approvalPolicy', 'approvalsReviewer', 'permissions', 'sandbox', 'sandboxPolicy'];
    const hasPermissions = fields.some(key => p[key] != null);
    const explicit = source === 'chat';
    let automatic = !!params.elpisParentThreadId || helperConns.has(ws) || (tid !== undefined && automaticThreads.has(tid)) || params.ephemeral === true || source === 'automatic';
    try {
      if (method === 'thread/settings/update') {
        // A model picker may attach its model-specific permission suggestion. A
        // model change does not detach the chat from its permission default.
        if (hasPermissions && !explicit && source !== 'default') for (const key of fields) delete p[key];
        if (explicit && tid !== undefined && (!providerOwners.has(tid) || (providerOwners.get(tid) as ProviderOwner).ws === ws)) permissionWrites.set(msg.id, { threadId: tid, settings: Object.fromEntries(fields.filter(k => p[k] != null).map(k => [k, p[k]])) });
      } else {
        const record = tid ? await permissionChoices.read(tid) : null;
        if (record && !record.inherit && !record.automatic && tid !== undefined) explicitChatChoices.add(tid);
        const scope = tid === undefined ? null : helperScope.get(tid) ?? (method === 'thread/resume' ? (await loadStoreSnapshot())._delegations?.[tid] : null);
        if (scope) automatic = true;
        let loaded = false;
        if (explicit || (record && !record.inherit && !record.automatic)) automatic = false;
        let chosen = record?.inherit ? null : record;
        if (chosen?.automatic) {
          automatic = true;
          chosen = chosen.permissions === ':read-only' || !chosen.permissions?.startsWith(':') ? { ...chosen } : null;
          if (chosen) delete chosen.automatic;
        }
        if (explicit) chosen = Object.fromEntries(fields.filter(k => p[k] != null).map(k => [k, p[k]]));
        // A deliberately scoped task (read-only or a named workflow profile) keeps
        // that scope. It still never asks the person for permission.
        if (automatic && method === 'thread/start' && (params.sandbox === 'read-only' || (params.permissions && ![':workspace', ':danger-full-access', ':bypass-permissions'].includes(params.permissions)))) {
          chosen = { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: params.permissions ?? ':read-only' };
        }
        if (method === 'thread/start' && p.elpisParentThreadId) p.elpisRequestedScope = p.sandbox === 'read-only' || p.permissions === ':read-only' ? 'read-only' : 'workspace-write';
        if (!chosen) {
          const read = await engineCall('config/read', { includeLayers: true, ...(p.cwd ? { cwd: p.cwd } : {}) });
          const mode = defaultPermissionMode(read);
          chosen = defaultPermissionSettings(read, automatic);
          // Legacy TUI's on-request + Full access was an inherited engine fallback.
          // Preserve distinguishable old chat choices; new records carry provenance.
          if (!record && tid && method === 'thread/resume' && !automatic) {
            const prior = await engineCall('thread/resume', { threadId: tid, excludeTurns: true });
            loaded = true;
            const old = permissionMode(prior), profile = prior.activePermissionProfile?.id;
            if (prior.thread?.parentThreadId || (prior.thread?.source as { subAgent?: unknown } | undefined)?.subAgent) { automatic = true; chosen = defaultPermissionSettings(read, true); }
            const own = !automatic && (old === 'bypass' || old === 'auto' || (old === 'ask' && profile === ':workspace' && mode === 'full'));
            if (own) chosen = permissionSettings(old);
            await permissionChoices.write(tid, own || automatic ? { ...chosen, ...(automatic ? { automatic: true } : {}) } : { inherit: true });
          }
        }
        const requirements = (await engineCall('configRequirements/read', {})).requirements ?? {};
        if (!permissionSettingsAllowed(chosen, requirements)) throw new Error('This permission mode is restricted by managed settings. Choose an allowed default in Settings.');
        if (automatic) { chosen = { ...chosen, approvalPolicy: 'never', permissions: chosen.permissions === ':bypass-permissions' ? ':danger-full-access' : chosen.permissions }; }
        if (scope && tid !== undefined && scope.requested !== 'read-only' && !explicitChatChoices.has(tid)) {
          const ceiling = ({ ':read-only': 'read-only', ':workspace': 'workspace-write', ':danger-full-access': 'danger-full-access' } as Record<string, Ceiling>)[chosen.permissions as string];
          if (ceiling && scope.ceiling !== ceiling) {
            scope.ceiling = ceiling;
            await updateStore(store => { const helper = store._delegations?.[tid]; if (helper) helper.ceiling = ceiling; });
          }
        }
        if (scope && tid !== undefined && !explicitChatChoices.has(tid)) boundAccess(chosen, helperScope.has(tid) ? scope.ceiling : ceilingOf(tid, scope), 'sandboxPolicy');
        // A loaded native thread ignores resume profile overrides. Apply the
        // confirmed settings before it resumes or starts either provider's turn.
        if ((method === 'thread/resume' || method === 'turn/start') && tid !== undefined) {
          if (method === 'thread/resume' && !loaded) {
            const ids = (await engineCall('thread/loaded/list', {})).data ?? [];
            if (!ids.includes(tid)) await engineCall('thread/resume', { threadId: tid, excludeTurns: true });
          }
          await engineCall('thread/settings/update', { threadId: tid, ...chosen });
          blockedAutomaticThreads.delete(tid);
        }
        for (const key of fields) delete p[key];
        Object.assign(p, chosen);
        if (automatic) { params.approvalPolicy = 'never'; if (params.permissions === ':bypass-permissions') params.permissions = ':danger-full-access'; }
        if (method === 'thread/start') permissionWrites.set(msg.id, { settings: explicit || automatic ? { ...chosen, ...(automatic ? { automatic: true } : {}) } : { inherit: true }, ephemeral: params.ephemeral === true });
        if (method === 'turn/start' && tid !== undefined && (explicit || automatic) && !claudeModel.has(tid)) permissionWrites.set(msg.id, { threadId: tid, settings: { ...chosen, ...(automatic ? { automatic: true } : {}) } });
        if (method === 'turn/start' && tid !== undefined && claudeModel.has(tid)) {
          if (explicit || automatic) await permissionChoices.write(tid, { ...chosen, ...(automatic ? { automatic: true } : {}) });
        }
      }
      handleMessage(JSON.stringify(msg));
    } catch (error) {
      permissionWrites.delete(msg.id);
      toTui({ id: msg.id, error: { code: Number.isInteger((error as BridgeError).code) ? (error as BridgeError).code : -32600, message: (error as BridgeError).message ?? String(error) } });
    }
  }
  return withPermissions;
}
