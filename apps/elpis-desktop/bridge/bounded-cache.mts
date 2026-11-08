/** Optional derived metadata, retained only while it is among the most recently used entries. */
export class BoundedCache<K, V extends object> extends Map<K, V> {
  readonly #limit: number;
  constructor(limit: number) {
    super();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Cache capacity must be positive.');
    this.#limit = limit;
  }
  override get(key: K) {
    const value = super.get(key);
    if (value !== undefined) { super.delete(key); super.set(key, value); }
    return value;
  }
  override set(key: K, value: V) {
    super.delete(key); super.set(key, value);
    if (this.size > this.#limit) {
      const oldest = this.keys().next();
      if (!oldest.done) super.delete(oldest.value);
    }
    return this;
  }
}
