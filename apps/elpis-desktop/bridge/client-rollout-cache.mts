import { rolloutTurnModels } from './rollout-readers.mts';
import fs from 'node:fs';
import type { ClientState } from './client-state.mts';
export async function internal_withTurnModels<T extends {
    turnId: string | undefined;
}>(clientState: Pick<ClientState, 'turnModels'>, file: unknown, entries: T[]): Promise<T[]> {
    if (!Array.isArray(entries) || !entries.length)
        return entries;
    const stat = typeof file === 'string' ? await fs.promises.stat(file).catch(() => null) : null;
    if (!stat?.isFile())
        return entries;
    const key = `${stat.size}:${stat.mtimeMs}`, cached = clientState.turnModels.get(file);
    const models = cached?.key === key ? cached.value : await rolloutTurnModels(file);
    if (cached?.key !== key)
        clientState.turnModels.set(file, { key, value: models });
    return entries.map(entry => {
        const model = entry.turnId ? models.get(entry.turnId) : undefined;
        return model ? { ...entry, model } : entry;
    });
}
