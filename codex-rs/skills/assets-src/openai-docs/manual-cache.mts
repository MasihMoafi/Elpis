import { errorCode } from './manual-errors.mts';
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
export const DEFAULT_CACHE_DIR_NAME = "openai-docs-cache";
export const CACHE_FILE_NAME = "codex-manual.md";
export const OUTLINE_FILE_NAME = "codex-manual.outline.md";
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const tempFilePath = (cacheDir: string, suffix: string) => path.join(cacheDir, `.fetch-codex-manual-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`);
export const nearestExistingParent = async (target: string) => {
    let current = target;
    while (true) {
        try {
            const info = await stat(current);
            return info.isDirectory() ? current : null;
        }
        catch (error) {
            if (errorCode(error) !== "ENOENT")
                return null;
        }
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
};
export const usableCacheDir = async (cacheDir: string | undefined) => {
    if (!cacheDir)
        return null;
    const resolved = path.resolve(cacheDir);
    try {
        const info = await stat(resolved);
        if (!info.isDirectory())
            return null;
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            return null;
    }
    const parent = await nearestExistingParent(resolved);
    if (!parent)
        return null;
    try {
        await access(parent, fsConstants.W_OK | fsConstants.X_OK);
    }
    catch {
        return null;
    }
    return resolved;
};
export const defaultCacheDirCandidates = () => {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: string) => {
        if (!candidate || seen.has(candidate))
            return;
        seen.add(candidate);
        candidates.push(candidate);
    };
    [process.env.TMPDIR, process.env.TEMP, process.env.TMP].forEach((baseDir) => {
        if (baseDir) {
            pushCandidate(path.join(baseDir, DEFAULT_CACHE_DIR_NAME));
        }
    });
    if (process.platform !== "win32") {
        pushCandidate(`/private/tmp/${DEFAULT_CACHE_DIR_NAME}`);
        pushCandidate(`/tmp/${DEFAULT_CACHE_DIR_NAME}`);
    }
    return candidates;
};
export const resolveCacheDir = async (cacheDir: string | undefined) => {
    if (cacheDir) {
        return usableCacheDir(cacheDir);
    }
    for (const candidate of defaultCacheDirCandidates()) {
        const usable = await usableCacheDir(candidate);
        if (usable)
            return usable;
    }
    return null;
};
export const cacheFilePath = (cacheDir: string) => path.join(cacheDir, CACHE_FILE_NAME);
export const outlineFilePath = (cacheDir: string) => path.join(cacheDir, OUTLINE_FILE_NAME);
export const readCachedManual = async (cacheDir: string, expectedSha256: string) => {
    try {
        const manual = await readFile(cacheFilePath(cacheDir), "utf8");
        return sha256(manual) === expectedSha256 ? manual : null;
    }
    catch {
        return null;
    }
};
export const writeCachedManual = async (cacheDir: string, manual: string) => {
    await mkdir(cacheDir, { recursive: true });
    const tmpPath = tempFilePath(cacheDir, `.${CACHE_FILE_NAME}.tmp`);
    await writeFile(tmpPath, manual, "utf8");
    await rename(tmpPath, cacheFilePath(cacheDir));
};
export const writeOutline = async (cacheDir: string, outlineText: string) => {
    await mkdir(cacheDir, { recursive: true });
    const tmpPath = tempFilePath(cacheDir, `.${OUTLINE_FILE_NAME}.tmp`);
    await writeFile(tmpPath, outlineText, "utf8");
    await rename(tmpPath, outlineFilePath(cacheDir));
};
