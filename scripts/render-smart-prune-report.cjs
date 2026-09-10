const fs = require('node:fs');
const path = require('node:path');
const [input, cssFile, output] = process.argv.slice(2);
if (!input || !cssFile || !output) throw Error('Usage: node scripts/render-smart-prune-report.cjs DATA.json STYLES.css OUTPUT.html');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const number = value => Number(value).toLocaleString('en-US');
const short = value => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
const statusLabels = { admitted: 'Shortened and admitted', unchanged: 'Kept unchanged', timed_out: 'Timed out', malformed_response: 'Invalid optimizer reply', cancelled: 'Cancelled', model_error: 'Provider error', audit_error: 'Audit error' };
const max = Math.max(1, ...report.daily.map(day => day.saved));
const bars = report.daily.map((day, index) => {
  const band = 680 / Math.max(1, report.daily.length), x = 45 + index * band, width = Math.max(2, band * 0.56), height = 150 * day.saved / max;
  return `<g><title>${escape(day.date)}: ${number(day.saved)} estimated tokens</title><rect x="${x}" y="${190 - height}" width="${width}" height="${height}" rx="5" class="fill-primary"/><text x="${x + width / 2}" y="${180 - height}" text-anchor="middle" class="fill-base-content" font-size="12">${short(day.saved)}</text><text x="${x + width / 2}" y="218" text-anchor="middle" class="fill-base-content" font-size="11">${escape(day.date.slice(5))}</text></g>`;
}).join('');
const values = {
  DATE: escape(report.generatedAt.slice(0, 10)), GENERATED_AT: escape(report.generatedAt),
  SAVED_SHORT: short(report.estimatedTokensAvoided), SAVED_EXACT: number(report.estimatedTokensAvoided),
  SESSIONS: number(report.sessions), ADMITTED: number(report.statuses.admitted || 0), OUTPUTS: number(report.admittedOutputs),
  OPTIMIZER_SHORT: short(report.optimizerTokens), REPORTS: number(report.usageReports), ATTEMPTS: number(report.attempts),
  REPORTS_RAW: report.usageReports, ATTEMPTS_RAW: Math.max(1, report.attempts), MISSING: number(report.missingUsageReports), DAYS: report.daily.length,
  AUDITS: number(report.coverage.auditFiles), ROLLOUTS: number(report.coverage.rolloutFiles), SNAPSHOTS: number(report.coverage.snapshots), MALFORMED: number(report.coverage.malformedRecords),
  CHART: `<svg viewBox="0 0 770 235" class="w-full" role="img" aria-label="Daily estimated tokens removed from tool outputs">${bars}</svg>`,
  STATUS_ROWS: Object.entries(report.statuses).map(([status, count]) => `<tr><td>${escape(statusLabels[status] || status)}</td><td class="text-right font-mono tabular-nums">${number(count)}</td></tr>`).join(''),
};
let html = fs.readFileSync(path.join(__dirname, '../docs/templates/smart-prune-report.html'), 'utf8');
html = html.replace('/* REPORT_STYLES */', fs.readFileSync(cssFile, 'utf8').replaceAll('</style', '<\\/style'));
html = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => { if (!(key in values)) throw Error('Unknown template field: ' + key); return values[key]; });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(output);
