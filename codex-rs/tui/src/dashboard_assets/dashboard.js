'use strict';

const POLL_INTERVAL_MS = 2_000;
// The same page is served at / by the TUI and /api/dashboard/ by desktop.
function dashboardPath(resource) {
  const url = new URL(resource.replace(/^\//, ''), new URL('.', location.href));
  return url.pathname + url.search;
}
const FRESHNESS_LIMIT_MS = 10_000;
const COMPOSITION_CELL_COUNT = 100;
const CATEGORY_COLORS = Object.freeze({
  '#6fb5fd': 'category-blue',
  '#039b2c': 'category-green',
  '#03dae5': 'category-cyan',
  '#a2810b': 'category-yellow',
  '#f0445d': 'category-rose',
  '#ef8cff': 'category-purple',
  '#fcb24f': 'category-orange',
  '#919191': 'category-gray',
  '#a6fc18': 'category-lime'
});
const STATUS_META = Object.freeze({
  idle: ['Idle', 'badge-ghost'],
  running: ['Running', 'badge-primary'],
  completed: ['Completed', 'badge-success'],
  failed: ['Failed', 'badge-error'],
  interrupted: ['Interrupted', 'badge-warning']
});
const ATTEMPT_META = Object.freeze({
  admitted: ['Admitted', 'badge-success'],
  unchanged: ['Unchanged', 'badge-ghost'],
  timed_out: ['Timed out', 'badge-warning'],
  model_error: ['Model error', 'badge-error'],
  malformed_response: ['Malformed response', 'badge-error'],
  source_error: ['Source error', 'badge-error'],
  audit_error: ['Audit error', 'badge-error'],
  cancelled: ['Cancelled', 'badge-ghost']
});
const COST_UNAVAILABLE = Object.freeze({
  subscription_authentication: 'Unavailable for subscription auth',
  cost_observation_disabled: 'Unavailable — observation off',
  provider_unsupported: 'Unavailable — provider unsupported',
  awaiting_backend_price: 'Unavailable — awaiting backend',
  backend_unavailable: 'Unavailable — backend unavailable',
  observation_dropped: 'Unavailable — observation dropped'
});
const PROFILE_FIELDS = Object.freeze([
  ['Before first sampling', 'before_first_sampling_ms'],
  ['Sampling', 'sampling_ms'],
  ['Compaction', 'compaction_ms'],
  ['Between-sampling overhead', 'between_sampling_overhead_ms'],
  ['Tool blocking', 'tool_blocking_ms'],
  ['After last sampling', 'after_last_sampling_ms']
]);

let pollTimer = null;
let inFlight = false;
let paused = false;
let lastValidState = null;
let lastValidHeartbeat = null;
let lastEvidenceKey = null;
let lastPollFailed = false;

function byId(id) {
  return document.getElementById(id);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidTimestamp(value) {
  return isFiniteNumber(value) && value > 0;
}

function isValidState(value) {
  return isObject(value)
    && value.schema_version === 1
    && isFiniteNumber(value.revision)
    && isFiniteNumber(value.generated_at)
    && isObject(value.context)
    && isObject(value.tokens)
    && isObject(value.activity)
    && isObject(value.smart_prune);
}

function setText(id, value) {
  const node = byId(id);
  if (node.textContent !== value) node.textContent = value;
}

function makeNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatNumber(value) {
  return isFiniteNumber(value) ? value.toLocaleString() : 'Unavailable';
}

function compactNumber(value) {
  if (!isFiniteNumber(value)) return 'Unavailable';
  if (Math.abs(value) < 1_000) return value.toLocaleString();
  if (Math.abs(value) < 1_000_000) return (value / 1_000).toFixed(value < 10_000 ? 1 : 0) + 'k';
  return (value / 1_000_000).toFixed(1) + 'm';
}

function formatPercent(value, total) {
  if (!isFiniteNumber(value) || !isFiniteNumber(total) || total <= 0) return null;
  return (Math.min(Math.max(value, 0), total) * 100 / total).toFixed(1) + '%';
}

function formatMilliseconds(value) {
  if (!isFiniteNumber(value)) return 'Unavailable';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + ' s';
  return value.toLocaleString() + ' ms';
}

function formatElapsed(value) {
  if (!isFiniteNumber(value)) return 'Unavailable';
  const seconds = Math.floor(Math.max(0, value) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return hours + 'h ' + minutes + 'm ' + remainder + 's';
  if (minutes > 0) return minutes + 'm ' + remainder + 's';
  return remainder + 's';
}

function formatTimestamp(value) {
  if (!isValidTimestamp(value)) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleTimeString();
}

function formatCost(cost) {
  if (!isObject(cost)) return 'Cost not reported';
  if (cost.type === 'priced' && typeof cost.backend_total_usd === 'string') {
    return 'Backend $' + cost.backend_total_usd;
  }
  if (cost.type === 'unavailable') return COST_UNAVAILABLE[cost.reason] || 'Cost unavailable';
  return 'Cost unavailable';
}

function categoryClass(value) {
  return CATEGORY_COLORS[value] || 'category-gray';
}

function setBadge(node, status, metadata) {
  const [label, tone] = metadata[status] || ['Unknown', 'badge-ghost'];
  node.className = 'badge badge-sm ' + tone;
  node.textContent = label;
}

function setTransport(label, state) {
  if (state === 'unavailable') lastPollFailed = true;
  if (state === 'available') lastPollFailed = false;
  byId('connection-warning').hidden = !lastPollFailed;
  updateFreshness();
  setText('transport-status', label);
  const tone = state === 'available' ? 'status-success' : state === 'paused' ? 'status-warning' : state === 'unavailable' ? 'status-error' : 'status-neutral';
  byId('transport-signal').className = 'status ' + tone;
}

function updateFreshness() {
  const node = byId('freshness-status');
  node.classList.remove('is-fresh', 'is-stale');
  if (!isValidTimestamp(lastValidHeartbeat)) {
    node.textContent = 'Not connected yet';
    return;
  }
  const age = Math.max(0, Date.now() - lastValidHeartbeat);
  if (lastPollFailed) {
    node.textContent = 'Last contact ' + formatElapsed(age) + ' ago';
    node.classList.add('is-stale');
    return;
  }
  node.textContent = (age <= FRESHNESS_LIMIT_MS ? 'Checked ' : 'No answer for ') + formatElapsed(age) + (age <= FRESHNESS_LIMIT_MS ? ' ago' : '');
  node.classList.add(age <= FRESHNESS_LIMIT_MS ? 'is-fresh' : 'is-stale');
}

function updateCurrentElapsed() {
  if (paused || !isObject(lastValidState)) return;
  const current = lastValidState.activity && lastValidState.activity.current;
  if (!isObject(current) || !isValidTimestamp(current.started_at)) return;
  setText('current-elapsed', formatElapsed(Date.now() - current.started_at));
}

function tickClocks() {
  updateFreshness();
  updateCurrentElapsed();
}

function appendMeta(container, label, value) {
  const item = makeNode('div', 'activity-meta-item');
  item.append(makeNode('span', '', label), makeNode('strong', '', value));
  container.appendChild(item);
}

function renderProfile(container, profile) {
  if (!isObject(profile)) return;
  const details = makeNode('details', 'collapse collapse-arrow profile-collapse');
  const summary = makeNode('summary', 'collapse-title', 'Timing breakdown');
  const grid = makeNode('div', 'collapse-content profile-grid');
  PROFILE_FIELDS.forEach(([label, field]) => appendMeta(grid, label, formatMilliseconds(profile[field])));
  appendMeta(grid, 'Sampling requests', formatNumber(profile.sampling_request_count));
  appendMeta(grid, 'Sampling retries', formatNumber(profile.sampling_retry_count));
  details.append(summary, grid);
  container.appendChild(details);
}

function renderCurrentTurn(current) {
  const status = byId('current-status');
  const progress = byId('current-progress');
  if (!isObject(current)) {
    setBadge(status, 'idle', STATUS_META);
    setText('current-title', 'Elpis is waiting for you');
    setText('current-elapsed', '—');
    setText('current-started', '—');
    setText('current-cost', 'Cost not reported');
    progress.value = 0;
    progress.classList.remove('is-running');
    return;
  }
  setBadge(status, current.status, STATUS_META);
  setText('current-title', current.status === 'running' ? 'Elpis is answering' : 'Last answer: ' + (STATUS_META[current.status] || ['Unknown'])[0].toLowerCase());
  setText('current-elapsed', isValidTimestamp(current.started_at) ? formatElapsed(Date.now() - current.started_at) : 'Unavailable');
  setText('current-started', formatTimestamp(current.started_at));
  setText('current-cost', formatCost(current.cost));
  progress.value = current.status === 'running' ? 72 : 100;
  progress.classList.toggle('is-running', current.status === 'running');
}

function renderActivity(activity) {
  const safeActivity = isObject(activity) ? activity : {};
  renderCurrentTurn(safeActivity.current);
  const recent = Array.isArray(safeActivity.recent) ? safeActivity.recent.slice(-20).reverse() : [];
  setText('activity-summary', safeActivity.current ? 'The answer in progress and the last 20 answers.' : 'Elpis is not answering now.');
  setText('recent-count', recent.length === 1 ? '1 answer' : recent.length + ' answers');
  const list = byId('activity-recent');
  list.replaceChildren();
  if (recent.length === 0) {
    list.appendChild(makeNode('p', 'empty-state', 'No answers yet.'));
    return;
  }
  recent.forEach(turn => {
    const row = makeNode('article', 'activity-row');
    const head = makeNode('div', 'activity-row-head');
    const badge = makeNode('span');
    setBadge(badge, turn && turn.status, STATUS_META);
    head.append(badge, makeNode('span', 'turn-cost', formatCost(turn && turn.cost)));
    const meta = makeNode('div', 'activity-meta');
    appendMeta(meta, 'Total', formatMilliseconds(turn && turn.duration_ms));
    appendMeta(meta, 'First token', formatMilliseconds(turn && turn.time_to_first_token_ms));
    row.append(head, meta);
    renderProfile(row, turn && turn.profile);
    list.appendChild(row);
  });
}

function allocateContextCells(categories, usedTokens, windowTokens) {
  const weighted = categories.map((category, index) => ({
    index,
    tokens: isFiniteNumber(category && category.tokens) ? Math.max(0, category.tokens) : 0
  }));
  const total = weighted.reduce((sum, item) => sum + item.tokens, 0);
  const usedCells = isFiniteNumber(usedTokens) && isFiniteNumber(windowTokens) && windowTokens > 0
    ? Math.min(COMPOSITION_CELL_COUNT, Math.max(0, Math.round(usedTokens * COMPOSITION_CELL_COUNT / windowTokens)))
    : 0;
  if (total <= 0 || usedCells <= 0) {
    return { allocations: [], usedCells, freeCells: COMPOSITION_CELL_COUNT - usedCells };
  }
  const allocations = weighted.map(item => {
    const exact = item.tokens * usedCells / total;
    return { ...item, cells: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = usedCells - allocations.reduce((sum, item) => sum + item.cells, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) allocations[index % allocations.length].cells += 1;
  allocations.sort((a, b) => a.index - b.index);
  const positive = allocations.filter(item => item.tokens > 0);
  if (usedCells >= positive.length) {
    positive.filter(item => item.cells === 0).forEach(recipient => {
      const donor = allocations
        .filter(item => item.cells > 1)
        .sort((a, b) => b.cells - a.cells || b.tokens - a.tokens || a.index - b.index)[0];
      if (donor) {
        donor.cells -= 1;
        recipient.cells = 1;
      }
    });
  }
  return { allocations, usedCells, freeCells: COMPOSITION_CELL_COUNT - usedCells };
}

function renderComposition(categories, usedTokens, windowTokens) {
  const track = byId('ctx-composition');
  track.replaceChildren();
  if (!isFiniteNumber(usedTokens) || !isFiniteNumber(windowTokens) || windowTokens <= 0) {
    track.appendChild(makeNode('span', 'composition-empty', isFiniteNumber(usedTokens) ? 'Capacity unknown' : 'No composition reported'));
    return;
  }
  const safeCategories = Array.isArray(categories) ? categories : [];
  const allocation = allocateContextCells(safeCategories, usedTokens, windowTokens);
  if (allocation.allocations.length === 0) {
    for (let cell = 0; cell < allocation.usedCells; cell += 1) {
      const node = makeNode('i', 'composition-cell category-gray');
      node.title = 'In use; its kind is not known yet';
      track.appendChild(node);
    }
  }
  allocation.allocations.forEach(item => {
    const source = safeCategories[item.index];
    for (let cell = 0; cell < item.cells; cell += 1) {
      const node = makeNode('i', 'composition-cell ' + categoryClass(source && source.color));
      node.title = (source && source.label || 'Unknown') + ': ' + formatNumber(source && source.tokens);
      track.appendChild(node);
    }
  });
  for (let cell = 0; cell < allocation.freeCells; cell += 1) {
    const node = makeNode('i', 'composition-cell composition-free');
    node.title = 'Free context';
    track.appendChild(node);
  }
}

function renderContext(context) {
  const safeContext = isObject(context) ? context : {};
  const usedPercent = formatPercent(safeContext.used_tokens, safeContext.window_tokens);
  const hasCapacity = isFiniteNumber(safeContext.window_tokens) && safeContext.window_tokens > 0;
  setText('ctx-used', compactNumber(safeContext.used_tokens));
  setText('ctx-window', compactNumber(safeContext.window_tokens));
  setText('ctx-saved', compactNumber(safeContext.saved_tokens));
  setText('ctx-checkpoints', formatNumber(safeContext.backtrack_points));
  setText('ctx-used-percent', usedPercent === null ? (isFiniteNumber(safeContext.used_tokens) ? 'Capacity unknown' : 'Usage unavailable') : usedPercent + ' used');

  const categories = Array.isArray(safeContext.categories) ? safeContext.categories : null;
  setText('ctx-category-count', categories === null ? 'Unavailable' : formatNumber(categories.length));
  setText('ctx-composition-total', isFiniteNumber(safeContext.used_tokens) ? compactNumber(safeContext.used_tokens) + (hasCapacity ? ' / ' + compactNumber(safeContext.window_tokens) : ' used · capacity unknown') : 'Unavailable');
  renderComposition(categories, safeContext.used_tokens, safeContext.window_tokens);
  const list = byId('ctx-bar');
  list.replaceChildren();
  if (categories === null) {
    list.appendChild(makeNode('p', 'empty-state', 'Category usage unavailable.'));
    setText('ctx-legend', 'Shown after the next answer.');
  } else if (categories.length === 0) {
    list.appendChild(makeNode('p', 'empty-state', 'No category usage reported.'));
    setText('ctx-legend', 'The latest request has no kinds to show.');
  } else {
    categories.forEach(category => {
      const row = makeNode('div', 'category-row');
      const identity = makeNode('div', 'category-identity');
      identity.append(makeNode('i', 'legend-swatch ' + categoryClass(category && category.color)), makeNode('span', '', category && typeof category.label === 'string' ? category.label : 'Unknown category'));
      const percent = formatPercent(category && category.tokens, safeContext.window_tokens);
      row.append(identity, makeNode('span', 'category-percent', percent || '—'), makeNode('strong', '', compactNumber(category && category.tokens)));
      list.appendChild(row);
    });
    setText('ctx-legend', hasCapacity ? 'Approximate share of the whole context window for each kind.' : 'Approximate tokens for each kind; the window size is unknown.');
  }

  const sources = Array.isArray(safeContext.sources) ? safeContext.sources : null;
  const safeSources = sources || [];
  const admitted = safeSources.filter(source => isObject(source) && source.admitted === true).length;
  setText('source-summary', sources === null ? 'Unavailable' : admitted + ' of ' + safeSources.length + ' in context');
  const rows = byId('source-rows');
  rows.replaceChildren();
  if (sources === null || safeSources.length === 0) {
    const row = makeNode('tr');
    const cell = makeNode('td', '', sources === null ? 'Source list unavailable' : 'Elpis loads no files in this chat');
    cell.colSpan = 4;
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  safeSources.forEach(source => {
    const safeSource = isObject(source) ? source : {};
    const row = makeNode('tr');
    row.append(makeNode('td', 'source-name', typeof safeSource.name === 'string' ? safeSource.name : 'Unavailable'), makeNode('td', '', typeof safeSource.category === 'string' ? safeSource.category : 'Unavailable'), makeNode('td', 'numeric', formatNumber(safeSource.estimated_tokens)));
    const state = makeNode('td');
    state.appendChild(makeNode('span', safeSource.admitted === true ? 'badge badge-success badge-outline badge-xs' : 'badge badge-ghost badge-xs', safeSource.admitted === true ? 'Yes' : 'No'));
    row.appendChild(state);
    rows.appendChild(row);
  });
}

function renderTokenTotals(prefix, totals) {
  const safeTotals = isObject(totals) ? totals : {};
  setText(prefix + '-input', formatNumber(safeTotals.input));
  setText(prefix + '-cached', formatNumber(safeTotals.cached_input));
  setText(prefix + '-cache-write', safeTotals.cache_write === null || safeTotals.cache_write === undefined ? 'Unreported' : formatNumber(safeTotals.cache_write));
  setText(prefix + '-output', formatNumber(safeTotals.output));
  setText(prefix + '-reasoning', formatNumber(safeTotals.reasoning_output));
  setText(prefix + '-total', formatNumber(safeTotals.total));
}

function renderTokens(tokens) {
  const safeTokens = isObject(tokens) ? tokens : {};
  renderTokenTotals('session', safeTokens.session_total);
  renderTokenTotals('last', safeTokens.last_turn);
}

function setLinkage(id, verified) {
  const node = byId(id);
  node.className = verified === true ? 'verified' : verified === false ? 'not-verified' : '';
  node.textContent = verified === true ? 'Yes' : verified === false ? 'Not checked' : 'Unavailable';
}

function renderAttempt(attempt) {
  const safeAttempt = isObject(attempt) ? attempt : null;
  byId('attempt-empty').hidden = safeAttempt !== null;
  byId('attempt-details').hidden = safeAttempt === null;
  if (safeAttempt === null) {
    setBadge(byId('attempt-status'), 'unknown', ATTEMPT_META);
    return;
  }
  setBadge(byId('attempt-status'), safeAttempt.status, ATTEMPT_META);
  setText('attempt-model', typeof safeAttempt.model === 'string' ? safeAttempt.model : 'Unavailable');
  setText('attempt-effort', typeof safeAttempt.reasoning_effort === 'string' ? safeAttempt.reasoning_effort : 'Unavailable');
  setText('attempt-candidates', formatNumber(safeAttempt.candidate_outputs));
  setText('attempt-admitted', formatNumber(safeAttempt.admitted_outputs));
  setText('attempt-saved', compactNumber(safeAttempt.approx_saved_tokens));
  setText('attempt-latency', formatMilliseconds(safeAttempt.latency_ms));
  setText('attempt-usage', isObject(safeAttempt.usage) ? formatNumber(safeAttempt.usage.total) + ' tokens reported' : 'Unreported');
  byId('attempt-warning').hidden = safeAttempt.status === 'admitted' || safeAttempt.status === 'unchanged';
  setText('attempt-failure-reason', typeof safeAttempt.failure_reason === 'string' && safeAttempt.failure_reason.trim() ? safeAttempt.failure_reason : 'This attempt did not produce an admitted result. The runtime did not report a reason.');
}

function renderSmartPrune(smart) {
  const safeSmart = isObject(smart) ? smart : {};
  // This chat's switch decides the next answer; the saved default only stands in until it is known.
  const threadState = safeSmart.current_thread_next_turn_enabled;
  const enabled = typeof threadState === 'boolean' ? threadState : safeSmart.configured_enabled;
  const statePill = byId('smart-state-pill');
  statePill.className = 'badge ' + (enabled === true ? 'badge-success' : enabled === false ? 'badge-ghost' : 'badge-outline');
  statePill.textContent = enabled === true ? 'ON' : enabled === false ? 'OFF' : 'UNAVAILABLE';
  setText('smart-thread', typeof threadState === 'boolean' ? 'This chat: ' + (threadState ? 'on from the next answer' : 'off from the next answer') : 'This chat: checking');
  setText('smart-examined', formatNumber(safeSmart.examined_outputs));
  setText('smart-admitted', formatNumber(safeSmart.admitted_outputs));
  setText('smart-unchanged', formatNumber(safeSmart.unchanged_outputs));
  setText('smart-failed', formatNumber(safeSmart.failed_batches));
  setText('smart-source', compactNumber(safeSmart.approx_source_tokens));
  setText('smart-kept', compactNumber(safeSmart.approx_admitted_tokens));
  setText('smart-saved', compactNumber(safeSmart.approx_saved_tokens));
  setText('smart-latency', formatMilliseconds(safeSmart.optimizer_latency_ms));
  setText('optimizer-requests', formatNumber(safeSmart.optimizer_requests));
  setText('optimizer-coverage', isFiniteNumber(safeSmart.optimizer_usage_reports) && isFiniteNumber(safeSmart.optimizer_requests) ? safeSmart.optimizer_usage_reports + ' of ' + safeSmart.optimizer_requests + ' requests reported' : 'Unavailable');
  renderTokenTotals('optimizer', safeSmart.optimizer_usage_reports > 0 ? safeSmart.optimizer_usage : null);
  renderAttempt(safeSmart.latest_attempt);

  const latest = isObject(safeSmart.latest) ? safeSmart.latest : null;
  byId('smart-latest-empty').hidden = latest !== null;
  byId('smart-latest').hidden = latest === null;
  if (latest !== null) {
    setText('latest-outputs', formatNumber(latest.admitted_outputs) + ' / ' + formatNumber(latest.examined_outputs));
    setText('latest-source', formatNumber(latest.approx_source_tokens));
    setText('latest-admitted', formatNumber(latest.approx_admitted_tokens));
    setText('latest-saved', formatNumber(latest.approx_saved_tokens));
    setLinkage('latest-request-link', latest.request_linkage_verified);
    setLinkage('latest-response-link', latest.response_linkage_verified);
    renderTokenTotals('response', latest.response_usage);
  }
}

function renderRibbon(state) {
  const current = state.activity && state.activity.current;
  const recent = state.activity && Array.isArray(state.activity.recent) ? state.activity.recent : [];
  const lastTurn = recent.length > 0 ? recent[recent.length - 1] : null;
  setText('ribbon-title', isObject(current) && current.status === 'running' ? 'Elpis is answering' : 'Elpis is waiting for you');
  setText('ribbon-model', describeChoice(state.context && state.context.models && state.context.models.chat, 'Unavailable'));
  setText('ribbon-context', isFiniteNumber(state.context && state.context.used_tokens) ? compactNumber(state.context.used_tokens) + ' / ' + compactNumber(state.context.window_tokens) : 'Unavailable');
  setText('ribbon-turn', isObject(lastTurn) ? formatMilliseconds(lastTurn.duration_ms) : 'No answer yet');
  const next = state.smart_prune && state.smart_prune.current_thread_next_turn_enabled;
  setText('ribbon-prune', next === true ? 'On' : next === false ? 'Off' : 'Checking');
}

// One row per usage-limit window, as /usage shows it: label and reset time, then percent used.
function renderLimits(limits) {
  const rows = Array.isArray(limits) ? limits.filter(row => isObject(row) && typeof row.label === 'string' && isFiniteNumber(row.used_percent)) : [];
  byId('limits-rows').replaceChildren(...rows.map(row => {
    const line = makeNode('div');
    const resets = typeof row.resets_at === 'string' && row.resets_at ? ' · resets ' + row.resets_at : '';
    line.append(makeNode('span', null, row.label + resets), makeNode('strong', null, row.used_percent + '% used'));
    return line;
  }));
  byId('limits-rows').hidden = rows.length === 0;
  byId('limits-empty').hidden = rows.length > 0;
  setText('limits-summary', rows.length === 0 ? 'Unavailable' : rows.length === 1 ? '1 window' : rows.length + ' windows');
}

function renderState(state) {
  lastValidState = state;
  const context = isObject(state.context) ? state.context : {};
  setText('model-line', 'Chat model: ' + (typeof context.model === 'string' && context.model.length > 0 ? context.model : 'unavailable'));
  renderRibbon(state);
  renderActivity(state.activity);
  renderContext(state.context);
  renderTokens(state.tokens);
  renderSmartPrune(state.smart_prune);
  renderModels(context.models);
  renderLimits(state.limits);
  setText('state-meta', 'Last change ' + formatTimestamp(state.generated_at) + ' · update ' + formatNumber(state.revision));
}

function schedulePoll(delay) {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = paused ? null : setTimeout(() => { void poll(); }, delay);
}

// The session token in the page address; every settings page needs it.
function sessionToken() {
  const token = new URLSearchParams(location.hash.slice(1)).get('evidence');
  return /^[a-f0-9]{32}$/.test(token || '') ? token : null;
}

async function refreshEvidence() {
  const container = byId('evidence-links');
  const token = sessionToken();
  if (!container || !token) return;
  try {
    const prefix = dashboardPath('/evidence/' + token + '/');
    const response = await fetch(prefix + 'index.json' + location.search, { cache: 'no-store' });
    if (!response.ok) throw new Error('Evidence unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid evidence list');
    const links = rows.filter(row => isObject(row) && typeof row.label === 'string' && typeof row.url === 'string' && row.url.startsWith(prefix) && /^[a-f0-9]{32}$/.test(row.url.slice(prefix.length)));
    const key = JSON.stringify(links.map(row => [row.label, row.url]));
    if (key === lastEvidenceKey) return;
    container.replaceChildren();
    for (const row of links) {
      const link = makeNode('a', 'link', row.label);
      link.href = row.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      container.append(link);
    }
    if (!container.childNodes.length) container.textContent = 'No records for this chat yet.';
    lastEvidenceKey = key;
  } catch (_error) {
    lastEvidenceKey = null;
    setText('evidence-links', 'Records unavailable. Open the dashboard again with /dashboard in Elpis.');
  }
}

let defaultPrunerPrompt = null;
function prunerSettingsUrl() {
  const token = sessionToken();
  return token ? dashboardPath(`/pruner-settings/${token}`) : null;
}

async function loadPrunerSettings() {
  const url = prunerSettingsUrl();
  if (!url) return;
  byId('pruner-fields').disabled = true;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    defaultPrunerPrompt = payload.default_system_prompt;
    byId('pruner-prompt').value = payload.settings.system_prompt ?? defaultPrunerPrompt;
    byId('pruner-fields').disabled = false;
    setText('pruner-feedback', 'Loaded. Edits apply only after you save.');
  } catch (error) {
    setText('pruner-feedback', `Instructions unavailable: ${error.message}`);
  }
}

async function savePrunerSettings() {
  const url = prunerSettingsUrl();
  if (!url || defaultPrunerPrompt === null) return;
  const prompt = byId('pruner-prompt').value;
  if (!prompt.trim()) { setText('pruner-feedback', 'The instructions cannot be empty.'); return; }
  byId('pruner-fields').disabled = true;
  try {
    // The model is chosen in the Models tab; this page sends the instructions alone.
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_prompt: prompt === defaultPrunerPrompt ? null : prompt }),
    });
    if (!response.ok) throw new Error(await response.text());
    setText('pruner-feedback', 'Saved. Smart Prune uses them from its next request.');
  } catch (error) {
    setText('pruner-feedback', `Not saved: ${error.message}`);
  } finally {
    byId('pruner-fields').disabled = false;
  }
}

function restoreDefaultPrunerPrompt() {
  if (defaultPrunerPrompt !== null) {
    byId('pruner-prompt').value = defaultPrunerPrompt;
    setText('pruner-feedback', 'The default is back in the editor. Save to use it.');
  }
}

const KEY_SOURCES = Object.freeze({
  saved: 'Saved in Elpis',
  environment: 'Environment variable',
  configured: 'config.toml',
  not_required: 'Not needed',
  missing: 'Not set'
});

function providerKeysUrl() {
  const token = sessionToken();
  return token ? dashboardPath(`/provider-keys/${token}`) : null;
}

function text(value) {
  return typeof value === 'string' ? value : 'Unavailable';
}

function renderProviderKeys(rows) {
  const table = byId('provider-key-rows');
  const select = byId('provider-key-select');
  const chosen = select.value;
  table.replaceChildren();
  select.replaceChildren();
  for (const row of rows) {
    const line = makeNode('tr');
    line.append(
      makeNode('td', 'source-name', text(row.name)),
      makeNode('td', '', typeof row.env_var === 'string' ? row.env_var : '—'),
      makeNode('td', '', typeof row.masked === 'string' ? row.masked : '—'),
      makeNode('td', '', KEY_SOURCES[row.source] || 'Unavailable')
    );
    table.append(line);
    const option = makeNode('option', '', text(row.name));
    option.value = text(row.id);
    select.append(option);
  }
  if (!rows.length) {
    const empty = makeNode('tr');
    const cell = makeNode('td', '', 'No provider here takes an API key.');
    cell.colSpan = 4;
    empty.append(cell);
    table.append(empty);
  }
  if (chosen) select.value = chosen;
}

async function loadProviderKeys() {
  const url = providerKeysUrl();
  if (!url) return;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    if (!isObject(payload) || !Array.isArray(payload.providers)) throw new Error('Invalid provider list');
    const rows = payload.providers.filter(isObject);
    renderProviderKeys(rows);
    byId('provider-key-fields').disabled = rows.length === 0;
    setText('provider-key-feedback', rows.length ? 'A saved key applies to the next request. This page never shows it.' : 'No provider here takes an API key.');
  } catch (error) {
    setText('provider-key-feedback', `Provider keys unavailable: ${error.message}`);
  }
}

async function submitProviderKey(apiKey) {
  const url = providerKeysUrl();
  if (!url) return;
  const provider = byId('provider-key-select').value;
  if (!provider) return;
  byId('provider-key-fields').disabled = true;
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    renderProviderKeys(isObject(payload) && Array.isArray(payload.providers) ? payload.providers.filter(isObject) : []);
    byId('provider-key-value').value = '';
    setText('provider-key-feedback', apiKey === null ? 'Saved key removed. The environment variable applies again if it is set.' : 'Saved. It applies to the next request.');
  } catch (error) {
    setText('provider-key-feedback', `Not saved: ${error.message}`);
  } finally {
    byId('provider-key-fields').disabled = false;
  }
}

const MODEL_ROLES = Object.freeze(['chat', 'background', 'pruner']);
const ROLE_NAMES = Object.freeze({ chat: 'Chat model', background: 'Background model', pruner: 'Smart Prune model' });
let modelProviders = null;
// Each provider's list, fetched once per page load; OpenRouter's has hundreds of models.
const modelLists = new Map();
let currentModels = null;
// A role the owner is editing keeps the selection; Elpis's updates do not reset it.
const touchedRoles = new Set();

function modelsUrl(provider) {
  const token = sessionToken();
  if (!token) return null;
  return dashboardPath(`/models/${token}` + (provider ? '/' + encodeURIComponent(provider) : '')) + location.search;
}

function providerName(id) {
  const row = Array.isArray(modelProviders) ? modelProviders.find(provider => provider.id === id) : null;
  return row ? text(row.name) : id;
}

function describeChoice(choice, fallback) {
  if (!isObject(choice) || typeof choice.model !== 'string') return fallback;
  return typeof choice.provider === 'string' ? choice.model + ' on ' + providerName(choice.provider) : choice.model;
}

function roleDefaultLabel(role) {
  return byId('model-fields-' + role).dataset.default || '';
}

function roleProvider(role) {
  const choice = currentModels && currentModels[role];
  if (isObject(choice) && typeof choice.provider === 'string') return choice.provider;
  const chat = currentModels && currentModels.chat;
  return isObject(chat) && typeof chat.provider === 'string' ? chat.provider : null;
}

function renderModels(models) {
  if (!isObject(models)) {
    currentModels = null;
    MODEL_ROLES.forEach(role => setText('model-current-' + role, 'Unavailable'));
    setText('smart-configured-model', 'Unavailable');
    return;
  }
  const inherited = describeChoice(models.background, 'Built-in background default');
  setText('smart-configured-model', describeChoice(models.pruner, inherited + ' · inherited from Background'));
  currentModels = models;
  MODEL_ROLES.forEach(role => {
    setText('model-current-' + role, describeChoice(models[role], roleDefaultLabel(role) || 'Unavailable'));
    if (!touchedRoles.has(role)) void selectCurrent(role);
  });
}

async function selectCurrent(role) {
  if (!Array.isArray(modelProviders)) return;
  const provider = roleProvider(role);
  const select = byId('model-provider-' + role);
  if (provider && [...select.options].some(option => option.value === provider)) select.value = provider;
  await showModels(role);
}

async function loadModelList(provider) {
  if (modelLists.has(provider)) return modelLists.get(provider);
  const response = await fetch(modelsUrl(provider), { cache: 'no-store' });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  const models = isObject(payload) && Array.isArray(payload.models)
    ? payload.models.filter(model => isObject(model) && typeof model.id === 'string')
    : [];
  modelLists.set(provider, models);
  return models;
}

function optionLabel(model) {
  return typeof model.name === 'string' && model.name ? model.name : model.id;
}

async function showModels(role) {
  const providerSelect = byId('model-provider-' + role);
  const provider = providerSelect.value;
  const list = byId('model-list-' + role);
  if (!provider) return;
  let models;
  try {
    if (!modelLists.has(provider)) list.replaceChildren(makeNode('option', '', 'Loading the list…'));
    models = await loadModelList(provider);
  } catch (error) {
    // The provider list stays usable, so another provider can still be picked.
    const option = makeNode('option', '', 'No list from this provider');
    option.disabled = true;
    list.replaceChildren(option);
    byId('model-fields-' + role).disabled = false;
    setText('models-feedback', `${providerName(provider)}: ${error.message}`);
    return;
  }
  if (providerSelect.value !== provider) return;
  const choice = currentModels && currentModels[role];
  let keep = list.value;
  if (!touchedRoles.has(role) && isObject(choice)) {
    keep = choice.provider === provider && typeof choice.model === 'string' ? choice.model : (choice.model === null ? '' : keep);
  }
  const filter = byId('model-filter-' + role).value.trim().toLowerCase();
  const options = [];
  const defaultLabel = roleDefaultLabel(role);
  if (defaultLabel) {
    const option = makeNode('option', '', defaultLabel);
    option.value = '';
    options.push(option);
  }
  models
    .filter(model => !filter || model.id.toLowerCase().includes(filter) || (typeof model.name === 'string' && model.name.toLowerCase().includes(filter)))
    .forEach(model => {
      const option = makeNode('option', '', optionLabel(model));
      option.value = model.id;
      option.title = model.id;
      options.push(option);
    });
  if (options.length === 0) {
    const option = makeNode('option', '', 'No model matches');
    option.disabled = true;
    options.push(option);
  }
  list.replaceChildren(...options);
  if (options.some(option => option.value === keep)) list.value = keep;
  byId('model-fields-' + role).disabled = false;
}

async function saveModel(role) {
  const url = modelsUrl();
  if (!url) return;
  const provider = byId('model-provider-' + role).value;
  const list = byId('model-list-' + role);
  const selected = list.selectedOptions[0];
  if (!selected || selected.disabled || (role === 'chat' && !list.value)) {
    setText('models-feedback', ROLE_NAMES[role] + ': pick a model from the list first.');
    return;
  }
  const model = list.value;
  const fields = byId('model-fields-' + role);
  fields.disabled = true;
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, provider: model ? provider : null, model: model || null })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    touchedRoles.delete(role);
    if (isObject(payload) && typeof payload.threadId === 'string') {
      const address = new URL(location.href);
      address.searchParams.set('thread', payload.threadId);
      history.replaceState(null, '', address.pathname + address.search + address.hash);
    }
    setText('models-feedback', ROLE_NAMES[role] + ': ' + (isObject(payload) && typeof payload.message === 'string' ? payload.message : 'saved.'));
  } catch (error) {
    setText('models-feedback', `${ROLE_NAMES[role]} not changed: ${error.message}`);
  } finally {
    fields.disabled = false;
  }
}

