import { buildOutline, outlineMarkdown } from './manual-outline.mts';
import { sha256, resolveCacheDir, cacheFilePath, outlineFilePath, readCachedManual, writeCachedManual, writeOutline } from './manual-cache.mts';
import { HASH_HEADER, requestManual, readHeaderSha } from './manual-transport.mts';
import { ManualFetchError } from './manual-errors.mts';
import type { ManualOptions, ManualStatus } from './manual-types.mts';
import { mkdir } from "node:fs/promises";
export const DEFAULT_MANUAL_URL = "https://developers.openai.com/codex/codex-manual.md";
export const fetchCodexManual = async ({ manualUrl = DEFAULT_MANUAL_URL, cacheDir, timeoutMs = 30000, }: ManualOptions = {}): Promise<{
    outlineText: string;
    status: ManualStatus;
}> => {
    const resolvedCacheDir = await resolveCacheDir(cacheDir);
    if (!resolvedCacheDir) {
        throw new ManualFetchError("Manual cache directory is unavailable; pass --cache-dir to override or use OpenAI Docs MCP fallback.");
    }
    await mkdir(resolvedCacheDir, { recursive: true });
    const headResponse = await requestManual(manualUrl, {
        cacheDir: resolvedCacheDir,
        method: "HEAD",
        timeoutMs,
    });
    const expectedSha256 = readHeaderSha(headResponse);
    const manualPath = cacheFilePath(resolvedCacheDir);
    const outlinePath = outlineFilePath(resolvedCacheDir);
    const checkedAt = new Date().toISOString();
    const cachedManual = await readCachedManual(resolvedCacheDir, expectedSha256);
    if (cachedManual !== null) {
        const outline = buildOutline(cachedManual);
        const outlineText = outlineMarkdown(outline);
        await writeOutline(resolvedCacheDir, outlineText);
        return {
            outlineText,
            status: {
                manualUrl,
                headerSha256: expectedSha256,
                fetchedManualSha256: expectedSha256,
                manualHashMatches: true,
                cacheStatus: "hit",
                cacheDir: resolvedCacheDir,
                manualPath,
                outlinePath,
                checkedAt,
                lineCount: outline.lineCount,
                headingCount: outline.headingCount,
            },
        };
    }
    const getResponse = await requestManual(manualUrl, {
        cacheDir: resolvedCacheDir,
        method: "GET",
        timeoutMs,
    });
    const getHeaderSha256 = readHeaderSha(getResponse);
    if (getHeaderSha256 !== expectedSha256) {
        throw new ManualFetchError(`${HASH_HEADER} changed between HEAD and GET for ${manualUrl}.`);
    }
    const manualText = await getResponse.text();
    const actualSha256 = sha256(manualText);
    const manualHashMatches = actualSha256 === expectedSha256;
    if (!manualHashMatches) {
        throw new ManualFetchError(`${HASH_HEADER} did not match the fetched manual body for ${manualUrl}.`);
    }
    await writeCachedManual(resolvedCacheDir, manualText);
    const outline = buildOutline(manualText);
    const outlineText = outlineMarkdown(outline);
    await writeOutline(resolvedCacheDir, outlineText);
    return {
        outlineText,
        status: {
            manualUrl,
            headerSha256: expectedSha256,
            fetchedManualSha256: actualSha256,
            manualHashMatches,
            cacheStatus: "updated",
            cacheDir: resolvedCacheDir,
            manualPath,
            outlinePath,
            checkedAt,
            lineCount: outline.lineCount,
            headingCount: outline.headingCount,
        },
    };
};
