import { rolloutTurnModels } from "./rollout-readers.mts";
import fs from "node:fs";
import type { ClientState } from "./client-state.mts";
/** Each saved turn's model, remembered per transcript. A turn's label never changes, so a growing transcript (a working
 * chat) is not searched again for turns already answered; an older-page search that finds nothing is remembered too, since
 * it read the whole file (10 Nov: re-searching a 1.1 GB chat on every page froze the app's main process). */
export async function internal_withTurnModels<
  T extends {
    turnId: string | undefined;
  },
>(clientState: Pick<ClientState, "turnModels">, file: unknown, entries: T[], older = false): Promise<T[]> {
  if (!Array.isArray(entries) || !entries.length) return entries;
  const stat = typeof file === "string" ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat?.isFile()) return entries;
  const wanted = new Set(entries.flatMap(entry => (entry.turnId ? [entry.turnId] : [])));
  if (!wanted.size) return entries;
  let cached = clientState.turnModels.get(file);
  if (cached?.key !== String(stat.ino)) {
    cached = { key: String(stat.ino), value: new Map() };
    clientState.turnModels.set(file, cached);
  }
  const known = cached.value;
  const missing = new Set([...wanted].filter(turnId => !known.has(turnId)));
  if (missing.size) {
    const found = await rolloutTurnModels(file, undefined, missing, older);
    for (const turnId of missing) {
      const model = found.get(turnId);
      if (model) known.set(turnId, model);
      else if (older) known.set(turnId, "");
    }
  }
  return entries.map(entry => {
    const model = entry.turnId ? known.get(entry.turnId) : undefined;
    return model ? { ...entry, model } : entry;
  });
}
