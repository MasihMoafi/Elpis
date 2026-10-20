/** Rate-limit changes affect usage, while sign-in and provider changes affect model choices. */
export const changesModelCatalog = (method: string): boolean => method !== "account/rateLimits/updated";