async function loadModelProviders() {
  const url = modelsUrl();
  if (!url) return;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    modelProviders = isObject(payload) && Array.isArray(payload.providers)
      ? payload.providers.filter(provider => isObject(provider) && typeof provider.id === 'string')
      : [];
    MODEL_ROLES.forEach(role => {
      // The Claude subscription serves the chat model alone.
      const offered = modelProviders.filter(provider => role === 'chat' || provider.chat_only !== true);
      byId('model-provider-' + role).replaceChildren(...offered.map(provider => {
        const option = makeNode('option', '', text(provider.name));
        option.value = provider.id;
        return option;
      }));
    });
    setText('models-feedback', 'Pick a provider and a model, then press "Use this model".');
    if (currentModels) renderModels(currentModels);
  } catch (error) {
    setText('models-feedback', `Models unavailable: ${error.message}`);
  }
}

let lastAgentsFetch = 0;
let agentsSnapshot = [];
let lastAgentsKey = null;
let agentsConversation = null;
let selectedAgentId = null;
async function refreshAgents() {
  if (Date.now() - lastAgentsFetch < 3_000) return;
  lastAgentsFetch = Date.now();
  try {
    const response = await fetch(dashboardPath('/agents.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const summary = await response.json();
    if (!Array.isArray(summary.agents)) throw new Error('Invalid data');
    renderAgents(summary);
    setText('agents-feedback', 'Recorded agent relationships · refreshed just now');
  } catch (_error) {
    setText('agents-feedback', agentsSnapshot.length ? 'Refresh failed. Showing the last received relationships.' : 'Agent list unavailable. Refresh to reconnect.');
  }
}
function svgNode(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (text !== undefined) node.textContent = text;
  return node;
}
function agentTitle(agent) { return String(agent.title || '').trim() || 'Untitled conversation'; }
function agentRoots(agents) {
  const ids = new Set(agents.map(agent => agent.id));
  const roots = agents.filter(agent => !agent.parent_id || !ids.has(agent.parent_id) || agent.parent_id === agent.id);
  const reached = new Set();
  function visit(id) {
    if (reached.has(id)) return;
    reached.add(id);
    agents.filter(agent => agent.parent_id === id).forEach(agent => visit(agent.id));
  }
  roots.forEach(root => visit(root.id));
  agents.forEach(agent => { if (!reached.has(agent.id)) { roots.push(agent); visit(agent.id); } });
  return roots;
}
function layoutAgents(agents, rootId) {
  const seen = new Set(), nodes = [];
  let nextRow = 0;
  function place(agent, depth, parent) {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    const childRows = agents.filter(child => child.parent_id === agent.id && !seen.has(child.id)).map(child => place(child, depth + 1, agent.id)).filter(row => row !== undefined);
    const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : nextRow++;
    nodes.push({ agent, depth, parent, row });
    return row;
  }
  const root = agents.find(agent => agent.id === rootId);
  if (root) place(root, 0, null);
  return nodes;
}
function showAgentDetails(agent) {
  selectedAgentId = agent.id;
  const details = byId('agent-details');
  details.hidden = false;
  byId('agent-map').querySelectorAll('g[data-agent-id]').forEach(node => {
    const selected = node.dataset.agentId === agent.id;
    node.setAttribute('aria-pressed', String(selected));
    node.querySelector('rect')?.setAttribute('stroke', selected ? 'var(--color-primary)' : 'var(--color-base-300)');
  });
  const facts = makeNode('dl', 'evidence-list');
  const parent = agentsSnapshot.find(item => item.id === agent.parent_id);
  for (const [label, value] of [
    ['Model', agent.model || 'Not reported'], ['Status', agent.status_label || 'Unknown'], ['Conversation ID', agent.id],
    ['Recorded parent', agent.parent_id ? `${parent ? agentTitle(parent) : 'Not loaded'} · ${agent.parent_id}` : 'None — independent conversation'],
  ]) {
    const row = makeNode('div'); row.append(makeNode('dt', '', label), makeNode('dd', '', value)); facts.append(row);
  }
  details.replaceChildren(makeNode('h3', 'text-base font-semibold', agentTitle(agent)), facts);
}
function renderAgents(summary) {
  const unique = new Map();
  for (const agent of Array.isArray(summary.agents) ? summary.agents : []) {
    if (isObject(agent) && typeof agent.id === 'string' && agent.id) unique.set(agent.id, agent);
  }
  const nextAgents = [...unique.values()];
  const key = JSON.stringify(nextAgents);
  if (key === lastAgentsKey) return;
  lastAgentsKey = key;
  agentsSnapshot = nextAgents;
  const roots = agentRoots(agentsSnapshot);
  const previousConversation = agentsConversation;
  if (!roots.some(agent => agent.id === agentsConversation)) agentsConversation = roots[0]?.id || null;
  if (previousConversation !== agentsConversation || (selectedAgentId && !layoutAgents(agentsSnapshot, agentsConversation).some(node => node.agent.id === selectedAgentId))) resetAgentChat();
  const selector = byId('agents-conversation');
  selector.replaceChildren(...roots.map(agent => { const option = makeNode('option', '', agentTitle(agent)); option.value = agent.id; return option; }));
  selector.disabled = !roots.length;
  if (agentsConversation) selector.value = agentsConversation;
  selector.onchange = () => { agentsConversation = selector.value; resetAgentChat(); drawAgents(); };
  drawAgents();
}
function drawAgents() {
  const svg = byId('agent-map');
  byId('agents-empty').hidden = agentsSnapshot.length > 0;
  byId('agent-map-scroll').hidden = agentsSnapshot.length === 0;
  svg.replaceChildren();
  const selected = agentsSnapshot.find(agent => agent.id === selectedAgentId);
  if (selected) showAgentDetails(selected); else byId('agent-details').hidden = true;
  if (!agentsSnapshot.length) return;
  const nodes = layoutAgents(agentsSnapshot, agentsConversation);
  const W = 280, H = 112, X_GAP = 56, Y_GAP = 24, PAD = 16;
  const positions = new Map(nodes.map(n => [n.agent.id, { ...n, x: PAD + n.depth * (W + X_GAP), y: PAD + n.row * (H + Y_GAP) }]));
  const width = PAD * 2 + (Math.max(0, ...nodes.map(n => n.depth)) + 1) * (W + X_GAP) - X_GAP;
  const height = PAD * 2 + (Math.max(0, ...nodes.map(node => node.row)) + 1) * (H + Y_GAP) - Y_GAP;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width); svg.setAttribute('height', height);
  for (const n of positions.values()) {
    const p = positions.get(n.parent);
    if (!p) continue;
    const start = p.x + W, end = n.x, sy = p.y + H / 2, ey = n.y + H / 2, mid = start + X_GAP / 2;
    svg.append(svgNode('path', { d: `M${start},${sy} H${mid} V${ey} H${end}`, fill: 'none', stroke: 'var(--color-base-content)', 'stroke-opacity': '.25', 'stroke-width': 1.5, 'data-parent-id': p.agent.id, 'data-child-id': n.agent.id }));
  }
  for (const { agent, x, y } of positions.values()) {
    const group = svgNode('g', { transform: `translate(${x},${y})`, 'data-agent-id': agent.id, role: 'button', tabindex: '0', 'aria-label': `${agentTitle(agent)}. Show recorded details.` });
    group.style.cursor = 'pointer';
    group.append(svgNode('rect', { width: W, height: H, rx: 10, fill: 'var(--color-base-100)', stroke: 'var(--color-base-300)' }));
    const tone = agent.status === 'working' ? 'var(--color-primary)' : agent.status === 'needs_you' ? 'var(--color-error)' : 'var(--color-base-content)';
    group.append(svgNode('circle', { cx: 18, cy: 24, r: 3.5, fill: tone }));
    group.append(svgNode('text', { x: 29, y: 28, fill: 'var(--color-base-content)', 'font-size': 11 }, agent.status_label || 'Unknown'));
    const title = agentTitle(agent), model = agent.model || 'Model not reported';
    group.append(svgNode('title', {}, `${title}\n${model}\nID: ${agent.id}`));
    group.append(svgNode('text', { x: 16, y: 54, fill: 'var(--color-base-content)', 'font-size': 13, 'font-weight': 600 }, title.length > 34 ? title.slice(0, 33) + '…' : title));
    group.append(svgNode('text', { x: 16, y: 78, fill: 'var(--color-base-content)', opacity: '.7', 'font-size': 11 }, model.length > 37 ? model.slice(0, 36) + '…' : model));
    group.append(svgNode('text', { x: 16, y: 98, fill: 'var(--color-base-content)', opacity: '.7', 'font-size': 10 }, agent.parent_id ? 'Spawned by parent agent' : 'Conversation'));
    group.addEventListener('click', () => { showAgentDetails(agent); void openAgentChat(agent); });
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showAgentDetails(agent); void openAgentChat(agent); } });
    svg.append(group);
  }
}

