export type RequestOptions = {
    cacheDir: string;
    method: string;
    timeoutMs: number;
};
export type ResponseLike = {
    headers: {
        get(name: string): string | null;
    };
    ok: boolean;
    status: number;
    text(): Promise<string>;
};
export type ManualOptions = {
    manualUrl?: string | undefined;
    cacheDir?: string | undefined;
    timeoutMs?: number | undefined;
};
export type Heading = {
    level: number;
    title: string;
    startLine: number;
    endLine: number;
};
export type Outline = {
    headingCount: number;
    lineCount: number;
    text: string;
};
export type ManualStatus = {
    manualUrl: string;
    headerSha256: string;
    fetchedManualSha256: string;
    manualHashMatches: boolean;
    cacheStatus: "hit" | "updated";
    cacheDir: string;
    manualPath: string;
    outlinePath: string;
    checkedAt: string;
    lineCount: number;
    headingCount: number;
};
