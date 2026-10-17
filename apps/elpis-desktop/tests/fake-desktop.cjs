// The desktop bridge as the renderer sees it, scripted inside the page: storage (the window's own localStorage, so a
// reload keeps what the desktop store would), the browser (what Electron's main process does with new, select, hide and
// close; every layout message the page sends for the native view lands in window.__layouts) and a shell per terminal tab.
// Use it as `page.addInitScript(fakeDesktop, { tabs })`; `tabs` are pages the browser already holds (hidden until selected).
function fakeDesktop({ tabs: initial = [] } = {}) {
  const calls = window.__terminal = { open: [], closed: [], tui: [], input: [], resize: [] }, commands = window.__commands = [];
  window.__layouts = [];
  let data = () => {}, sessions = 0, pages = 0;
  const shells = {}, listeners = new Set();
  window.__emit = (key, text) => { const shell = shells[key]; shell.end += text.length; data(key, shell.id, shell.end, text); };
  const makeTab = extra => ({ id: `page-${++pages}`, url: 'about:blank', title: 'New tab', loading: false, error: null, failure: null, security: null, zoom: 100, comments: 0, canGoBack: false, canGoForward: false, ...extra });
  const state = window.__browser = { visible: false, activeId: null, focusAddress: 0, tabs: [], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 } };
  state.tabs = initial.map(makeTab); state.activeId = state.tabs[0]?.id ?? null;
  const push = window.__push = patch => { Object.assign(state, patch); for (const listener of listeners) listener(JSON.parse(JSON.stringify(state))); };
  const handlers = {
    new: () => { const tab = makeTab(); push({ tabs: [...state.tabs, tab], activeId: tab.id, visible: true }); },
    select: args => push({ activeId: args.id, visible: true }),
    hide: () => push({ visible: false }),
    close: args => { const tabs = state.tabs.filter(tab => tab.id !== args.id); push({ tabs, activeId: tabs.at(-1)?.id ?? null, visible: tabs.length > 0 && state.visible }); },
  };
  const shellFor = key => shells[key] ? { ...shells[key], shell: 'bash', output: '', exited: null } : (shells[key] = { id: ++sessions, end: 0 }, { id: sessions, end: 0, shell: 'bash', output: '', exited: null });
  window.elpisDesktop = {
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, String(value)), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      command: async (action, args = {}) => { commands.push({ action, ...args }); handlers[action]?.(args); return JSON.parse(JSON.stringify(state)); },
      layout: value => window.__layouts.push(JSON.parse(JSON.stringify(value))), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    terminal: {
      open: async (...args) => { calls.open.push(args); return shellFor(args[0]); },
      restart: async () => ({}), close: async key => { calls.closed.push(key); delete shells[key]; return {}; },
      tui: async (...args) => { calls.tui.push(args); return { started: true }; },
      input: (key, text) => calls.input.push([key, text]), resize: (...args) => calls.resize.push(args),
      copy: async () => {}, paste: async () => '', subscribe: onData => { data = onData; return () => {}; },
    },
  };
}
module.exports = { fakeDesktop };