let chatThreadId = null;
let chatNextCursor = null;
let chatRequest = 0;

function resetAgentChat() {
  selectedAgentId = null;
  chatRequest++;
  chatThreadId = null;
  chatNextCursor = null;
  byId('agent-chat').hidden = true;
  byId('agent-chat-items').replaceChildren();
  byId('agent-chat-refresh').disabled = false;
}

function transcriptItem(entry) {
  const item = entry.item || {};
  const article = makeNode('article', 'border-b border-base-content/10 pb-5');
  let label = 'Activity', text = '';
  switch (item.type) {
    case 'userMessage':
      label = 'You';
      text = (item.content || []).map(part => part.text || (part.type === 'image' || part.type === 'localImage' ? '[Image attachment]' : `[${part.type || 'Attachment'}]`)).join('\n');
      break;
    case 'agentMessage': label = 'Elpis'; text = item.text || ''; break;
    case 'plan': label = 'Plan'; text = item.text || ''; break;
    case 'reasoning': label = 'Reasoning summary'; text = (item.summary || []).join('\n'); break;
    case 'commandExecution': label = 'Command · ' + (item.status || ''); text = [item.command, item.aggregatedOutput].filter(Boolean).join('\n\n'); break;
    case 'functionCallOutput':
      label = item.name || 'Tool result';
      text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output, null, 2);
      break;
    case 'fileChange': label = 'File changes · ' + (item.status || ''); text = (item.changes || []).map(change => [change.path, change.diff].filter(Boolean).join('\n')).join('\n\n'); break;
    case 'mcpToolCall': label = [item.server, item.tool, item.status].filter(Boolean).join(' · '); text = JSON.stringify(item.result || item.error || item.arguments || {}, null, 2); break;
    default:
      label = String(item.type || 'Activity').replace(/([a-z])([A-Z])/g, '$1 $2');
      text = item.text || item.command || item.prompt || item.message || '';
  }
  const heading = makeNode('div', 'flex items-center justify-between gap-3 mb-2');
  heading.append(makeNode('strong', 'text-sm', label));
  if (entry.startedAtMs) heading.append(makeNode('time', 'text-xs opacity-70', new Date(entry.startedAtMs).toLocaleString()));
  article.append(heading);
  if (text) {
    const content = makeNode('div', 'whitespace-pre-wrap break-words text-sm leading-7', text);
    if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) article.append(content);
    else {
      const details = makeNode('details', 'text-sm'); details.append(makeNode('summary', 'cursor-pointer', 'Show details'), content); article.append(details);
    }
  }
  return article;
}

