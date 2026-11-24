export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

// Native Codex engines inherit the launching terminal/bridge environment, including proxy settings.

export function directEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const direct = { ...env };
  for (const name of [...PROXY_ENV_NAMES, "FTP_PROXY", "ftp_proxy", "NODE_USE_ENV_PROXY"]) delete direct[name];
  return direct;
}
