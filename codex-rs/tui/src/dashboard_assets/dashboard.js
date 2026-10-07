'use strict';

const POLL_INTERVAL_MS = 2_000;
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
    const prefix = '/evidence/' + token + '/';
    const response = await fetch(prefix + 'index.json', { cache: 'no-store' });
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
  return token ? `/pruner-settings/${token}` : null;
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
  return token ? `/provider-keys/${token}` : null;
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
  return `/models/${token}` + (provider ? '/' + encodeURIComponent(provider) : '');
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
  if (!isObject(models)) return;
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

let lastClaudeFetch = 0;

async function refreshClaude() {
  const now = Date.now();
  if (now - lastClaudeFetch < 10_000) return;
  lastClaudeFetch = now;
  try {
    const response = await fetch('/claude.json', { cache: 'no-store' });
    if (response.ok) renderClaude(await response.json());
  } catch (_error) {
    // The Claude Code section keeps its last values.
  }
}

function renderClaude(summary) {
  if (!isObject(summary) || !isFiniteNumber(summary.results)) return;
  setText('claude-state-pill', summary.results > 0 ? 'Recorded' : 'No records');
  setText('claude-results', formatNumber(summary.results));
  setText('claude-source', compactNumber(summary.source_tokens));
  setText('claude-sent', compactNumber(summary.sent_tokens));
  setText('claude-saved', compactNumber(summary.saved_tokens));
  setText('claude-saved-share', (formatPercent(summary.saved_tokens, summary.source_tokens) || '0%') + ' of source');
  const recent = Array.isArray(summary.recent) ? summary.recent.filter(isObject) : [];
  const list = byId('claude-recent');
  list.replaceChildren(...recent.map(row => {
    const line = makeNode('div');
    const at = isFiniteNumber(row.at) ? new Date(row.at * 1000).toLocaleString() : 'Time unavailable';
    line.append(
      makeNode('span', null, at + ' · ' + (typeof row.model === 'string' ? row.model : 'Model unavailable')),
      makeNode('strong', null, compactNumber(row.source_tokens) + ' → ' + compactNumber(row.sent_tokens)),
    );
    return line;
  }));
  list.hidden = recent.length === 0;
  byId('claude-empty').hidden = recent.length > 0;
}

const AGENT_NODE_W = 270;
const AGENT_YOU_W = 140;
const AGENT_NODE_H = 88;
const AGENT_GAP_X = 96;
const AGENT_TITLE_CHARS = 31;
const AGENT_TRUNK = 26;
const AGENT_GAP_Y = 20;
const AGENT_PAD = 12;
const AGENT_NEUTRAL = '#8a8590';
// Only the statuses that ask for attention get a colour; the rest stay neutral.
const AGENT_STATUS_TONES = Object.freeze({ needs_you: '#f0a35a', working: '#e0b048' });
let lastAgentsFetch = 0;
let lastAgentsKey = null;

async function refreshAgents() {
  const now = Date.now();
  if (now - lastAgentsFetch < 3_000) return;
  lastAgentsFetch = now;
  try {
    const response = await fetch('/agents.json', { cache: 'no-store' });
    if (response.ok) renderAgents(await response.json());
  } catch (_error) {
    // The map keeps its last drawing.
  }
}

function agentColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : AGENT_NEUTRAL;
}

// The agent colour lightened toward white, so its text stays readable on the dark page.
function agentTextColor(hex) {
  const value = parseInt(hex.slice(1), 16);
  const mix = channel => Math.round(channel + (255 - channel) * 0.45);
  return 'rgb(' + [value >> 16, (value >> 8) & 255, value & 255].map(mix).join(',') + ')';
}

