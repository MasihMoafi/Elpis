/** GitHub always uses gh's saved CLI login and the direct network route. */
export const GH_UNSET = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'GH_TOKEN', 'GITHUB_TOKEN'] as const
export const GH_DIRECT_ARGS = GH_UNSET.flatMap(name => ['-u', name])
export function githubEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input }
  for (const name of GH_UNSET) delete env[name]
  return env
}
