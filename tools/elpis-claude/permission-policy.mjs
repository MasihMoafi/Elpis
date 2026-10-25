// Protocol permission presets shared by the desktop and the provider runtime.
export const PROFILES = { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access', 'bypass-permissions': ':bypass-permissions' };
export const PERMISSION_PRESETS = {
  ask: { approval: 'on-request', reviewer: 'user', sandbox: 'workspace-write' },
  auto: { approval: 'on-request', reviewer: 'auto_review', sandbox: 'workspace-write' },
  full: { approval: 'never', reviewer: 'user', sandbox: 'danger-full-access' },
};
export function permissionSettings(mode) {
  if (mode === 'bypass') return { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':bypass-permissions' };
  const preset = PERMISSION_PRESETS[mode];
  return preset ? { approvalPolicy: preset.approval, approvalsReviewer: preset.reviewer, permissions: PROFILES[preset.sandbox] } : null;
}
export function permissionMode(settings) {
  if (!settings?.approvalPolicy) return null;
  if (settings.approvalPolicy === 'never' && (settings.permissions ?? settings.activePermissionProfile?.id) === ':bypass-permissions') return 'bypass';
  const sandbox = (settings.sandboxPolicy ?? settings.sandbox)?.type;
  if (settings.approvalPolicy === 'never' && (sandbox === 'dangerFullAccess' || settings.permissions === ':danger-full-access' || settings.sandbox === 'danger-full-access')) return 'full';
  return ['auto_review', 'guardian_subagent'].includes(settings.approvalsReviewer) ? 'auto' : 'ask';
}
export function permissionAllowed(mode, requirements = {}) {
  const settings = permissionSettings(mode);
  return !!settings && permissionSettingsAllowed(settings, requirements);
}
export function permissionSettingsAllowed(settings, requirements = {}) {
  const sandbox = Object.keys(PROFILES).find(mode => PROFILES[mode] === settings.permissions);
  const mode = sandbox === 'bypass-permissions' ? 'danger-full-access' : sandbox;
  return (!settings.approvalPolicy || !Array.isArray(requirements.allowedApprovalPolicies) || requirements.allowedApprovalPolicies.includes(settings.approvalPolicy))
    && (!mode || !Array.isArray(requirements.allowedSandboxModes) || requirements.allowedSandboxModes.includes(mode))
    && (!settings.approvalsReviewer || !Array.isArray(requirements.allowedApprovalsReviewers) || requirements.allowedApprovalsReviewers.includes(settings.approvalsReviewer));
}
// config/read returns layers from highest to lowest precedence. An absent approval policy
// means Elpis's Full access default, even when the native engine would choose on-request.
function configuredProfile(read) {
  const config = read?.config ?? {};
  const layer = read?.layers?.find(layer => layer?.config?.default_permissions != null || layer?.config?.sandbox_mode != null)?.config ?? config;
  return layer.default_permissions != null ? config.default_permissions : PROFILES[config.sandbox_mode];
}
export function defaultPermissionMode(read) {
  const config = read?.config ?? {};
  if (config.approval_policy == null) return 'full';
  const sandbox = Object.keys(PROFILES).find(mode => PROFILES[mode] === configuredProfile(read));
  const reviewer = config.approvals_reviewer === 'guardian_subagent' ? 'auto_review' : config.approvals_reviewer ?? 'user';
  return Object.keys(PERMISSION_PRESETS).find(mode => {
    const p = PERMISSION_PRESETS[mode];
    return p.approval === config.approval_policy && p.sandbox === sandbox && (mode === 'full' || p.reviewer === reviewer);
  }) ?? 'custom';
}
export function defaultPermissionSettings(read, automatic = false) {
  const config = read?.config ?? {};
  const settings = permissionSettings(defaultPermissionMode(read)) ?? { approvalPolicy: config.approval_policy, approvalsReviewer: config.approvals_reviewer ?? 'user',
    permissions: configuredProfile(read) };
  return automatic ? { ...settings, approvalPolicy: 'never', permissions: settings.permissions === ':bypass-permissions' ? ':danger-full-access' : settings.permissions } : settings;
}
