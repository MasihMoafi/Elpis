import type { PlanFile, Plan, Counts, FileResult, Snapshot, Manifest } from './renderer-evidence-types.mts';
import assert from 'node:assert/strict';
export function passingCounts(text: string): Counts {
    const counts: Counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const) {
        const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
        assert.equal(matches.length, 1, `Missing or duplicate TAP ${key} count`);
        const match = matches[0];
        assert(match?.[1], `Missing or duplicate TAP ${key} count`);
        counts[key] = Number(match[1]);
    }
    assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid TAP counts');
    assert(counts.tests > 0 && counts.pass === counts.tests, 'UI tests must have positive passes');
    assert((['fail', 'cancelled', 'skipped', 'todo'] as const).every(key => counts[key] === 0), 'UI tests failed, skipped, cancelled or pending');
    return counts;
}
export function checkResults(plan: {
    files: PlanFile[];
}, files: FileResult[]) {
    assert.equal(files.length, plan.files.length, 'UI receipt omits regression files');
    for (let i = 0; i < files.length; i++) {
        const result = files[i];
        assert(result);
        const { source, name, blob: hash } = result;
        assert.deepEqual({ source, name, blob: hash }, plan.files[i], 'UI receipt has stale or changed tests');
        assert(Array.isArray(result.cases) && result.cases.every(value => typeof value === 'string')
            && result.cases.some(value => value !== name && !value.endsWith(`/${name}`)), 'UI receipt has no named test cases');
        const counts = Object.fromEntries((['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const).map(key => [key, result[key]]));
        assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid UI receipt counts');
        passingCounts(Object.entries(counts).map(([key, value]) => `# ${key} ${value}`).join('\n'));
    }
}
/** Preserve the plan's order and membership; only its execution is partitioned. */
export function slicePlan(plan: Plan, shardIndex: number, shardCount: number) {
    assert(Number.isSafeInteger(shardCount) && shardCount > 0, 'Invalid UI shard count');
    assert(Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount, 'Invalid UI shard index');
    return plan.files.filter((_, index) => index % shardCount === shardIndex);
}
export function checkManifest(snapshot: Snapshot, manifest: Manifest) {
    assert.equal(manifest.schemaVersion, 1, 'Unsupported UI shard plan');
    slicePlan(snapshot.plan, 0, manifest.shardCount);
    for (const key of ['commit', 'baseline', 'planHash', 'rendererHash'] as const) {
        assert.equal(snapshot[key], manifest[key], `Prepared UI ${key} differs from source or renderer`);
    }
    assert.deepEqual(snapshot.plan, manifest.plan, 'Prepared UI plan differs from source');
}
export const receiptName = '.elpis-ui-receipt.json';
