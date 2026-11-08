export const errorCode = (error: unknown) => error !== null && error !== undefined &&
    (typeof error === "object" || typeof error === "function") && "code" in error
    ? error.code
    : undefined;
export class ManualFetchError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ManualFetchError";
    }
}
