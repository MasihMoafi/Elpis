export const windowTokens = 128_000;
export const categories = [
  ['User messages', 1200, '#6fb5fd'], ['Agent messages', 1600, '#039b2c'],
  ['Reasoning', 2400, '#03dae5'], ['Tool calls', 800, '#a2810b'],
  ['Tool results', 28000, '#fcb24f'], ['System instructions', 4200, '#f0445d'],
  ['Developer messages', 3800, '#ef8cff'], ['Tool definitions', 6000, '#919191'],
];
export const sentPrefix = Object.freeze(['fixture-system-v1', 'fixture-user-v1', 'fixture-history-v1']);
export function initialState() { return { stage: 0, selected: true, admitted: true }; }
export function accounting(state) {
  const rows = categories.map(([label, tokens, color]) => [label, tokens, color]);
  if (state.stage === 2) { rows[4][1] += 3000; rows[1][1] += 600; }
  if (!state.admitted) rows[6][1] -= 800;
  const used = rows.reduce((sum, row) => sum + row[1], 0);
  return { rows, used, free: windowTokens - used, pending: state.selected !== state.admitted, saved: state.stage === 2 ? 9000 : 0 };
}
export function nextRequest(state) { return { ...state, admitted: state.selected }; }
