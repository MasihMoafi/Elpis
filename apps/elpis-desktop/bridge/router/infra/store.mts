// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/store.ts and src/app/runtime.ts.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { elpisHome } from "../../client-paths.mts";
import { Store } from "../app/store.mts";
import type { Family, Key } from "../sources/kv.mts";
const require = createRequire(import.meta.url);
const { lockSync } = require("proper-lockfile") as {
  lockSync(path: string, options: { stale: number; onCompromised: (error: Error) => void }): () => void;
};

/** One lock per profile, acquired before SQLite initialization or migration. */
export class RouterStore extends Store {
  private readonly release: () => void;
  constructor(
    home = elpisHome(),
    onCompromised: (error: Error) => void = error => {
      throw error;
    },
  ) {
    const dir = join(home, "router");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const release = lockSync(dir, { stale: 30_000, onCompromised });
    try {
      super(join(dir, "orchestrator.sqlite"));
    } catch (error) {
      release();
      throw error;
    }
    this.release = release;
  }
  override close(): void {
    try {
      super.close();
    } finally {
      this.release();
    }
  }
  readonly state = {
    get: <V,>(key: Key<V>): V | undefined => this.get(key),
    set: <V,>(key: Key<V>, value: V | undefined): void => {
      if (value === undefined) this.delete(key);
      else this.set(key, value);
    },
    keys: <V,>(family: Family<V, never>): Key<V>[] => this.keys(family),
  };
}
