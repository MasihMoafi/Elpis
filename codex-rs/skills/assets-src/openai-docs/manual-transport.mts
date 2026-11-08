import { errorCode, ManualFetchError } from './manual-errors.mts';
import { tempFilePath } from './manual-cache.mts';
import type { RequestOptions, ResponseLike } from './manual-types.mts';
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";

import process from "node:process";
import { promisify } from "node:util";
export const HASH_HEADER = "x-content-sha256";
export const USER_AGENT = "codex-openai-docs";
export const execFileAsync = promisify(execFile);
export const withTimeout = async <T,>(promiseFactory: (signal: AbortSignal) => Promise<T>, timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await promiseFactory(controller.signal);
    }
    finally {
        clearTimeout(timeout);
    }
};
export const proxyConfigured = () => process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy;
export const responseHeaders = (headers: Map<string, string>) => ({
    get(name: string) {
        return headers.get(name.toLowerCase()) ?? null;
    },
});
export const makeResponse = ({ body, headers, status }: {
    body: string;
    headers: Map<string, string>;
    status: number;
}) => ({
    headers: responseHeaders(headers),
    ok: status >= 200 && status < 300,
    status,
    async text() {
        return body;
    },
});
export const parseCurlHeaders = (rawHeaders: string) => {
    const normalized = rawHeaders.replace(/\r\n/g, "\n").trim();
    const blocks = normalized.split(/\n\n+/).filter(Boolean);
    const headerBlock = [...blocks]
        .reverse()
        .find((block) => block.startsWith("HTTP/"));
    if (!headerBlock) {
        throw new ManualFetchError("curl did not return HTTP response headers.");
    }
    const [statusLine, ...lines] = headerBlock.split("\n");
    const statusMatch = statusLine && /^HTTP\/\S+\s+(\d{3})/.exec(statusLine);
    if (!statusMatch) {
        throw new ManualFetchError(`Could not parse HTTP status from curl response: ${statusLine}`);
    }
    const headers = new Map<string, string>();
    lines.forEach((line) => {
        const separator = line.indexOf(":");
        if (separator === -1)
            return;
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers.set(name, value);
    });
    return {
        headers,
        status: Number(statusMatch[1]),
    };
};
export const requestManualWithCurl = async (url: string, { cacheDir, method, timeoutMs }: RequestOptions): Promise<ResponseLike> => {
    const headerPath = tempFilePath(cacheDir, ".headers");
    const bodyPath = tempFilePath(cacheDir, ".body");
    const curlNames = process.platform === "win32" ? ["curl.exe", "curl"] : ["curl"];
    const args = [
        "--silent",
        "--show-error",
        "--location",
        "--dump-header",
        headerPath,
        "--output",
        bodyPath,
        "--user-agent",
        USER_AGENT,
        "--max-time",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ];
    if (method === "HEAD") {
        args.push("--head");
    }
    else {
        args.push("--request", method);
    }
    args.push(url);
    let lastError;
    for (const curlName of curlNames) {
        try {
            await execFileAsync(curlName, args, { windowsHide: true });
            const [rawHeaders, body] = await Promise.all([
                readFile(headerPath, "utf8"),
                readFile(bodyPath, "utf8"),
            ]);
            const { headers, status } = parseCurlHeaders(rawHeaders);
            return makeResponse({ body, headers, status });
        }
        catch (error) {
            lastError = error;
            if (errorCode(error) !== "ENOENT")
                break;
        }
        finally {
            await Promise.all([
                rm(headerPath, { force: true }),
                rm(bodyPath, { force: true }),
            ]);
        }
    }
    if (errorCode(lastError) === "ENOENT") {
        throw new ManualFetchError("curl is unavailable in this environment.", {
            cause: lastError,
        });
    }
    throw new ManualFetchError(`${method} ${url} could not be fetched.`, {
        cause: lastError,
    });
};
export const requestManualWithFetch = async (url: string, { method, timeoutMs }: Omit<RequestOptions, "cacheDir">): Promise<ResponseLike> => {
    if (typeof fetch !== "function") {
        throw new ManualFetchError("Native fetch is unavailable in this Node runtime.");
    }
    return withTimeout((signal) => fetch(url, {
        method,
        headers: { "User-Agent": USER_AGENT },
        signal,
    }), timeoutMs);
};
export const requestManual = async (url: string, { cacheDir, method, timeoutMs }: RequestOptions): Promise<ResponseLike> => {
    const preferCurl = Boolean(proxyConfigured()) || typeof fetch !== "function";
    const transports = preferCurl
        ? [
            () => requestManualWithCurl(url, { cacheDir, method, timeoutMs }),
            () => requestManualWithFetch(url, { method, timeoutMs }),
        ]
        : [
            () => requestManualWithFetch(url, { method, timeoutMs }),
            () => requestManualWithCurl(url, { cacheDir, method, timeoutMs }),
        ];
    let lastError;
    for (const transport of transports) {
        try {
            const response = await transport();
            if (!response.ok) {
                throw new ManualFetchError(`${method} ${url} failed with HTTP ${response.status}.`);
            }
            return response;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new ManualFetchError(`${method} ${url} could not be fetched.`, {
        cause: lastError,
    });
};
export const readHeaderSha = (response: ResponseLike) => {
    const value = response.headers.get(HASH_HEADER);
    if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
        throw new ManualFetchError(`Manual response is missing ${HASH_HEADER}.`);
    }
    return value.toLowerCase();
};
