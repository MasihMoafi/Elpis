export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

/** Native Codex engines connect directly; the provider bridge keeps Mother's proxy. */
export function directEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const next = { ...env };
    for (const name of [...PROXY_ENV_NAMES, "NODE_USE_ENV_PROXY"]) delete next[name];
    return next;
}
