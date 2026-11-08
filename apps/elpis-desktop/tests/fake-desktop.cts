// The desktop bridge as the renderer sees it, scripted inside the page: storage (the window's own localStorage, so a
// reload keeps what the desktop store would), the browser (what Electron's main process does with new, select, hide and
// close; every layout message the page sends for the native view lands in window.__layouts) and a shell per terminal tab.
// Use it as `page.addInitScript(fakeDesktop, { tabs })`; `tabs` are pages the browser already holds (hidden until selected).
// Quick Entry and the tray (desktop/main.cts): window.__newChat(text) hands the page a new chat as the main process does;
// the shortcut starts as `quickEntry` says, records each change in window.__shortcuts and refuses `quickEntry.refuse`.
import type { BrowserCommand, BrowserState, BrowserTab, DesktopTerminal, QuickEntryStatus } from '../lib/desktop.ts';

type State = Omit<BrowserState, 'activeId'> & { activeId: string | null | undefined };
type Calls = { open: Parameters<DesktopTerminal['open']>[]; closed: string[]; tui: Parameters<DesktopTerminal['tui']>[]; input: [string, string][]; resize: Parameters<DesktopTerminal['resize']>[] };
type TestWindow = typeof window & { __terminal: Calls; __commands: ({ action: string } & BrowserCommand)[]; __layouts: unknown[]; __emit(key: string, text: string): void; __browser: State; __push(patch: Partial<State>): void; __shortcuts: string[]; __newChat: ((text: string) => void) | undefined };
type Options = { tabs?: Partial<BrowserTab>[]; quickEntry?: Partial<QuickEntryStatus> & { refuse?: string[] } };
export type FakeDesktop = typeof fakeDesktop;
function fakeDesktop({ tabs: initial = [], quickEntry: quick = {} }: Options = {}) {
  const target = window as TestWindow;
  const calls: Calls = target.__terminal = { open: [], closed: [], tui: [], input: [], resize: [] }, commands: ({ action: string } & BrowserCommand)[] = target.__commands = [];
  target.__layouts = [];
  let data: (key: string, id: number, end: number, text: string) => void = () => {};
  let sessions = 0, pages = 0;
  const shells: Record<string, { id: number; end: number }> = {}, listeners = new Set<(state: BrowserState) => void>();
  target.__emit = (key, text) => { const shell = shells[key]; if (!shell) throw Error('Terminal missing'); shell.end += text.length; data(key, shell.id, shell.end, text); };
  const makeTab = (extra?: Partial<BrowserTab>): BrowserTab => ({ id: `page-${++pages}`, url: 'about:blank', title: 'New tab', loading: false, error: null, failure: null, security: null, zoom: 100, comments: 0, canGoBack: false, canGoForward: false, ...extra });
  const state: State = target.__browser = { visible: false, activeId: null, focusAddress: 0, tabs: [], annotating: false, markersVisible: true, annotations: [], draft: null, find: { open: false, text: '', matches: 0, active: 0, focus: 0 } };
  state.tabs = initial.map(makeTab); state.activeId = state.tabs[0]?.id ?? null;
  const push = target.__push = (patch: Partial<State>) => { Object.assign(state, patch); for (const listener of listeners) listener(JSON.parse(JSON.stringify(state))); };
  const handlers: Record<string, (args: BrowserCommand) => void> = {
    new: () => { const tab = makeTab(); push({ tabs: [...state.tabs, tab], activeId: tab.id, visible: true }); },
    select: args => push({ activeId: args.id, visible: true }),
    hide: () => push({ visible: false }),
    close: args => { const tabs = state.tabs.filter(tab => tab.id !== args.id); push({ tabs, activeId: tabs.at(-1)?.id ?? null, visible: tabs.length > 0 && state.visible }); },
  };
  const shellFor = (key: string) => shells[key] ? { ...shells[key], shell: 'bash', output: '', exited: null } : (shells[key] = { id: ++sessions, end: 0 }, { id: sessions, end: 0, shell: 'bash', output: '', exited: null });
  const { refuse = [], ...status } = { supported: true, shortcut: 'Ctrl+Alt+Space', problem: null, ...quick }, changes: string[] = target.__shortcuts = [];
  target.elpisDesktop = {
    onNewChat: callback => { target.__newChat = callback; return () => { target.__newChat = undefined; }; },
    quickEntry: {
      status: async () => ({ ...status }),
      setShortcut: async accelerator => {
        changes.push(accelerator);
        if (refuse.includes(accelerator)) throw Error('This shortcut is already in use by another app. Try a different combination.');
        Object.assign(status, { shortcut: accelerator, problem: null });
        return { shortcut: accelerator };
      },
    },
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, String(value)), removeItem: key => localStorage.removeItem(key), onError: () => () => {} },
    browser: {
      command: async (action, args = {}) => { commands.push({ action, ...args }); handlers[action]?.(args); return JSON.parse(JSON.stringify(state)); },
      layout: value => target.__layouts.push(JSON.parse(JSON.stringify(value))), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    terminal: {
      open: async (...args) => { calls.open.push(args); return shellFor(args[0]); },
      restart: async key => shellFor(key), close: async key => { calls.closed.push(key); delete shells[key]; return {}; },
      tui: async (...args) => { calls.tui.push(args); return { started: true }; },
      input: (key, text) => calls.input.push([key, text]), resize: (...args) => calls.resize.push(args),
      copy: async () => {}, paste: async () => '', subscribe: onData => { data = onData; return () => {}; },
    },
  };
}
module.exports = { fakeDesktop };
