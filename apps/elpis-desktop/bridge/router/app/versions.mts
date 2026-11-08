// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/versions.ts.
/** Versioned record storage backed by numbered snapshots and a current-revision pointer in the Store KV table. */
import type { Family, Key } from "../sources/kv.mts";
import type { Store } from "./store.mts";

/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
 */
export class Versions<V extends { revision: number }> {
  private readonly store: Pick<Store, "get" | "set" | "keys" | "atomic">;
  private readonly pointer: Key<number>;
  private readonly family: Family<V, [revision: number]>;
  constructor(
    store: Pick<Store, "get" | "set" | "keys" | "atomic">,
    pointer: Key<number>,
    family: Family<V, [revision: number]>,
  ) {
    this.store = store;
    this.pointer = pointer;
    this.family = family;
  }
  /** Current revision number, or `0` before the first save. */
  revision(): number {
    return this.store.get(this.pointer) ?? 0;
  }
  /** Current snapshot, or `undefined` before the first save. */
  current(): V | undefined {
    const revision = this.store.get(this.pointer);
    return revision === undefined ? undefined : this.get(revision);
  }
  get(revision: number): V | undefined {
    return this.store.get(this.family(revision));
  }
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      const version = make(this.revision() + 1);
      this.store.set(this.family(version.revision), version);
      this.store.set(this.pointer, version.revision);
      return version;
    });
  }
  /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
  keep(version: V): void {
    this.store.set(this.family(version.revision), version);
  }
  list(limit = Infinity): V[] {
    return this.store
      .keys(this.family)
      .flatMap(name => this.store.get(name) ?? [])
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit);
  }
}
