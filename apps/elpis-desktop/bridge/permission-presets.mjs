// The permission modes Settings and the composer share; a leaf module, so the bridge's modules can import it in any order.
/** The built-in permission profiles by the sandbox each one is (codex-rs/protocol/src/models.rs). A default naming Bypass
 * permissions reads as custom; Settings cannot select it (Bypass is chosen per chat). */
export const PROFILES = { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access', 'bypass-permissions': ':bypass-permissions' };
/** The composer's modes as Codex's approval presets (codex-rs/utils/approval-presets builtin_approval_presets): each
 * pairs an approval policy and reviewer with a sandbox, saved together. Bypass permissions is per chat only. */
export const PERMISSION_PRESETS = {
  ask: { approval: 'on-request', reviewer: 'user', sandbox: 'workspace-write' },
  auto: { approval: 'on-request', reviewer: 'auto_review', sandbox: 'workspace-write' },
  full: { approval: 'never', reviewer: 'user', sandbox: 'danger-full-access' },
};
