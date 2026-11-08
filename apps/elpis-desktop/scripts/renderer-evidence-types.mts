export type Inventory = Record<string, string[]> & {
    desktop: string[];
    ui: string[];
};
export type PlanFile = {
    source: 'baseline' | 'candidate';
    name: string;
    blob: string;
};
export type Plan = {
    baseline: string;
    support: {
        baseline: string;
        candidate: string;
    };
    files: PlanFile[];
};
export type Counts = {
    tests: number;
    pass: number;
    fail: number;
    cancelled: number;
    skipped: number;
    todo: number;
};
export type FileResult = PlanFile & Partial<Counts> & {
    cases?: string[];
    error?: string;
};
export type Identity = {
    schemaVersion: number;
    commit: string;
    baseline: string;
    planHash: string;
    rendererHash: string;
};
export type Snapshot = Identity & {
    plan: Plan;
};
export type Manifest = Snapshot & {
    shardCount: number;
};
export type Shard = Identity & {
    shardIndex: number;
    shardCount: number;
    files: FileResult[];
    errors: string[];
};
