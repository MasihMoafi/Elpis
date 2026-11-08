// Generated from codex-rs/skills/assets-src/openai-docs/manual-errors.mts by scripts/emit-compat-js.mts; do not edit.
export const errorCode = (error         ) => error !== null && error !== undefined &&
    (typeof error === "object" || typeof error === "function") && "code" in error
    ? error.code
    : undefined;
export class ManualFetchError extends Error {
    constructor(message        , options               ) {
        super(message, options);
        this.name = "ManualFetchError";
    }
}
