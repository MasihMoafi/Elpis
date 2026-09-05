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
  byId(id).textContent = value;
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
    node.textContent = 'Freshness unavailable';
    return;
  }
  const age = Math.max(0, Date.now() - lastValidHeartbeat);
  node.textContent = (age <= FRESHNESS_LIMIT_MS ? 'Fresh · ' : 'Stale · ') + formatElapsed(age) + ' ago';
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
    setText('current-title', 'Elpis is ready');
    setText('current-elapsed', '—');
    setText('current-started', '—');
    setText('current-cost', 'Cost not reported');
    progress.value = 0;
    progress.classList.remove('is-running');
    return;
  }
  setBadge(status, current.status, STATUS_META);
  setText('current-title', current.status === 'running' ? 'A turn is in flight' : (STATUS_META[current.status] || ['Unknown'])[0] + ' turn');
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
  setText('activity-summary', safeActivity.current ? 'Live turn plus bounded recent history.' : 'No turn is currently running.');
  setText('recent-count', recent.length === 1 ? '1 turn' : recent.length + ' turns');
  const list = byId('activity-recent');
  list.replaceChildren();
  if (recent.length === 0) {
    list.appendChild(makeNode('p', 'empty-state', 'No recent turns reported.'));
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
    track.appendChild(makeNode('span', 'composition-empty', 'No composition reported'));
    return;
  }
  const safeCategories = Array.isArray(categories) ? categories : [];
  const allocation = allocateContextCells(safeCategories, usedTokens, windowTokens);
  if (allocation.allocations.length === 0) {
    for (let cell = 0; cell < allocation.usedCells; cell += 1) {
      const node = makeNode('i', 'composition-cell category-gray');
      node.title = 'Measured context; category attribution unavailable';
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
  setText('ctx-used', compactNumber(safeContext.used_tokens));
  setText('ctx-window', compactNumber(safeContext.window_tokens));
  setText('ctx-saved', compactNumber(safeContext.saved_tokens));
  setText('ctx-checkpoints', formatNumber(safeContext.backtrack_points));
  setText('ctx-used-percent', usedPercent === null ? 'Usage unavailable' : usedPercent + ' used');

  const categories = Array.isArray(safeContext.categories) ? safeContext.categories : null;
  setText('ctx-category-count', categories === null ? 'Unavailable' : formatNumber(categories.length));
  setText('ctx-composition-total', isFiniteNumber(safeContext.used_tokens) && isFiniteNumber(safeContext.window_tokens) ? compactNumber(safeContext.used_tokens) + ' / ' + compactNumber(safeContext.window_tokens) : 'Unavailable');
  renderComposition(categories, safeContext.used_tokens, safeContext.window_tokens);
  const list = byId('ctx-bar');
  list.replaceChildren();
  if (categories === null) {
    list.appendChild(makeNode('p', 'empty-state', 'Category usage unavailable.'));
    setText('ctx-legend', 'No category snapshot has been published.');
  } else if (categories.length === 0) {
    list.appendChild(makeNode('p', 'empty-state', 'No category usage reported.'));
    setText('ctx-legend', 'The latest request contains no attributed rows.');
  } else {
    categories.forEach(category => {
      const row = makeNode('div', 'category-row');
      const identity = makeNode('div', 'category-identity');
      identity.append(makeNode('i', 'legend-swatch ' + categoryClass(category && category.color)), makeNode('span', '', category && typeof category.label === 'string' ? category.label : 'Unknown category'));
      const percent = formatPercent(category && category.tokens, safeContext.window_tokens);
      row.append(identity, makeNode('span', 'category-percent', percent || '—'), makeNode('strong', '', compactNumber(category && category.tokens)));
      list.appendChild(row);
    });
    setText('ctx-legend', 'Estimated category shares of the full context window; rows reconcile to the measured active total.');
  }

  const sources = Array.isArray(safeContext.sources) ? safeContext.sources : null;
  const safeSources = sources || [];
  const admitted = safeSources.filter(source => isObject(source) && source.admitted === true).length;
  setText('source-summary', sources === null ? 'Unavailable' : admitted + ' / ' + safeSources.length + ' admitted');
  const rows = byId('source-rows');
  rows.replaceChildren();
  if (sources === null || safeSources.length === 0) {
    const row = makeNode('tr');
    const cell = makeNode('td', '', sources === null ? 'Source data unavailable' : 'No portable sources reported');
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
    state.appendChild(makeNode('span', safeSource.admitted === true ? 'badge badge-success badge-outline badge-xs' : 'badge badge-ghost badge-xs', safeSource.admitted === true ? 'Admitted' : 'Excluded'));
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
  node.textContent = verified === true ? 'Verified locally' : verified === false ? 'Not verified' : 'Unavailable';
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
  const configured = safeSmart.configured_enabled;
  const statePill = byId('smart-state-pill');
  statePill.className = 'badge ' + (configured === true ? 'badge-success' : configured === false ? 'badge-ghost' : 'badge-outline');
  statePill.textContent = configured === true ? 'ON' : configured === false ? 'OFF' : 'UNAVAILABLE';
  setText('smart-configured', 'Configured: ' + (configured === true ? 'On' : configured === false ? 'Off' : 'Unavailable'));
  const threadState = safeSmart.current_thread_next_turn_enabled;
  setText('smart-thread', threadState === null || threadState === undefined ? 'Thread: syncing' : 'Next turn: ' + (threadState === true ? 'On' : 'Off'));
  setText('smart-examined', formatNumber(safeSmart.examined_outputs));
  setText('smart-admitted', formatNumber(safeSmart.admitted_outputs));
  setText('smart-unchanged', formatNumber(safeSmart.unchanged_outputs));
  setText('smart-failed', formatNumber(safeSmart.failed_batches));
  setText('smart-source', compactNumber(safeSmart.approx_source_tokens));
  setText('smart-kept', compactNumber(safeSmart.approx_admitted_tokens));
  setText('smart-saved', compactNumber(safeSmart.approx_saved_tokens));
  setText('smart-latency', formatMilliseconds(safeSmart.optimizer_latency_ms));
  setText('optimizer-requests', formatNumber(safeSmart.optimizer_requests));
  setText('optimizer-coverage', isFiniteNumber(safeSmart.optimizer_usage_reports) && isFiniteNumber(safeSmart.optimizer_requests) ? safeSmart.optimizer_usage_reports + ' / ' + safeSmart.optimizer_requests + ' usage reports' : 'Usage unavailable');
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
  setText('ribbon-title', isObject(current) && current.status === 'running' ? 'Turn in progress' : 'Elpis is ready');
  setText('ribbon-context', isFiniteNumber(state.context && state.context.used_tokens) ? compactNumber(state.context.used_tokens) + ' / ' + compactNumber(state.context.window_tokens) : 'Unavailable');
  setText('ribbon-turn', isObject(lastTurn) ? formatMilliseconds(lastTurn.duration_ms) : 'No recent turn');
  const next = state.smart_prune && state.smart_prune.current_thread_next_turn_enabled;
  setText('ribbon-prune', next === true ? 'On next turn' : next === false ? 'Off next turn' : 'Syncing');
}

function renderState(state) {
  lastValidState = state;
  const context = isObject(state.context) ? state.context : {};
  setText('model-line', (typeof context.model === 'string' && context.model.length > 0 ? context.model : 'Model unavailable') + ' · revision ' + formatNumber(state.revision));
  renderRibbon(state);
  renderActivity(state.activity);
  renderContext(state.context);
  renderTokens(state.tokens);
  renderSmartPrune(state.smart_prune);
  setText('state-meta', 'Generated ' + formatTimestamp(state.generated_at) + ' · schema ' + formatNumber(state.schema_version) + ' · revision ' + formatNumber(state.revision));
}

function schedulePoll(delay) {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = paused ? null : setTimeout(() => { void poll(); }, delay);
}

async function poll(force = false) {
  if (inFlight || (paused && !force)) return;
  inFlight = true;
  byId('refresh-now').disabled = true;
  setTransport(paused ? 'Refreshing once' : 'Refreshing', paused ? 'paused' : 'neutral');
  try {
    const response = await fetch('/data.json', { cache: 'no-store' });
    if (!response.ok) {
      setTransport('Transport unavailable', 'unavailable');
      return;
    }
    const envelope = await response.json();
    const nextState = isObject(envelope) ? envelope.state : null;
    const nextHeartbeat = isObject(envelope) ? envelope.heartbeat_at : null;
    if (!isValidState(nextState) || !isValidTimestamp(nextHeartbeat)) {
      setTransport('Invalid state', 'unavailable');
      return;
    }
    lastValidHeartbeat = nextHeartbeat;
    if (lastValidState === null || nextState.revision !== lastValidState.revision) renderState(nextState);
    updateFreshness();
    setTransport(paused ? 'Paused · refreshed' : 'Live', paused ? 'paused' : 'available');
  } catch (_error) {
    setTransport('Transport unavailable', 'unavailable');
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
    setTransport('Polling paused', 'paused');
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

byId('poll-toggle').addEventListener('click', () => setPaused(!paused));
byId('refresh-now').addEventListener('click', () => { void poll(true); });
setInterval(tickClocks, 1_000);
void poll();
