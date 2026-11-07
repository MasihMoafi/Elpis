/** Model catalog through Elpis's configured providers; this never starts a model turn or reads credentials. */
import type { DesktopClient } from '../client.mts'
import { z } from 'zod'
import type { ModelCatalog } from './app/host.mts'
const Models = z.object({ data: z.array(z.looseObject({ model: z.string(), displayName: z.string().optional() })) })
export function modelCatalog(client: DesktopClient): () => Promise<ModelCatalog> {
  return async () => {
    const settings = await client.settings(), failures: ModelCatalog['failures'] = []
    const groups = await Promise.all(settings.providers.map(async provider => {
      try { const models = Models.parse(await client.models({ provider: provider.id })).data
        return { id: provider.id, name: provider.displayName, models: models.map(model => ({ id: model.model, name: model.displayName ?? model.model })) }
      } catch (error) { failures.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) }); return { id: provider.id, name: provider.id, models: [] } }
    }))
    return { default: settings.main.model ? { provider: settings.main.provider ?? 'openai', model: settings.main.model } : null, groups, failures }
  }
}
