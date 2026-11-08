import { BridgeError, object, text } from "./validate.mts";
import { hooksSnapshot } from "./elpis-features.mts";
import { internal_rpc } from "./client-rpc.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";
import type { CustomizePage } from "./customize-page.mts";

// The Customize page (skills, plugins, connectors): bridge/customize-page.mts.
export function impl_customize(
  this: DesktopClient,
  clientState: ClientState,
  cwd?: Parameters<CustomizePage["customize"]>[0],
): ReturnType<CustomizePage["customize"]> {
  return clientState.customize.customize(cwd);
}

export function impl_pluginCatalog(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["pluginCatalog"]>[0],
): ReturnType<CustomizePage["pluginCatalog"]> {
  return clientState.customize.pluginCatalog(input);
}

export function impl_changePlugin(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["changePlugin"]>[0],
) {
  return clientState.customize.changePlugin(input);
}

export function impl_changeMarketplace(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["changeMarketplace"]>[0],
) {
  return clientState.customize.changeMarketplace(input);
}

export function impl_setGithubConnector(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["setGithubConnector"]>[0],
) {
  return clientState.customize.setGithubConnector(input);
}

export function impl_setSkill(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["setSkill"]>[0],
) {
  return clientState.customize.setSkill(input);
}

export function impl_deleteSkill(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["deleteSkill"]>[0],
) {
  return clientState.customize.deleteSkill(input);
}

export function impl_undoSkillDelete(
  this: DesktopClient,
  clientState: ClientState,
  input?: Parameters<CustomizePage["undoSkillDelete"]>[0],
) {
  return clientState.customize.undoSkillDelete(input);
}

export async function impl_hooks(this: DesktopClient, clientState: ClientState) {
  const [list, read] = await Promise.all([
    internal_rpc(this, clientState, "hooks/list", {}),
    internal_rpc(this, clientState, "config/read", { includeLayers: true }),
  ]);
  return hooksSnapshot(list as Parameters<typeof hooksSnapshot>[0], read);
}

/** Enables, disables or trusts one discovered hook through native `hooks.state`, as the Elpis terminal does. */
export async function impl_saveHook(this: DesktopClient, clientState: ClientState, raw?: unknown) {
  const input = object(raw, ["version", "key", "enabled", "trust"]) as Record<string, unknown>;
  text(input.version, "hooks version", 200);
  text(input.key, "hook", 1000);
  if ((input.enabled === undefined) === (input.trust === undefined))
    throw new BridgeError("Choose enable, disable or trust");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new BridgeError("Choose enabled or disabled");
  if (input.trust !== undefined && input.trust !== true) throw new BridgeError("Trust must be confirmed");
  const current = await this.hooks();
  if (!current.write.available || current.version !== input.version)
    throw new BridgeError("Settings changed in another client. Reload settings before saving again.", 409);
  const hook = current.hooks.find(item => item.key === input.key);
  if (!hook) throw new BridgeError("This hook is no longer configured. Reload hooks.", 409);
  if (hook.managed) throw new BridgeError("Managed hooks cannot be changed here", 403);
  if (input.trust && !hook.currentHash) throw new BridgeError("Elpis did not report this hook’s current version", 502);
  const state = input.trust ? { trusted_hash: hook.currentHash } : { enabled: input.enabled };
  await internal_rpc(this, clientState, "config/batchWrite", {
    edits: [{ keyPath: "hooks.state", value: { [hook.key]: state }, mergeStrategy: "upsert" }],
    expectedVersion: input.version,
    reloadUserConfig: true,
  });
  return this.hooks();
}
