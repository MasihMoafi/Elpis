// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
export type Stored = Record<string, unknown>;
export const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
/** Runs one migration step, prefixing any thrown error with the name of the record that failed. */
export function step<T>(record: string, work: () => T): T {
    try {
        return work();
    }
    catch (error) {
        throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}