async function openAgentChat(agent, earlier = false) {
  const token = sessionToken();
  const pane = byId('agent-chat'); pane.hidden = false;
  const changed = chatThreadId !== agent.id;
  chatThreadId = agent.id;
  if (changed) { chatNextCursor = null; byId('agent-chat-items').replaceChildren(); }
  setText('agent-chat-title', agentTitle(agent));
  byId('agent-chat-older').hidden = true;
  if (!token) { setText('agent-chat-status', 'Open /dashboard from Elpis to read this conversation. This preview has no transcript access.'); return; }
  const request = ++chatRequest;
  setText('agent-chat-status', 'Loading recorded messages…');
  byId('agent-chat-refresh').disabled = true;
  try {
    const query = new URLSearchParams({ limit: '20' });
    if (earlier && chatNextCursor) query.set('cursor', chatNextCursor);
    const response = await fetch(dashboardPath(`/threads/${token}/${encodeURIComponent(agent.id)}?${query}`), { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (request !== chatRequest) return;
    if (result.thread?.id !== agent.id || !Array.isArray(result.data)) throw new Error('The server returned a different conversation.');
    const items = result.data.slice().reverse().map(transcriptItem);
    if (earlier) byId('agent-chat-items').prepend(...items); else byId('agent-chat-items').replaceChildren(...items);
    chatNextCursor = result.nextCursor || null;
    byId('agent-chat-older').hidden = !chatNextCursor;
    setText('agent-chat-status', result.data.length ? 'Recorded transcript · read only · use Refresh chat for new messages' : 'No recorded messages yet.');
  } catch (error) {
    if (request === chatRequest) setText('agent-chat-status', 'Could not load messages: ' + error.message);
  } finally { if (request === chatRequest) byId('agent-chat-refresh').disabled = false; }
}
byId('agent-chat-refresh').addEventListener('click', () => {
  const agent = agentsSnapshot.find(item => item.id === chatThreadId); if (agent) void openAgentChat(agent);
});
byId('agent-chat-older').addEventListener('click', () => {
  const agent = agentsSnapshot.find(item => item.id === chatThreadId); if (agent) void openAgentChat(agent, true);
});
byId('agent-chat-close').addEventListener('click', () => { chatRequest++; chatThreadId = null; byId('agent-chat').hidden = true; });

async function poll(force = false) {
  if (inFlight || (paused && !force)) return;
  inFlight = true;
  if (force || lastValidState === null) {
    byId('refresh-now').disabled = true;
    setTransport(paused ? 'Refreshing once' : 'Refreshing', paused ? 'paused' : 'neutral');
  }
  try {
    const response = await fetch(dashboardPath('/data.json') + location.search, { cache: 'no-store' });
    if (!response.ok) {
      setTransport('Elpis is not answering', 'unavailable');
      return;
    }
    const envelope = await response.json();
    const nextState = isObject(envelope) ? envelope.state : null;
    const nextHeartbeat = isObject(envelope) ? envelope.heartbeat_at : null;
    if (nextState === null && isValidTimestamp(nextHeartbeat)) {
      await refreshAgents();
      setTransport('Open a conversation for session data', 'neutral');
      return;
    }
    if (!isValidState(nextState) || !isValidTimestamp(nextHeartbeat)) {
      setTransport('Elpis sent something this page cannot read', 'unavailable');
      return;
    }
    lastPollFailed = false;
    byId('connection-warning').hidden = true;
    lastValidHeartbeat = nextHeartbeat;
    await refreshEvidence();
    await refreshAgents();
    if (lastValidState === null || nextState.revision !== lastValidState.revision) renderState(nextState);
    updateFreshness();
    setTransport(paused ? 'Paused · refreshed' : 'Live', paused ? 'paused' : 'available');
  } catch (_error) {
    setTransport('Elpis is not answering', 'unavailable');
  } finally {
    inFlight = false;
    byId('refresh-now').disabled = false;
    if (!paused) schedulePoll(POLL_INTERVAL_MS);
  }
}

function setPaused(nextPaused) {
  paused = nextPaused;
  if (paused) {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    setText('poll-toggle', 'Resume');
    setTransport('Paused', 'paused');
    return;
  }
  setText('poll-toggle', 'Pause');
  updateCurrentElapsed();
  void poll();
}

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function activateTab(nextTab, focusTab) {
  tabs.forEach(tab => {
    const selected = tab === nextTab;
    tab.classList.toggle('tab-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    byId(tab.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focusTab) nextTab.focus();
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab, false));
  tab.addEventListener('keydown', event => {
    const currentIndex = tabs.indexOf(tab);
    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(tabs[nextIndex], true);
  });
});

MODEL_ROLES.forEach(role => {
  // Any edit, by pointer, keyboard or focus, keeps the owner's selection.
  ['focusin', 'change', 'input'].forEach(type => {
    byId('model-fields-' + role).addEventListener(type, () => touchedRoles.add(role), true);
  });
  byId('model-provider-' + role).addEventListener('change', () => {
    byId('model-filter-' + role).value = '';
    void showModels(role);
  });
  byId('model-filter-' + role).addEventListener('input', () => void showModels(role));
  byId('model-save-' + role).addEventListener('click', () => void saveModel(role));
});
void loadModelProviders();
byId('pruner-save').addEventListener('click', () => void savePrunerSettings());
byId('pruner-reload').addEventListener('click', () => void loadPrunerSettings());
byId('pruner-reset').addEventListener('click', restoreDefaultPrunerPrompt);
void loadPrunerSettings();
byId('provider-key-save').addEventListener('click', () => {
  const value = byId('provider-key-value').value.trim();
  if (!value) { setText('provider-key-feedback', 'Paste a key before saving.'); return; }
  void submitProviderKey(value);
});
byId('provider-key-clear').addEventListener('click', () => void submitProviderKey(null));
byId('provider-key-reload').addEventListener('click', () => void loadProviderKeys());
void loadProviderKeys();
byId('pruner-change-model').addEventListener('click', () => {
  activateTab(byId('tab-models'), false);
  byId('model-provider-pruner').focus();
  byId('model-fields-pruner').scrollIntoView({ block: 'center' });
});
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  setText('theme-toggle', light ? 'Dark' : 'Light');
  byId('theme-toggle').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
}
// A desktop appearance change updates this document without discarding an edited prompt.
window.addEventListener('message', event => {
  if (event.source === parent && event.origin === location.origin && event.data?.type === 'elpis-dashboard-theme'
    && ['light', 'elpis-dashboard'].includes(event.data.theme)) setTheme(event.data.theme);
});
let preferredTheme;
try { preferredTheme = localStorage.getItem('elpis-dashboard-theme'); } catch (_error) {}
const hostTheme = new URLSearchParams(location.search).get('theme');
if (hostTheme === 'light' || hostTheme === 'elpis-dashboard') preferredTheme = hostTheme;
setTheme(['light', 'elpis-dashboard'].includes(preferredTheme) ? preferredTheme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'elpis-dashboard');
byId('theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'elpis-dashboard' : 'light';
  setTheme(theme);
  try { localStorage.setItem('elpis-dashboard-theme', theme); } catch (_error) {}
});
byId('poll-toggle').addEventListener('click', () => setPaused(!paused));
byId('refresh-now').addEventListener('click', () => { void poll(true); });
setInterval(tickClocks, 1_000);
void poll();
