"use strict";
import type { BrowserWindow, WebContentsView as View, Session, IpcMain, Menu as ElectronMenu } from "electron";
export type Pick = ReturnType<typeof import("./browser-annotations.cts").cleanPick>;
export type Comment = {
  id: string;
  number: number;
  kind: string;
  pageUrl: string;
  anchor: Pick;
  body: string;
  screenshot: string | null;
  editing: string | null;
};
export type RestoreHistory = { entries: Electron.NavigationEntry[]; index: number };
export type Tab = {
  id: string;
  url: string;
  title: string;
  customTitle: string | null;
  agent: boolean;
  loading: boolean;
  error: string | null;
  failure: ReturnType<typeof import("./browser-policy.cts").loadFailure> | null;
  view: View;
  identityReady: Promise<void>;
  navigation: number;
  pendingHistory: RestoreHistory | null;
  comments: Comment[];
  draft: Comment | null;
  find: { open: boolean; text: string; matches: number; active: number; focus: number };
};
export type Options = {
  host: BrowserWindow;
  origin: string;
  WebContentsView: typeof View;
  session: { fromPartition: (partition: string) => Session };
  ipcMain: IpcMain;
  openExternal?: (url: string) => Promise<void>;
  Menu?: typeof ElectronMenu;
  clipboard: { writeText: (text: string) => void; writeImage: (image: Electron.NativeImage) => void };
  sessionId?: string;
  onChange?: () => void;
  presented?: boolean;
};
export type Command = {
  action: string;
  id: string;
  url: string;
  body: unknown;
  text: unknown;
  value: string | boolean | undefined;
};
export type Saved = {
  visible: boolean;
  activeId: string;
  tabs: {
    id: string;
    url: string;
    title: string;
    customTitle: string;
    agent: boolean;
    muted: boolean;
    zoom: number;
    history: Electron.NavigationEntry[];
    historyIndex: number;
  }[];
};

/** What the browser's parts share with the window that owns them. */
export type BrowserContext = {
  tabs: Map<string, Tab>;
  origin: string;
  Menu: typeof ElectronMenu | undefined;
  clipboard: Options["clipboard"];
  openExternal: Options["openExternal"];
  popups: { times: number[] };
  host: () => BrowserWindow;
  active: () => Tab | undefined;
  activeId: () => string | null;
  visible: () => boolean;
  presented: () => boolean;
  disposed: () => boolean;
  emit: () => void;
  place: () => void;
  focusInput: () => void;
  bumpFullView: () => void;
  zoom: (tab: Tab, direction: string) => void;
  openFind: (tab: Tab) => void;
  open: (url?: string, options?: OpenOptions) => string;
  close: (id: string | null) => void;
  select: (id: string, focus?: boolean | null) => void;
};
export type OpenOptions = {
  focus?: boolean;
  after?: string | null;
  id?: string | null;
  restoring?: RestoreHistory | null;
  agent?: boolean;
};
