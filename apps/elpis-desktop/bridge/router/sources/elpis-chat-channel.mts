// Ported from dsh-superagent (MIT), src/sources/feishu-channel.ts (shape)
import type { SourceChannel } from './kind.mts'
import type { ElpisChatConfig, ElpisChatTransport } from './elpis-chat.mts'

export function elpisChatChannel(transport: ElpisChatTransport): SourceChannel<ElpisChatConfig> {
  return {
    allowed: (address, config) => !!config.threadId && address.threadId === config.threadId,
    async send(_host, message) {
      const target = message.channel.address.threadId
      if (!target || !message.id) throw new Error('Missing Elpis chat reply target or ID')
      return transport.appendAssistant(target, { id: message.id, text: message.text })
    },
    link: address => ({ url: '', label: { zh: 'Elpis 聊天', en: 'Elpis chat' }, ...address.messageId ? { triggerId: address.messageId } : {} }),
  }
}
