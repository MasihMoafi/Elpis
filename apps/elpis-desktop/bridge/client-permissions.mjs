import { BridgeError, object, text } from './validate.mjs';
import { PERMISSION_PRESETS, PROFILES } from './permission-presets.mjs';

/** The ChatGPT app's three permission modes, plus Elpis's Bypass permissions, as Elpis approval settings and
 * the engine's built-in permission profiles. Bypass is `:bypass-permissions`: Full access plus no refusals
 * (codex-rs/protocol/src/models.rs bypass_permissions_active). Each mode is a named profile, not a bare sandbox,
 * because a reopened chat gets back its last profile id; a sandbox chosen alone fell back to the config's. */
const BYPASS_PROFILE = ':bypass-permissions';

/** @type {Record<string, { approvalPolicy: string, approvalsReviewer: string, permissions: unknown }>} */
export const PERMISSIONS = {
  ...Object.fromEntries(Object.entries(PERMISSION_PRESETS).map(([mode, preset]) => [mode, { approvalPolicy: preset.approval, approvalsReviewer: preset.reviewer, permissions: /** @type {Record<string, string>} */ (PROFILES)[preset.sandbox] }])),
  bypass: { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: BYPASS_PROFILE },
};

/** @param {unknown} value */
export function permissionMode(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !Object.hasOwn(PERMISSIONS, value)) throw new BridgeError('Choose a permission mode: ask, auto, full or bypass');
  return value;
}

/** Plan mode or the default mode for a turn, as the terminal's Shift+Tab switches them; the
 * engine keeps the mode for later turns, so it is sent only when it changes. */
/** @param {unknown} value @param {unknown} model @param {unknown} effort */
export function collaborationMode(value, model, effort) {
  if (value === undefined) return {};
  if (value !== 'plan' && value !== 'default') throw new BridgeError('Choose a chat mode: plan or default');
  if (!model) throw new BridgeError('Choose a model before switching Plan mode', 409);
  return { collaborationMode: { mode: value, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } } };
}

/** One of the terminal's /review targets (codex-rs/app-server-protocol review.rs), checked field by field. */
/** @param {unknown} value */
export function reviewTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('Unknown review target');
  const target = /** @type {Record<string, unknown>} */ (value);
  switch (target.type) {
    case 'uncommittedChanges': object(target, ['type']); return { type: target.type };
    case 'baseBranch': {
      object(target, ['type', 'branch']);
      const branch = text(target.branch, 'branch name', 255);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(branch)) throw new BridgeError('Invalid branch name');
      return { type: target.type, branch };
    }
    case 'commit': {
      object(target, ['type', 'sha', 'title']);
      if (typeof target.sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(target.sha)) throw new BridgeError('Invalid commit');
      return { type: target.type, sha: target.sha, ...(target.title === undefined ? {} : { title: text(target.title, 'commit title', 500) }) };
    }
    case 'custom': object(target, ['type', 'instructions']); return { type: target.type, instructions: text(target.instructions, 'review instructions', 32000) };
    default: throw new BridgeError('Unknown review target');
  }
}

/** @param {string | undefined} mode */
export const permissionSetting = mode => mode ? { ...PERMISSIONS[mode] } : {};

/** The mode a chat runs in, read back from its approval, sandbox and profile settings: a resume
 * result (`sandbox`) or the engine's thread/settings/updated (`sandboxPolicy`). */
/** @param {unknown} input */
export function modeOf(input) {
  const result = /** @type {{ approvalPolicy?: unknown, activePermissionProfile?: { id?: unknown } | null, sandbox?: { type?: unknown } | null, sandboxPolicy?: { type?: unknown } | null, approvalsReviewer?: unknown } | null | undefined} */ (input);
  if (!result?.approvalPolicy) return null;
  if (result.activePermissionProfile?.id === BYPASS_PROFILE && result.approvalPolicy === 'never') return 'bypass';
  if ((result.sandbox ?? result.sandboxPolicy)?.type === 'dangerFullAccess' && result.approvalPolicy === 'never') return 'full';
  return result.approvalsReviewer === 'auto_review' || result.approvalsReviewer === 'guardian_subagent' ? 'auto' : 'ask';
}
