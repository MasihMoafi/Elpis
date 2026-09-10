const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

function filesUnder(root, suffix) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) result.push(...filesUnder(file, suffix));
    else if (item.isFile() && item.name.endsWith(suffix)) result.push(file);
  }
  return result;
}

function addAttempt(attempts, value, sessionId, timestamp, source) {
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

function collectSnapshots(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (value.latest_attempt?.attempt_id && typeof value.approx_saved_tokens === 'number') visit(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectSnapshots(child, visit);
  }
}

function summarize(attempts, coverage = {}) {
  const records = [...attempts.values()];
  const statuses = {}, daily = {}, models = {};
  let saved = 0, outputs = 0, optimizerTokens = 0, usageReports = 0, latencyMs = 0;
  for (const record of records) {
    statuses[record.status] = (statuses[record.status] || 0) + 1;
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

async function collect(homes) {
  const attempts = new Map();
  const coverage = { homes: homes.map(home => path.basename(home)), auditFiles: 0, rolloutFiles: 0, malformedRecords: 0, snapshots: 0 };
  for (const home of homes) {
    for (const file of filesUnder(path.join(home, 'logs/smart-prune/attempts'), '.json')) {
      try { addAttempt(attempts, JSON.parse(fs.readFileSync(file, 'utf8')), null, null, 'audit'); coverage.auditFiles++; }
      catch { coverage.malformedRecords++; }
    }
    for (const root of ['sessions', 'archived_sessions']) {
      for (const file of filesUnder(path.join(home, root), '.jsonl')) {
        coverage.rolloutFiles++;
        let sessionId = null;
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
  if (!destination) throw Error('Usage: node scripts/smart-prune-report.cjs OUTPUT.json [HOME ...]');
  const homes = process.argv.length > 3 ? process.argv.slice(3) : ['.elpis', '.codex'].map(name => path.join(os.homedir(), name));
  collect(homes).then(report => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { addAttempt, collectSnapshots, summarize, collect };
