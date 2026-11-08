const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const readline: typeof import('node:readline') = require('node:readline');

type AttemptInput = {
  attempt_id?: unknown; session_id?: string; timestamp?: string; status?: string; model?: string; model_slug?: string;
  reasoning_effort?: string; admitted_outputs?: number; saved_tokens?: number; approx_saved_tokens?: number;
  latency_ms?: number; usage?: { total_tokens?: number } | null;
};
type Attempt = {
  id: unknown; session: string | null; timestamp: string | null; status: string | undefined; model: string; effort: string;
  outputs: number; saved: number; latencyMs: number; usage: { total_tokens?: number } | null; source: 'audit' | 'rollout';
};
type Snapshot = { latest_attempt: AttemptInput & { attempt_id: unknown }; approx_saved_tokens: number };
type Coverage = { homes?: string[]; auditFiles?: number; rolloutFiles?: number; malformedRecords?: number; snapshots?: number };
export type Attempts = Map<unknown, Attempt>;
export type SmartPruneReport = ReturnType<typeof summarize>;
export type SmartPruneApi = { addAttempt: typeof addAttempt; collectSnapshots: typeof collectSnapshots; summarize: typeof summarize; collect: typeof collect };

function filesUnder(root: string, suffix: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) result.push(...filesUnder(file, suffix));
    else if (item.isFile() && item.name.endsWith(suffix)) result.push(file);
  }
  return result;
}

function addAttempt(attempts: Attempts, value: AttemptInput, sessionId: string | null, timestamp: string | null, source: 'audit' | 'rollout') {
  if (!value?.attempt_id) return;
  const attempt = {
    id: value.attempt_id,
    session: value.session_id || sessionId || null,
    timestamp: value.timestamp || timestamp || null,
    status: value.status,
    model: value.model || value.model_slug || 'unreported',
    effort: value.reasoning_effort || 'unreported',
    outputs: value.admitted_outputs || 0,
    saved: value.saved_tokens ?? value.approx_saved_tokens ?? 0,
    latencyMs: value.latency_ms || 0,
    usage: value.usage || null,
    source,
  };
  const previous = attempts.get(attempt.id);
  // Full audit records are authoritative over repeated rollout snapshots.
  if (!previous || source === 'audit' || (previous.source !== 'audit' && !previous.usage && attempt.usage)) {
    attempts.set(attempt.id, attempt);
  }
}

function collectSnapshots(value: unknown, visit: (snapshot: Snapshot) => void) {
  if (!value || typeof value !== 'object') return;
  if ('latest_attempt' in value && value.latest_attempt && typeof value.latest_attempt === 'object'
    && 'attempt_id' in value.latest_attempt && value.latest_attempt.attempt_id
    && 'approx_saved_tokens' in value && typeof value.approx_saved_tokens === 'number') visit(value as Snapshot);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectSnapshots(child, visit);
  }
}

function summarize(attempts: Attempts, coverage: Coverage = {}) {
  const records = [...attempts.values()];
  const statuses: Record<string, number> = {}, daily: Record<string, number> = {}, models: Record<string, { attempts: number; saved: number; optimizerTokens: number }> = {};
  let saved = 0, outputs = 0, optimizerTokens = 0, usageReports = 0, latencyMs = 0;
  for (const record of records) {
    const status = String(record.status);
    statuses[status] = (statuses[status] || 0) + 1;
    const admitted = record.status === 'admitted' && record.outputs > 0;
    const avoided = admitted ? record.saved : 0;
    saved += avoided; outputs += admitted ? record.outputs : 0; latencyMs += record.latencyMs;
    if (record.usage) { usageReports++; optimizerTokens += record.usage.total_tokens || 0; }
    const day = record.timestamp ? String(record.timestamp).slice(0, 10) : 'Undated';
    daily[day] = (daily[day] || 0) + avoided;
    const model = models[record.model] ||= { attempts: 0, saved: 0, optimizerTokens: 0 };
    model.attempts++; model.saved += avoided; model.optimizerTokens += record.usage?.total_tokens || 0;
  }
  return {
    generatedAt: new Date().toISOString(),
    estimatedTokensAvoided: saved,
    admittedOutputs: outputs,
    sessions: new Set(records.map(record => record.session).filter(Boolean)).size,
    attempts: records.length,
    optimizerTokens, usageReports, missingUsageReports: records.length - usageReports,
    optimizerLatencyMs: latencyMs, statuses,
    daily: Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).map(([date, saved]) => ({ date, saved })),
    models, coverage,
    methodology: [
      'Unique optimizer attempt IDs; repeated rollout snapshots are not added again.',
      'Only admitted attempts with at least one shortened output contribute estimated saved tokens.',
      'Saved tokens describe one-time source-to-summary compression, not every later reuse of the summary.',
      'Optimizer tokens are provider-reported usage; missing usage reports are not assumed to be zero.',
      'Net token or monetary savings require a matched unpruned baseline and are not established by these counters.',
      'Coverage is the available local audit and rollout records, including recorded experiments; deleted or separately archived histories may be absent.',
    ],
  };
}

async function collect(homes: string[]) {
  const attempts: Attempts = new Map();
  const coverage = { homes: homes.map(home => path.basename(home)), auditFiles: 0, rolloutFiles: 0, malformedRecords: 0, snapshots: 0 };
  for (const home of homes) {
    for (const file of filesUnder(path.join(home, 'logs/smart-prune/attempts'), '.json')) {
      try { addAttempt(attempts, JSON.parse(fs.readFileSync(file, 'utf8')), null, null, 'audit'); coverage.auditFiles++; }
      catch { coverage.malformedRecords++; }
    }
    for (const root of ['sessions', 'archived_sessions']) {
      for (const file of filesUnder(path.join(home, root), '.jsonl')) {
        coverage.rolloutFiles++;
        let sessionId: string | null = null;
        const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.includes('session_meta') && !line.includes('smart_prune') && !line.includes('latest_attempt')) continue;
          let value;
          try { value = JSON.parse(line); } catch { coverage.malformedRecords++; continue; }
          if (value.type === 'session_meta') sessionId = value.payload?.id || sessionId;
          collectSnapshots(value, snapshot => {
            coverage.snapshots++;
            addAttempt(attempts, snapshot.latest_attempt, sessionId, value.timestamp, 'rollout');
          });
        }
      }
    }
  }
  return summarize(attempts, coverage);
}

if (require.main === module) {
  const destination = process.argv[2];
  if (!destination) throw Error('Usage: node scripts/smart-prune-report.cts OUTPUT.json [HOME ...]');
  const homes = process.argv.length > 3 ? process.argv.slice(3) : ['.elpis', '.codex'].map(name => path.join(os.homedir(), name));
  collect(homes).then(report => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

module.exports = { addAttempt, collectSnapshots, summarize, collect };