function svgNode(tag, attributes, text) {
  const node = document.createElementNS(byId('agent-map').namespaceURI, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (text !== undefined) node.textContent = text;
  return node;
}

function clip(value, limit) {
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

// The title on at most two lines, broken between words; the second line ends in … when cut.
function titleLines(title) {
  if (title.length <= AGENT_TITLE_CHARS) return [title];
  const cut = title.lastIndexOf(' ', AGENT_TITLE_CHARS);
  const at = cut > AGENT_TITLE_CHARS / 2 ? cut : AGENT_TITLE_CHARS;
  return [title.slice(0, at), clip(title.slice(at).trim(), AGENT_TITLE_CHARS)];
}

// You on the left, each chat next, then the helpers each one started, one column per level.
function layoutAgents(agents) {
  const ids = new Set(agents.map(agent => agent.id));
  const children = new Map();
  agents.forEach(agent => {
    const parent = ids.has(agent.parent_id) && agent.parent_id !== agent.id ? agent.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(agent);
  });
  const placed = [];
  const seen = new Set();
  let row = 0;
  const place = (agent, depth, parent) => {
    seen.add(agent.id);
    const rows = (children.get(agent.id) || []).filter(child => !seen.has(child.id))
      .map(child => place(child, depth + 1, agent.id));
    const y = rows.length ? (rows[0] + rows[rows.length - 1]) / 2 : row++;
    placed.push({ agent, depth, y, parent });
    return y;
  };
  const roots = (children.get(null) || []).map(agent => place(agent, 1, 'you'));
  const you = { agent: { id: 'you', title: 'You', model: null }, depth: 0, y: roots.length ? (roots[0] + roots[roots.length - 1]) / 2 : 0, parent: null };
  return { nodes: [you, ...placed], rows: Math.max(row, 1) };
}

function agentX(depth) {
  return AGENT_PAD + (depth === 0 ? 0 : AGENT_YOU_W + AGENT_GAP_X + (depth - 1) * (AGENT_NODE_W + AGENT_GAP_X));
}

function agentBox(node, x, y) {
  const { agent } = node;
  const color = node.depth === 0 ? AGENT_NEUTRAL : agentColor(agent.color);
  const status = typeof agent.status_label === 'string' && agent.status_label
    ? { label: agent.status_label, tone: AGENT_STATUS_TONES[agent.status] || null }
    : null;
  const group = svgNode('g', {});
  const model = typeof agent.model === 'string' ? agent.model : '';
  group.append(svgNode('title', {}, [agent.title, model, status ? status.label : ''].filter(Boolean).join(' · ')));
  group.append(svgNode('rect', { x, y, width: node.depth === 0 ? AGENT_YOU_W : AGENT_NODE_W, height: AGENT_NODE_H, rx: 10, fill: '#151318', stroke: color, 'stroke-width': 1.5 }));
  group.append(svgNode('rect', { x: x + 1, y: y + 10, width: 4, height: AGENT_NODE_H - 20, rx: 2, fill: color }));
  if (node.depth === 0) {
    group.append(svgNode('text', { x: x + 18, y: y + 39, fill: '#eee9e7', 'font-size': 15, 'font-weight': 600 }, 'You'));
    group.append(svgNode('text', { x: x + 18, y: y + 58, fill: '#a8a1a6', 'font-size': 12 }, 'start the chats'));
    return group;
  }
  const title = typeof agent.title === 'string' && agent.title ? agent.title : 'Untitled task';
  titleLines(title).forEach((line, index) => group.append(
    svgNode('text', { x: x + 18, y: y + 23 + index * 18, fill: '#eee9e7', 'font-size': 14, 'font-weight': 600 }, line)));
  group.append(svgNode('text', { x: x + 18, y: y + 62, fill: agentTextColor(color), 'font-size': 12.5 }, clip(model || 'Model not reported', 36)));
  if (status) {
    group.append(svgNode('circle', { cx: x + 22, cy: y + 75, r: 3.5, fill: status.tone || '#8a8590' }));
    group.append(svgNode('text', { x: x + 31, y: y + 79, fill: status.tone || '#a8a1a6', 'font-size': 12 }, status.label));
  }
  return group;
}

// A right-angle connector: out of the parent, along a shared trunk, then straight into the
// child, where its label sits above the straight part.
function agentEdge(from, fromWidth, to, color, label) {
  const group = svgNode('g', {});
  const x1 = from.x + fromWidth;
  const y1 = from.y + AGENT_NODE_H / 2;
  const trunk = x1 + AGENT_TRUNK;
  const x2 = to.x - 7;
  const y2 = to.y + AGENT_NODE_H / 2;
  const turn = Math.min(8, Math.abs(y2 - y1) / 2) * Math.sign(y2 - y1);
  const d = turn === 0
    ? `M${x1},${y1} H${x2}`
    : `M${x1},${y1} H${trunk - Math.abs(turn)} Q${trunk},${y1} ${trunk},${y1 + turn} V${y2 - turn} Q${trunk},${y2} ${trunk + Math.abs(turn)},${y2} H${x2}`;
  group.append(svgNode('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-opacity': 0.85 }));
  group.append(svgNode('path', { d: `M${x2},${y2 - 5} L${x2 + 7},${y2} L${x2},${y2 + 5} Z`, fill: color }));
  group.append(svgNode('text', { x: (trunk + x2) / 2, y: y2 - 7, fill: '#a8a1a6', 'font-size': 11, 'text-anchor': 'middle' }, label));
  return group;
}

function renderAgents(summary) {
  const agents = isObject(summary) && Array.isArray(summary.agents)
    ? summary.agents.filter(agent => isObject(agent) && typeof agent.id === 'string' && agent.id !== 'you')
    : [];
  const key = JSON.stringify(agents);
  if (key === lastAgentsKey) return;
  lastAgentsKey = key;
  byId('agents-empty').hidden = agents.length > 0;
  byId('agent-map-scroll').hidden = agents.length === 0;
  const map = byId('agent-map');
  if (agents.length === 0) { map.replaceChildren(); return; }
  const { nodes, rows } = layoutAgents(agents);
  const at = new Map(nodes.map(node => [node.agent.id, {
    x: agentX(node.depth),
    y: AGENT_PAD + node.y * (AGENT_NODE_H + AGENT_GAP_Y),
  }]));
  const depth = Math.max(...nodes.map(node => node.depth));
  const width = agentX(depth) + (depth === 0 ? AGENT_YOU_W : AGENT_NODE_W) + AGENT_PAD;
  const height = AGENT_PAD * 2 + rows * AGENT_NODE_H + (rows - 1) * AGENT_GAP_Y;
  map.setAttribute('width', width);
  map.setAttribute('height', height);
  map.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const edges = nodes.filter(node => node.parent).map(node => agentEdge(
    at.get(node.parent), node.depth === 1 ? AGENT_YOU_W : AGENT_NODE_W, at.get(node.agent.id),
    agentColor(node.agent.color), node.depth === 1 ? 'asks' : 'delegates'));
  map.replaceChildren(...edges, ...nodes.map(node => agentBox(node, at.get(node.agent.id).x, at.get(node.agent.id).y)));
}

async function poll(force = false) {
  if (inFlight || (paused && !force)) return;
  inFlight = true;
  if (force || lastValidState === null) {
    byId('refresh-now').disabled = true;
    setTransport(paused ? 'Refreshing once' : 'Refreshing', paused ? 'paused' : 'neutral');
  }
  try {
    const response = await fetch('/data.json', { cache: 'no-store' });
    if (!response.ok) {
      setTransport('Elpis is not answering', 'unavailable');
      return;
    }
    const envelope = await response.json();
    const nextState = isObject(envelope) ? envelope.state : null;
    const nextHeartbeat = isObject(envelope) ? envelope.heartbeat_at : null;
    if (!isValidState(nextState) || !isValidTimestamp(nextHeartbeat)) {
      setTransport('Elpis sent something this page cannot read', 'unavailable');
      return;
    }
    lastValidHeartbeat = nextHeartbeat;
    await refreshEvidence();
    await refreshClaude();
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
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
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
byId('poll-toggle').addEventListener('click', () => setPaused(!paused));
byId('refresh-now').addEventListener('click', () => { void poll(true); });
setInterval(tickClocks, 1_000);
void poll();
