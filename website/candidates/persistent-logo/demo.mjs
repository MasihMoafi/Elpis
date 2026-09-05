import { windowTokens, initialState, accounting, nextRequest, sentPrefix } from './fixture.mjs';
const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-US');
let state = initialState();
let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
let ticks = 0;
function render() {
  const result = accounting(state);
  $('used').textContent = number(result.used);
  $('used-percent').textContent = `${(result.used / windowTokens * 100).toFixed(1)}% used`;
  $('free-label').textContent = `${(result.free / windowTokens * 100).toFixed(1)}% context free`;
  $('context-bar').replaceChildren(...result.rows.map(([label, tokens, color]) => {
    const segment = document.createElement('span');
    segment.style.width = `${tokens / windowTokens * 100}%`;
    segment.style.backgroundColor = color;
    segment.title = `${label}: ${number(tokens)} tokens`;
    return segment;
  }));
  $('context-bar').setAttribute('aria-label', `Illustrative context: ${number(result.used)} of ${number(windowTokens)} tokens used`);
  $('categories').replaceChildren(...result.rows.map(([label, tokens, color]) => {
    const row = document.createElement('div'); row.className = 'flex items-center gap-2';
    const marker = document.createElement('span'); marker.textContent = '■'; marker.style.color = color;
    const name = document.createElement('span'); name.textContent = label;
    const count = document.createElement('span'); count.className = 'ml-auto text-base-content/60 tabular-nums'; count.textContent = number(tokens);
    row.append(marker, name, count); return row;
  }));
  $('source-toggle').checked = state.selected;
  $('pending').textContent = result.pending ? `ES.md ${state.selected ? 'inclusion' : 'exclusion'} pending. Measured context stays unchanged until the next fixture request.` : 'Selections match the current fixture request.';
  $('pending').classList.toggle('text-warning', result.pending);
  $('tool-status').textContent = ['Ready', 'Fresh result · 12,000 tokens', 'Admitted · 3,000 tokens'][state.stage];
  $('tool-body').textContent = [
    `Waiting for the illustrative tool result.\nThe existing context remains at ${number(result.used)} tokens.`,
    'fixture/context/ledger.rs   … repeated diagnostic output\nfixture/context/usage.rs    … category snapshots\nfixture/context/admit.rs    … admission decisions\n\n12,000 estimated tokens · not yet sent to the main model',
    'Finding: pending source estimates changed the measured bar.\nRetain the measured total until a new request snapshot arrives.\n\nOriginal fixture: retained separately · compact result: 3,000 tokens',
  ][state.stage];
  $('admission').classList.toggle('hidden', state.stage !== 2);
  $('prune-status').textContent = ['Waiting for fresh output', 'Optimizer inspecting unsent output', '1 of 1 eligible outputs shortened'][state.stage];
  $('stage-copy').textContent = [
    'Replay follows a fresh tool result through inspection and compact admission. Every number in this candidate is a fixture.',
    'The 12,000-token result is waiting at the admission boundary. It has not increased the main-model context.',
    'The next fixture request includes 3,000 compact tool tokens and the subsequent 600-token answer. Context is 51,600 before source selections are applied.',
  ][state.stage];
  $('reply').textContent = state.stage === 2 ? 'The pending source choice was changing the displayed measurement. The candidate now keeps those values stable until a new request.' : 'I’ll inspect the request accounting and the admission boundary.';
  $('evidence').textContent = JSON.stringify({ illustrative: true, raw_tokens: state.stage ? 12000 : 0, admitted_tool_tokens: state.stage === 2 ? 3000 : 0, avoided_tokens: result.saved, existing_sent_prefix: sentPrefix, source_change_pending: result.pending }, null, 2);
  document.body.dataset.paused = String(paused);
  $('pause').textContent = paused ? 'Resume' : 'Pause';
}
$('source-toggle').addEventListener('change', event => { state.selected = event.target.checked; render(); });
$('next').addEventListener('click', () => { state = nextRequest(state); render(); });
$('pause').addEventListener('click', () => { paused = !paused; render(); });
$('replay').addEventListener('click', () => { state = initialState(); ticks = 0; render(); });
setInterval(() => { if (!paused && state.stage < 2 && ++ticks % 4 === 0) { state.stage += 1; render(); } }, 1000);
render();
