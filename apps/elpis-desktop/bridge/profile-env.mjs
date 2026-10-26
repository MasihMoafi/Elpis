import path from 'node:path';

export const BRIDGE_ENDPOINT_KEYS = ['ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELPIS_BRIDGE_URL'];

/** An explicit profile owns its agents' default endpoint; intentional overrides remain explicit. */
export function profileEnvironment(home, overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (home !== undefined) {
    env.ELPIS_HOME = path.resolve(home);
    // Undefined must reach the spawn spec: omitting a key would re-inherit it from process.env.
    for (const key of BRIDGE_ENDPOINT_KEYS) if (!Object.hasOwn(overrides, key)) env[key] = undefined;
  }
  return env;
}
