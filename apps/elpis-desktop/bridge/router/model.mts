import type { DesktopClient } from '../client.mts'
import { askBackground } from '../side-turn.mts'
import { DISPATCH_INSTRUCTIONS, type DispatchModel } from './dispatch.mts'
import type { RoleModel } from './executor/settings.mts'
import { createElpisChatTransport } from './sources/elpis-chat-transport.mts'

/** All inference stays on the existing signed-in provider path; the router never reads keys. */
export function dispatchModel(client: DesktopClient, choice: () => RoleModel): DispatchModel {
  return async (candidate, signal) => {
    const model = choice()
    const conversation = (await createElpisChatTransport(client).read(candidate.thread.ref.id, undefined, signal)).slice(-30)
      .map(message => ({ role: message.role, text: message.text.slice(0, 8000) }))
    const config = await client.sideRpc('config/read', { includeLayers: false }) as { config?: { mcp_servers?: Record<string, unknown> } }
    const disabled = Object.fromEntries(Object.keys(config.config?.mcp_servers ?? {}).map(name => [`mcp_servers.${name}.enabled`, false]))
    const answer = await askBackground(client, { prompt: `${DISPATCH_INSTRUCTIONS}\n\nConversation data:\n${JSON.stringify(conversation)}\n\nCandidate data:\n${JSON.stringify(candidate)}`,
      model, effort: model.reasoningEffort, config: disabled, permissions: ':read-only', timeoutMs: 90_000,
      failed: 'Mother agent could not route the message', late: 'Mother agent routing timed out', signal })
    return JSON.parse(answer) as unknown
  }
}
