/** Externally resolvable promises for cancellation and recovery tests. */
export function deferred<T = void>() {
  return Promise.withResolvers<T>();
}
