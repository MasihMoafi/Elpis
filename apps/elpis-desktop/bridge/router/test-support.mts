/** node:test helpers for reference cases: Jest assertions and spies, Node's own timer clock. */
import { afterEach, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ModuleMocker } from "jest-mock";
const mocks = new ModuleMocker(globalThis);
export const vi = {
  fn: mocks.fn.bind(mocks),
  spyOn: mocks.spyOn.bind(mocks),
  mocked: mocks.mocked.bind(mocks),
  restoreAllMocks: () => mocks.restoreAllMocks(),
  useFakeTimers: (options?: { toFake?: string[] }) => {
    const apis =
      options?.toFake?.filter((name): name is "Date" | "setTimeout" | "setInterval" =>
        ["Date", "setTimeout", "setInterval"].includes(name),
      ) ?? (["Date", "setTimeout", "setInterval"] as const);
    mock.timers.enable({ apis: [...apis] });
  },
  useRealTimers: () => mock.timers.reset(),
  waitFor: async <T,>(
    check: () => T | Promise<T>,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<T> => {
    const deadline = performance.now() + (options.timeout ?? 3000);
    for (;;) {
      try {
        return await check();
      } catch (error) {
        if (performance.now() >= deadline) throw error;
        await setImmediate();
      }
    }
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    mock.timers.tick(ms);
    for (let n = 0; n < 10; n++) await Promise.resolve();
  },
};
afterEach(() => {
  mocks.restoreAllMocks();
  mock.timers.reset();
});
