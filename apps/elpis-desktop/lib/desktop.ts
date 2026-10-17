/** A page that failed to load: desktop/browser-policy.cjs loadFailure. */
export type BrowserFailure = { heading:string; summary:string; tips:string[]; code:string };
export type BrowserTab = { id:string; url:string; title:string; loading:boolean; error:string|null; failure:BrowserFailure|null; security:"secure"|"insecure"|"local"|null; zoom:number; comments:number; canGoBack:boolean; canGoForward:boolean };
/** A comment on the active page (annotation mode); `draft` is the one being written. */
export type BrowserComment = { id:string; number:number; kind:"element"|"region"|"text"; label:string; body:string };
export type BrowserState = { visible:boolean; activeId:string|null; focusAddress:number; tabs:BrowserTab[]; annotating:boolean; markersVisible:boolean; annotations:BrowserComment[]; draft:(BrowserComment&{editing:boolean})|null;
  agent?:{enabled:boolean;tabId:string|null};
  /** Counts Ctrl+Shift+F pressed on a page (the page has the key, not the window): each step asks the window to toggle full view. */
  fullView?:number;
  find:{ open:boolean; text:string; matches:number; active:number; focus:number } };
/** Commands that return more than the state: annotationsCollect and screenshot. */
export type BrowserResult = { count?:number; text?:string; images?:{number:number;dataUrl:string}[]; image?:string|null; copied?:boolean };
export type BrowserCommand = { id?:string; url?:string; body?:string; text?:string; value?:string|boolean };
export type DesktopBrowser = {
  command:(action:string,data?:BrowserCommand)=>Promise<BrowserState&{result?:BrowserResult}>;
  layout:(value:{bounds:{x:number;y:number;width:number;height:number};obscured:boolean})=>void;
  subscribe:(callback:(state:BrowserState)=>void)=>()=>void;
};
export type DesktopStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & { saveItem?:(key:string,value:string)=>Promise<void>;onError:(callback:(message:string)=>void)=>()=>void };
/** A terminal tab's shell (desktop/terminal.cjs): what it printed so far (the last part of `end` characters), and its exit code once it ends. */
export type TerminalSession = { id:number; end:number; shell:string; output:string; exited:number|null };
export type DesktopTerminal = {
  open:(key:string,cwd:string,cols:number,rows:number)=>Promise<TerminalSession>;
  restart:(key:string,cwd:string,cols:number,rows:number)=>Promise<TerminalSession>;
  close:(key:string)=>Promise<unknown>;
  tui:(key:string,cwd:string,threadId:string,cols:number,rows:number)=>Promise<{started?:boolean;running?:boolean}>;
  input:(key:string,data:string)=>void;
  resize:(key:string,cols:number,rows:number)=>void;
  copy:(text:string)=>Promise<unknown>;
  paste:()=>Promise<string>;
  subscribe:(onData:(key:string,id:number,end:number,data:string)=>void,onExit:(key:string,id:number,code:number)=>void)=>()=>void;
};
/** Quick Entry's global shortcut (desktop/quick-entry.cjs): whether this session allows one, and why the saved one does not work. */
export type QuickEntryStatus = { supported:boolean; reason?:string; shortcut:string; problem:string|null };
export type DesktopQuickEntry = { status:()=>Promise<QuickEntryStatus>; setShortcut:(accelerator:string)=>Promise<{shortcut:string}> };
declare global { interface Window { elpisDesktop?:{browser:DesktopBrowser;storage?:DesktopStorage;chooseFolder?:()=>Promise<string|null>;setTheme?:(dark:boolean,details?:{source:"system"|"light"|"dark";background:string})=>void;resolveFolder?:(folder:string)=>Promise<string>;openFile?:(target:string)=>Promise<void>;
  /** The editors "Open in" offers (desktop/editors.cjs; never VS Code) and a file opened in one, at a line. */
  editors?:()=>Promise<{id:string;name:string}[]>;openInEditor?:(target:string,editor:string,line?:number)=>Promise<void>;openFolder?:(folder:string)=>Promise<void>;terminal?:DesktopTerminal;onOpenThread?:(callback:(threadId:string)=>void)=>()=>void;
  /** A new chat from Quick Entry (sent with its text) or the tray's New chat (empty). */
  onNewChat?:(callback:(text:string)=>void)=>()=>void; quickEntry?:DesktopQuickEntry} } }
