"use client";

import dynamic from "next/dynamic";
import { cloneElement, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AgentsIcon, ArchiveIcon, ChatIcon, FolderIcon, NewChatIcon, PinIcon, PlusIcon, SendIcon } from "@/components/elpis-icons";
import { Activity, Archive, ArrowLeft, Blocks, ChevronRight, PanelLeft, PanelRight, PanelRightClose, PanelRightOpen, Pin, RefreshCw, Search, Square, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { ApprovalCard, type QuestionAnswers } from "@/components/approval-card";
import { PlanCard } from "@/components/plan-card";
import { SearchField } from "@/components/ui/search-field";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/chat-message";
import { FailedTurnCard, type FailedTurn } from "@/components/failed-turn-card";
import { ViewBoundary } from "@/components/view-boundary";
import { Transcript } from "@/components/transcript";
import { readPins, savePins } from "@/lib/pins";
import { SHORTCUTS, shortcutFor } from "@/lib/shortcuts";
import { CommandMenu, type CommandAction } from "@/components/command-menu";
import { followUpChoices, followUpHint, followUpKey, followUpTooltip, isSendKey, newChatFolder, useAppPreferences, type Preferences } from "@/lib/preferences";
import { notifyApproval, notifyRuntimeEvent } from "@/lib/notifications";
import { queueFollowUp, sendQueuedFollowUp, type FollowUp, type FollowUpOptions } from "@/lib/follow-ups";
import { QueuedFollowUps } from "@/components/queued-follow-ups";
import { stopsOnEscape, usePromptKeys } from "@/lib/prompt-history";
import { PromptStatusLine } from "@/components/prompt-status";
import { ContextUsage } from "@/components/context-usage";
import { ElpisFeatures } from "@/components/elpis-features";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StartupSplash } from "@/components/startup-splash";
import { permissionLabel, PermissionsMenu, PlanPill, PlusMenu, SendOptionsMenu, type PermissionMode } from "@/components/composer-controls";
import { CopyButton } from "@/components/markdown-text";
import { liveEventItemKey, mergeHistoryWithLive, mergeLiveItem, runtimeErrorNotice } from "@/lib/live-events";
import { replacementEligibility } from "@/lib/turn-replacement";
import { AgentsView } from "@/components/agents-view";
import { AgentsGuide, AgentsGuideLink } from "@/components/agents-guide";
import { CanvasGuideHelp } from "@/components/canvas-guide-help";
import { CustomizeView } from "@/components/customize-view";
import type { TerminalLaunch } from "@/components/terminal-view";
import { ObservabilityView } from "@/components/observability-view";
import { NewAgentForm } from "@/components/new-agent-form";
import { SettingsView, type Tab as SettingsTab } from "@/components/settings-view";
import { DeleteChatsDialog, ThreadActions } from "@/components/thread-actions";
import { letterKey } from "@/components/action-menu";
import { SlashMenu, useSlashMenu, type SlashCommand } from "@/components/slash-menu";
import { MentionMenu, useMentionMenu } from "@/components/mention-menu";
import { NavButtons } from "@/components/nav-buttons";
import { PromptRail } from "@/components/prompt-rail";
import { RewindDialog, type RestoreMode } from "@/components/rewind-dialog";
import { usedMentions, type Mention } from "@/lib/mentions";
import { canBack, canForward, startHistory, step, visit, type History } from "@/lib/nav-history";
import { DiffPanel, ReviewPanel, SessionPanel, type ReviewTarget } from "@/components/slash-panels";
import { INIT_PROMPT } from "@/lib/init-prompt";
import { conversationMarkdown, exportFileName, lastReply } from "@/lib/slash";
import { openControl } from "@/lib/slash-focus";
import { reloadSettings, saveSettings, useElpisSettings } from "@/lib/settings-store";
import { UsagePanel } from "@/components/provider-usage";
import { Dictation } from "@/components/dictation";
import { chooseProject, EnvironmentMenu, ProjectActions, ProjectDialog, ProjectMenu } from "@/components/project-picker";
import { BranchChip } from "@/components/branch-chip";
import { keptNotice, projectFolderOf, type WorktreeOutcome } from "@/lib/chat-worktree";
import { AccountMenu } from "@/components/account-menu";
import { ModelPicker } from "@/components/model-picker";
import { appStorage, readProjects, saveProjects, type Project } from "@/lib/projects";
import { ResizeEdge } from "@/components/resize-edge";
import { TaskList, type TaskPlan } from "@/components/task-list";
import { AgentsCanvas } from "@/components/agents-canvas";
import { agentState, attentionLine, mergeListedThreads, stateLabels } from "@/lib/agents";
import { readAttention, saveAttention, type Attention } from "@/lib/attention";
import { insertTranscript } from "@/lib/dictation";
import { useBrowser } from "@/components/browser-panel";
import { onRequest as onFileRequest } from "@/lib/files-pane";
import { SidePanel, useSidePanel } from "@/components/side-panel";
import { SideChat, type SideRequest } from "@/components/side-chat";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { useSessionSplit } from "@/components/session-split";
import { Tab, TabStrip } from "@/components/tab-strip";
import { activate, activeTab, addTab, closeTab, cycle, followChat, forgetChats, makeTab, readTabs, renameTabs, startTabs, tabFor, writeTabs, type ChatTab, type ChatTabs } from "@/lib/chat-tabs";
import { readDraft, writeDraft } from "@/lib/drafts";
import { AttachmentChips } from "@/components/attachment-chips";
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS, TEXT_ONLY_NOTICE, attachFiles, fitAttachments, readAttachmentDraft, transferFiles, withoutSubmittedAttachments, writeAttachmentDraft, type Attachment } from "@/lib/attachments";
import { scanDeletionThreads } from "@/lib/thread-deletion";
import type { ThemeChoice } from "@/components/appearance-settings";
import { activityOf, api, unreadable, chatProvider, choiceOf, effortsOf, isAgent, isUnlinkedAgent, modelLabel, providerChoices, providerLabel, title,
  mediaUrl, sessionReady, type Approval, type Entry, type Item, type Model, type ProviderSettings, type Thread } from "@/lib/api";

const approvalDraftKey = (approval: Approval) => JSON.stringify([approval.ownerThreadId, approval.id]);

const LoveSpot = dynamic(() => import("@/components/love-spot"), { ssr: false, loading: () => <p role="status">Opening Love Spot…</p> });
type View = "chat" | "agents" | "agentsGuide" | "canvas" | "loveSpot" | "customize" | "observability" | "newAgent" | "settings";
type NextTurn = { model?: string; effort?: string; plan?: boolean };
type Live = { thread: Thread; activeTurnId?: string | null; permissions?: PermissionMode | null; planMode?: boolean };
/** The terminal's answer to a finished plan: Plan mode off, then this message. */
const IMPLEMENT_PLAN = "Implement the plan.";
/** The sidebar's width in pixels: the default, and how far its edge can be dragged. */
const SIDEBAR = { initial: 256, min: 200, max: 480 };
const without = <T,>(record: Record<string, T>, key: string) => { if (!(key in record)) return record; const next = { ...record }; delete next[key]; return next; };
// Sidebar sections by last activity, as in ChatGPT and Claude; the list keeps Elpis's own order inside each.
/** Whether a chat ran in a project's folder (trailing slashes ignored). */
const sameFolder = (a: string | undefined, b: string) => !!a && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export default function Home() {
  const preferences = useAppPreferences();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedRef = useRef<Thread | null>(null);
  // Chat tabs (lib/chat-tabs.ts): the shown tab follows the chat on screen, so every way of opening a chat lands in it.
  const [tabs, setTabs] = useState<ChatTabs>(startTabs);
  const tabsRef = useRef(tabs);
  const [tabsRestored, setTabsRestored] = useState(false);
  const restoredTabs = useRef(false);
  const updateTabs = useCallback((next: ChatTabs) => { tabsRef.current = next; setTabs(next); }, []);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogRequest = useRef(0);
  const refreshModels = useCallback(async () => {
    const id = ++catalogRequest.current; setCatalogLoading(true);
    try {
      const result = await api<{ data: Model[] }>("/models");
      if (!Array.isArray(result?.data)) throw new Error("The model catalogue did not return a model list.");
      if (catalogRequest.current === id) { setModels(result.data); setCatalogError(""); }
    } catch (cause) {
      if (catalogRequest.current === id) setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (catalogRequest.current === id) setCatalogLoading(false); }
  }, []);
  // One settings snapshot for the whole app, so a main model saved in Settings is what the next new chat starts with.
  const settingsSnapshot = useElpisSettings().data as unknown as ProviderSettings | null;
  const providerSettings = settingsSnapshot?.main && Array.isArray(settingsSnapshot.providers) ? settingsSnapshot : null;
  // New conversations: where to run and with what.
  const [choiceId, setChoiceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectChanging, setProjectChanging] = useState(false);
  const project = projects.find(item => item.id === projectId) ?? null;
  const [projectEdit, setProjectEdit] = useState<Project | null | undefined>(undefined);
  // Existing conversations: overrides for their next turn only.
  const [nextTurn, setNextTurn] = useState<Record<string, NextTurn>>({});
  const [threadModes, setThreadModes] = useState<Record<string, PermissionMode>>({});
  const [changingPermissions, setChangingPermissions] = useState(false);
  const [threadPlans, setThreadPlans] = useState<Record<string, boolean>>({});
  const [newPlan, setNewPlan] = useState(false);
  const [planAnswered, setPlanAnswered] = useState<Record<string, string>>({});
  const [pins, setPins] = useState<string[]>([]);
  const [attention, setAttention] = useState<Attention>({ unread: [], plans: {} });
  const [attentionLoaded, setAttentionLoaded] = useState(false);
  const planTurns = useRef(new Map<string, string>());
  useEffect(() => { setAttention(readAttention()); setAttentionLoaded(true); }, []);
  useEffect(() => {
    if (attentionLoaded) try { saveAttention(attention); } catch { setError("Could not save chat attention on this device."); }
  }, [attention, attentionLoaded]);
  const markRead = useCallback((id: string) => setAttention(previous => previous.unread.includes(id) ? { ...previous, unread: previous.unread.filter(value => value !== id) } : previous), []);
  useEffect(() => {
    setAttention(previous => {
      const answered = Object.keys(previous.plans).filter(id => previous.plans[id] === planAnswered[id]);
      if (!answered.length) return previous;
      return { ...previous, plans: Object.fromEntries(Object.entries(previous.plans).filter(([id]) => !answered.includes(id))) };
    });
  }, [planAnswered]);
  /** Chats awaiting the shared delete confirmation (a row's menu, D, or the header's Chat actions). */
  const [deleteTargets, setDeleteTargets] = useState<Thread[] | null>(null);
  /** "Deleted …" with its Undo, after the sidebar deletes chats; Ctrl+Z does the same. `shownWhenDeleted` reopens the chat that was open. */
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);
  const shownWhenDeleted = useRef(new Set<string>());
  /** Chats marked with Ctrl+click or Shift+click in the sidebar; `markAnchor` is where a Shift range starts. */
  const [marked, setMarked] = useState<string[]>([]);
  const markAnchor = useRef<string | null>(null);
  const threadList = useRef<HTMLDivElement>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const commandReturnFocus = useRef<HTMLElement | null>(null);
  /** The message whose "Rewind to here" is awaiting confirmation (its turn). */
  const [rewindTurn, setRewindTurn] = useState<string | null>(null);
  const [rewindActions, setRewindActions] = useState<Record<string, "undo" | "redo" | undefined>>({});
  const [rewindBusy, setRewindBusy] = useState(false);
  const rewindSwitch = useRef<string | null>(null);
  /** The chats and pages visited, for Back and Forward (lib/nav-history.ts). */
  const [history, setHistory] = useState<History>(() => startHistory({ view: "chat", threadId: null }));
  const historyRef = useRef(history), historySeeded = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renameRequest, setRenameRequest] = useState(false);
  /** What a slash command has open above the composer, and the one-line answer of a command that only reports. */
  const [panel, setPanel] = useState<"status" | "review" | "diff" | null>(null);
  const [slashNotice, setSlashNotice] = useState("");
  // A new chat in its own worktree (the Local/Worktree menu), and where an archived or deleted chat's worktree was kept.
  const [newWorktree, setNewWorktree] = useState(false), [worktreeNotice, setWorktreeNotice] = useState("");
  const noteKept = (text: string) => { if (text) setWorktreeNotice(previous => previous ? `${previous} ${text}` : text); };
  const shortcutAction = useRef<(id: string, index?: number) => void>(() => {});
  useEffect(() => { setPins(readPins()); }, []);
  const [newMode, setNewMode] = useState<PermissionMode | null>(null);
  const [text, setTextState] = useState("");
  const [shellMode, setShellMode] = useState(false);
  const shellCreated = useRef<string | null>(null);
  const [sideChat, setSideChat] = useState<{ parentId: string; open: boolean; question?: SideRequest } | null>(null);
  const sideRequests = useRef(0);
  const textRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  /** The mentions picked in the message box; a message carries those whose @name is still in its text. */
  const pickedMentions = useRef(new Map<string, Mention>());
  const filePickerRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const attachmentDrafts = useRef<Record<string, Attachment[]>>({});
  const [attaching, setAttaching] = useState(false);
  const readingFiles = useRef(false);
  const setAttachments = useCallback((value: Attachment[]) => { attachmentsRef.current = value; setAttachmentsState(value); }, []);
  const [dictating, setDictating] = useState(false);
  const setText = useCallback((value: string) => { textRef.current = value; setTextState(value); }, []);
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const [searchResults, setSearchResults] = useState<{ query: string; data: Thread[]; nextCursor: string | null; loading: boolean; error: string }>({ query: "", data: [], nextCursor: null, loading: false, error: "" });
  const drafts = useRef<Record<string, string>>({});
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, { id: string; answers: QuestionAnswers }>>({});
  const submitting = useRef(new Set<string>());
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, boolean>>({});
  async function submitDraft<T,>(key: string, send: () => Promise<T>): Promise<T> {
    if (submitting.current.has(key)) throw new Error("This request is already being sent.");
    submitting.current.add(key); setPendingDrafts(previous => ({ ...previous, [key]: true }));
    try { return await send(); }
    finally { submitting.current.delete(key); setPendingDrafts(previous => without(previous, key)); }
  }
  const clearApprovalDraft = useCallback((id: string) => setApprovalDrafts(previous => {
    const keys = Object.keys(previous).filter(key => previous[key].id === id);
    if (!keys.length) return previous;
    const next = { ...previous }; for (const key of keys) delete next[key]; return next;
  }), []);
  const draftAnswer = (approval: Approval, id: string, value: string[]) => {
    const key = approvalDraftKey(approval);
    setApprovalDrafts(previous => ({ ...previous, [key]: { id: approval.id, answers: { ...previous[key]?.answers, [id]: value } } }));
  };
  const newDraftKey = useRef("new");
  const [error, setError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready && connected && document.activeElement === document.body) composerRef.current?.focus();
  }, [ready, connected]);
  useEffect(() => {
    if (!ready || !searchTerm) { setSearchResults({ query: "", data: [], nextCursor: null, loading: false, error: "" }); return; }
    let disposed = false;
    setSearchResults({ query: searchTerm, data: [], nextCursor: null, loading: true, error: "" });
    const timer = setTimeout(() => {
      api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(searchTerm)}`)
        .then(result => { if (!Array.isArray(result.data)) throw unreadable("search"); if (!disposed) setSearchResults({ query: searchTerm, data: result.data, nextCursor: result.nextCursor, loading: false, error: "" }); })
        .catch(cause => { if (!disposed) setSearchResults({ query: searchTerm, data: [], nextCursor: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) }); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, searchTerm]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const savedDraft = useCallback((id: string) => drafts.current[id] ?? readDraft(id), []);
  const saveDraft = useCallback((id: string, value: string) => {
    drafts.current[id] = value;
    if (!writeDraft(id, value)) setError("Draft recovery is unavailable. Your text is kept in this window; copy it before reloading.");
  }, []);
  const editDraft = (value: string) => { setText(value); saveDraft(selectedRef.current?.id || newDraftKey.current, value); };
  const savedAttachments = useCallback((id: string) => attachmentDrafts.current[id] ?? (attachmentDrafts.current[id] = readAttachmentDraft(id)), []);
  const saveAttachments = useCallback((id: string, value: Attachment[]) => {
    attachmentDrafts.current[id] = value;
    if (!writeAttachmentDraft(id, value)) setError("Attachment recovery is unavailable. Your files are kept in this window; save them before reloading.");
  }, []);
  const restoreAttachments = useCallback((id: string) => {
    try { setAttachments(savedAttachments(id)); savedAttachments(`recovery-${id}`); }
    catch { setAttachments([]); setError("Saved attachments could not be restored. Add the files again before sending."); }
    setFileNotice("");
  }, [savedAttachments, setAttachments]);
  const clearSubmittedAttachments = (id: string, submitted: Attachment[]) => {
    const remaining = withoutSubmittedAttachments(savedAttachments(id), submitted); saveAttachments(id, remaining);
    if ((selectedRef.current?.id || newDraftKey.current) === id) setAttachments(remaining);
  };
  async function addFiles(files: File[]) {
    if (!files.length) return;
    if (shellMode) { setFileNotice("Bash mode is on, so nothing was added. Press Backspace in the empty message box to return to chat, then try again."); return; }
    if (readingFiles.current) { setFileNotice("Wait for the current files to finish reading."); return; }
    const owner = selectedRef.current?.id || newDraftKey.current;
    readingFiles.current = true; setAttaching(true); setFileNotice("");
    try {
      const read = await attachFiles(savedAttachments(owner), files, body => api("/attachments/extract", body));
      const fit = fitAttachments(savedAttachments(owner), read.added); // the list may have changed while the files were read
      if (read.added.length) { saveAttachments(owner, fit.kept); if ((selectedRef.current?.id || newDraftKey.current) === owner) setAttachments(fit.kept); }
      if (read.problems.length || fit.problems.length) throw Error([...read.problems, ...fit.problems].join("\n"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if ((selectedRef.current?.id || newDraftKey.current) === owner) setFileNotice(message);
      else setRuntimeNotices(previous => ({ ...previous, [owner]: message }));
    } finally { readingFiles.current = false; setAttaching(false); }
  }
  /** The browser's annotations and screenshots join the composer's files; its Send also sends the message. */
  async function attachFromBrowser(parts: Attachment[], submit: boolean) {
    const owner = selectedRef.current?.id || newDraftKey.current;
    try {
      const fit = fitAttachments(savedAttachments(owner), parts);
      if (fit.problems.length) throw Error(fit.problems.join("\n"));
      saveAttachments(owner, fit.kept); setAttachments(fit.kept); setFileNotice("");
    } catch (cause) { setFileNotice(cause instanceof Error ? cause.message : String(cause)); showChat(); return false; }
    showChat();
    if (submit) await send(); else requestAnimationFrame(() => composerRef.current?.focus());
    return true;
  }
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const rootPaging = useRef(false), loadedRootPages = useRef(false);
  const childPaging = useRef(new Set<string>()), loadedChildPages = useRef(new Set<string>());
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [newAgentVisited, setNewAgentVisited] = useState(false);
  const [observabilityVisited, setObservabilityVisited] = useState(false);
  const [newAgentVersion, setNewAgentVersion] = useState(0);
  const [settingsNavigation, setSettingsNavigation] = useState(0);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  // Each chat's latest task list (turn/plan/updated), shown above the message box (components/task-list.tsx).
  const [plans, setPlans] = useState<Record<string, TaskPlan>>({});
  // A fast turn can finish over SSE before its HTTP start response arrives.
  const completedTurns = useRef(new Set<string>());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [liveError, setLiveError] = useState<Record<string, string>>({});
  const [runtimeNotices, setRuntimeNotices] = useState<Record<string, string>>({});
  const [failedTurns, setFailedTurns] = useState<Record<string, FailedTurn>>({});
  const [related, setRelated] = useState<Record<string, Thread>>({});
  const [accountRefresh, setAccountRefresh] = useState(0);
  const [view, setView] = useState<View>("chat");
  const [guideBack, setGuideBack] = useState<"Agents" | "Canvas">("Agents");
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => { if (view === "chat" && selected) markRead(selected.id); }, [view, selected?.id, markRead]);
  const [settingsSection, setSettingsSection] = useState<SettingsTab>("general");
  const [desktop, setDesktop] = useState(false);
  const [windowAvailable, setWindowAvailable] = useState(false);
  const sessionWindowApi = () => window.elpisDesktop?.openSessionWindow ?? (window.parent !== window && new URLSearchParams(location.search).get("pane") === "1" ? window.parent.elpisDesktop?.openSessionWindow : undefined);
  useEffect(() => { setWindowAvailable(!!sessionWindowApi()); }, []);
  const browser = useBrowser();
  const side = useSidePanel(browser);
  useEffect(() => onFileRequest(() => { if (view !== "chat") setView("chat"); }), [view]);
  useEffect(() => { setDesktop(!!window.elpisDesktop?.browser); }, []);
  // The side panel (components/side-panel.tsx): shells and browser pages as tabs, beside the chat.
  const [hasTerminal, setHasTerminal] = useState(false);
  const [tuiLaunch, setTuiLaunch] = useState<TerminalLaunch | null>(null);
  useEffect(() => { setHasTerminal(!!window.elpisDesktop?.terminal); }, []);
  const panelShown = desktop && side.open && view === "chat";
  /** Full view (the side panel's): the panel fills the work area and the chat floats over it, as a card or folded to a pill. */
  const fullView = panelShown && side.full;
  /** A window too narrow for chat and panel side by side shows the panel alone; the chat comes back when it is needed. */
  const showChat = () => { if (side.full) side.setChatCollapsed(false); else if (matchMedia("(max-width: 760px)").matches) side.closePanel(); };
  useEffect(() => { if (selected?.id) showChat(); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 1000px)");
    const update = () => setPanelDrawer(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [agentsPanel, setAgentsPanel] = useState(true);
  // Theme: System follows the operating system; the choice is kept on this device.
  const [theme, setThemeChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  // The website's animated wordmark, its dark or light version (website/assets/branding).
  const brandMark = dark ? "/branding/elpis-wordmark-amber-loop.svg" : "/branding/elpis-wordmark-amber-light-loop.svg";
  // The sidebar's width, set by dragging its edge (components/resize-edge.tsx) and kept on this device.
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR.initial);
  useEffect(() => { const saved = Number(appStorage().getItem("elpis-sidebar-width")); if (saved >= SIDEBAR.min && saved <= SIDEBAR.max) setSidebarWidth(saved); }, []);
  const resizeSidebar = (width: number) => { setSidebarWidth(width); try { appStorage().setItem("elpis-sidebar-width", String(width)); } catch { /* the width still applies to this window */ } };
  const setTheme = (next: ThemeChoice) => { setThemeChoice(next); try { appStorage().setItem("elpis-theme", next); } catch { setError("Could not save appearance on this device."); } };
  const searchInput = useRef<HTMLInputElement>(null);
  const shortcutsReturnFocus = useRef<HTMLElement | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [childCursors, setChildCursors] = useState<Record<string, string | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  /** Each chat's last read transcript: reopening a chat draws it at once while it rereads, as in the ChatGPT app. */
  const transcripts = useRef(new Map<string, { entries: Entry[]; cursor: string | null }>());
  useEffect(() => { if (selected && !loading) transcripts.current.set(selected.id, { entries, cursor: itemCursor }); }, [selected, loading, entries, itemCursor]);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const request = useRef(0);
  const liveRevision = useRef(0), liveVersions = useRef(new Map<string, number>());
  const liveKeysAfter = useCallback((revision: number) => new Set([...liveVersions.current].filter(([, version]) => version > revision).map(([key]) => key)), []);

  const select = useCallback((thread: Thread | null) => {
    const launch = new URL(window.location.href);
    if (launch.searchParams.has("session") && launch.searchParams.get("session") !== (thread?.id || "")) {
      launch.searchParams.set("session", thread?.id || ""); window.history.replaceState(null, "", launch.pathname + launch.search);
    }
    selectedRef.current = thread; setSelected(thread); try { window.elpisDesktop?.storage?.setItem("elpis-last-chat", thread?.id || ""); } catch { /* The in-memory selection remains usable. */ } }, []);
  // Reported routes are authoritative; remembered settings fill list rows that omit model metadata.
  const settingsOf = useRef<Record<string, Pick<Thread, "model" | "modelProvider" | "reasoningEffort">>>({});
  const remember = (thread: Thread) => { if (thread.model) settingsOf.current[thread.id] = { model: thread.model, modelProvider: thread.modelProvider, reasoningEffort: thread.reasoningEffort ?? null }; return thread; };
  const threadsRef = useRef<Thread[]>([]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  const patchThread = useCallback((id: string, patch: Partial<Thread>) => {
    setThreads(prev => prev.map(thread => thread.id === id ? { ...thread, ...patch } : thread));
    if (selectedRef.current?.id === id) select({ ...selectedRef.current, ...patch });
  }, [select]);
  // Deleted and archived chats never reappear from a list read that raced with their removal.
  const hidden = useRef(new Set<string>());
  const upsertThread = useCallback((thread: Thread) => setThreads(prev => prev.some(item => item.id === thread.id) ? prev.map(item => item.id === thread.id ? { ...item, ...thread } : item) : [thread, ...prev]), []);
  const removeThreads = useCallback((ids: Set<string>, permanent: boolean) => {
    for (let grew = true; grew;) { grew = false; for (const thread of threadsRef.current) if (thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id)) { ids.add(thread.id); grew = true; } }
    for (const id of ids) { hidden.current.add(id); transcripts.current.delete(id); }
    if (permanent) {
      for (const id of ids) for (const key of [id, `recovery-${id}`]) { delete drafts.current[key]; writeDraft(key, ""); delete attachmentDrafts.current[key]; writeAttachmentDraft(key, []); }
      setMessageEdits(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !ids.has((JSON.parse(key) as [string, string, string])[0]))));
    }
    updateTabs(forgetChats(tabsRef.current, ids));
    setThreads(prev => prev.filter(thread => !ids.has(thread.id)));
    setMarked(prev => prev.some(id => ids.has(id)) ? prev.filter(id => !ids.has(id)) : prev);
    setApprovals(prev => prev.filter(approval => !ids.has(approval.params.threadId ?? "")));
    if (selectedRef.current && ids.has(selectedRef.current.id)) { request.current++; select(null); setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setEntries([]); setItemCursor(null); }
  }, [select, setText, savedDraft, restoreAttachments, updateTabs]);
  const refreshThreads = useCallback(async () => {
    const routesAtRequest = { ...settingsOf.current };
    const result = await api<{ data: Thread[]; nextCursor: string | null }>("/threads?limit=100"); if (!Array.isArray(result.data)) throw unreadable("conversations");
    result.data = result.data.filter(thread => !hidden.current.has(thread.id));
    // Preserve an event or local acknowledgment that arrived after this list request began.
    for (const thread of result.data) if (thread.model && settingsOf.current[thread.id] === routesAtRequest[thread.id]) remember({ ...settingsOf.current[thread.id], ...thread });
    // Listed rows omit forkedFromId (native stored rows); keep what thread/read or a fork already reported.
    const known = (t: Thread, prev: Thread[]) => ({ ...t, ...settingsOf.current[t.id], forkedFromId: t.forkedFromId ?? prev.find(p => p.id === t.id)?.forkedFromId ?? null });
    setThreads(prev => mergeListedThreads(prev, result.data.map(t => known(t, prev)), hidden.current, true));
    if (!loadedRootPages.current) setNextCursor(result.nextCursor);
    const updated = result.data.find(t => t.id === selectedRef.current?.id);
    if (updated) select({ ...selectedRef.current, ...updated, ...settingsOf.current[updated.id], forkedFromId: updated.forkedFromId ?? selectedRef.current?.forkedFromId ?? null });
  }, [select]);

  const loadMoreConversations = useCallback(async () => {
    if (!nextCursor || rootPaging.current) return;
    rootPaging.current = true; setMoreLoading(true);
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&cursor=${encodeURIComponent(nextCursor)}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      loadedRootPages.current = true;
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current)); setNextCursor(result.nextCursor);
    } catch (cause) { setError(String(cause)); }
    finally { rootPaging.current = false; setMoreLoading(false); }
  }, [nextCursor]);
  async function loadMoreSearch() {
    if (!searchResults.nextCursor || searchResults.loading || searchResults.query !== searchTerm) return;
    const query = searchTerm;
    setSearchResults(previous => ({ ...previous, loading: true, error: "" }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(query)}&cursor=${encodeURIComponent(searchResults.nextCursor)}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setSearchResults(previous => previous.query === query ? { query, data: mergeListedThreads(previous.data, result.data, hidden.current), nextCursor: result.nextCursor, loading: false, error: "" } : previous);
    } catch (cause) { setSearchResults(previous => previous.query === query ? { ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) } : previous); }
  }

  const loadThread = useCallback(async (thread: Thread) => {
    markRead(thread.id);
    // A chat that is already open in another tab brings that tab forward instead of opening twice.
    const owner = tabFor(tabsRef.current, thread.id);
    if (owner && owner.id !== tabsRef.current.activeId) updateTabs(activate(tabsRef.current, owner.id));
    saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); setText(savedDraft(thread.id));
    const id = ++request.current; stickToBottom.current = true; restoreScroll.current = null;
    liveVersions.current.clear(); const historyRevision = liveRevision.current;
    const shown = transcripts.current.get(thread.id);
    select(thread); setView("chat"); setSidebar(false); setEntries(shown?.entries ?? []); setItemCursor(shown?.cursor ?? null); setLoading(true); setError(""); restoreAttachments(thread.id);
    try {
      const result = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
      if (request.current !== id) return;
      select(remember(result.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...result.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(result.nextCursor);
    } catch (e) { if (request.current === id) setError(String(e)); return; }
    finally { if (request.current === id) setLoading(false); }
    // Follow it live in this app: subscribe, and learn the turn it is running now.
    try {
      const live = await api<Live>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
      if (request.current !== id || live.thread?.id !== thread.id) return;
      remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread); rememberModes(thread.id, live);
      if (live.activeTurnId && !completedTurns.current.has(live.activeTurnId)) setActiveTurns(prev => ({ ...prev, [thread.id]: live.activeTurnId! }));
      setLiveError(prev => without(prev, thread.id));
    } catch (e) { if (request.current === id) setLiveError(prev => ({ ...prev, [thread.id]: e instanceof Error ? e.message : String(e) })); }
  }, [select, setText, upsertThread, saveDraft, savedDraft, liveKeysAfter, restoreAttachments, updateTabs, markRead]);

  useEffect(() => { setText(savedDraft(newDraftKey.current)); }, [savedDraft]);

  // The desktop gets the theme as dark or not, the choice (System keeps the operating system in charge of pages in the browser)
  // and the page's own --background, resolved: main paints the browser's blank pages with it.
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); window.elpisDesktop?.setTheme?.(dark, { source: theme, background: getComputedStyle(document.body).backgroundColor }); }, [dark, theme]);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = appStorage().getItem("elpis-theme"); const stored = readProjects(); newDraftKey.current = stored.selectedId ? `new-${stored.selectedId}` : "new"; setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setProjects(stored.projects); setProjectId(stored.selectedId); setCwd(stored.projects.find(item => item.id === stored.selectedId)?.cwd ?? ""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not restore workspace preferences."); }
    try {
      const store = window.elpisDesktop?.storage, restored = store && readTabs(store);
      if (restored) {
        updateTabs(restored); restoredTabs.current = true;
        const shown = activeTab(restored);
        if (!shown.threadId && shown.draftKey) { newDraftKey.current = shown.draftKey; setText(savedDraft(shown.draftKey)); restoreAttachments(shown.draftKey); }
      }
    } catch { /* The tabs start afresh. */ }
    setTabsRestored(true);
    if (saved === "system" || saved === "light" || saved === "dark") setThemeChoice(saved);
    const media = matchMedia("(prefers-color-scheme: dark)"); setSystemDark(media.matches);
    const follow = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", follow); return () => media.removeEventListener("change", follow);
  }, []);
  useEffect(() => window.elpisDesktop?.storage?.onError(setError), []);
  // The mouse's side buttons go back and forward, as in a browser.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup") shortcutAction.current(event.button === 3 ? "back" : "forward");
    };
    const types = ["mousedown", "mouseup", "auxclick"] as const;
    for (const type of types) window.addEventListener(type, onMouse);
    return () => { for (const type of types) window.removeEventListener(type, onMouse); };
  }, []);
  // The ChatGPT app's shortcuts (lib/shortcuts.ts); the action reads this render's state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const hit = shortcutFor(event, typing); if (!hit) return;
      event.preventDefault(); shortcutAction.current(hit.id, hit.index);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    let disposed = false; let events: EventSource | undefined; let wasConnected = false; let recovery = 0;
    function disconnected() { wasConnected = false; recovery++; setConnected(false); setApprovals([]); }
    async function reconnect() {
      const attempt = ++recovery, thread = selectedRef.current, requestId = request.current;
      setAccountRefresh(value => value + 1);
      void refreshModels();
      try {
        await refreshThreads();
        await reloadSettings().catch(() => null);
        if (disposed || attempt !== recovery) return;
        if (!thread) return;
        const historyRevision = liveRevision.current;
        const history = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`);
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        select(remember(history.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...history.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(history.nextCursor);
        const live = await api<Live>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread); rememberModes(thread.id, live);
        setActiveTurns(previous => live.activeTurnId && !completedTurns.current.has(live.activeTurnId) ? { ...previous, [thread.id]: live.activeTurnId } : without(previous, thread.id));
        setLiveError(previous => without(previous, thread.id));
      } catch (error) {
        if (!disposed && attempt === recovery && thread) setLiveError(previous => ({ ...previous, [thread.id]: error instanceof Error ? error.message : String(error) }));
      }
    }
    async function initialize() {
      try {
        await sessionReady();
        const health = await api<{ connected: boolean }>("/health"); if (disposed) return; wasConnected = health.connected; setConnected(health.connected);
        void refreshModels();
        await refreshThreads();
        await reloadSettings().catch(() => null); if (disposed) return;
        setReady(true);
        // The chat of the shown tab comes back; without saved tabs, the last chat does.
        const launch = new URLSearchParams(location.search);
        const last = launch.has("session") ? launch.get("session") : restoredTabs.current ? activeTab(tabsRef.current).threadId : window.elpisDesktop?.storage?.getItem("elpis-last-chat");
        if (last && !selectedRef.current && request.current === 0) await loadThread({ id: last, ...(restoredTabs.current && activeTab(tabsRef.current).title ? { name: activeTab(tabsRef.current).title } : {}) } as Thread);
        events = new EventSource("/api/events");
        events.addEventListener("sideChat", event => window.dispatchEvent(new CustomEvent("elpis:side-chat", { detail: JSON.parse(event.data) })));
        events.addEventListener("connection", event => {
          const available = Boolean(JSON.parse(event.data).connected);
          if (!available) { disconnected(); return; }
          const recovered = !wasConnected; wasConnected = true; setConnected(true);
          if (recovered) void reconnect();
        });
        events.onerror = disconnected;
        events.addEventListener("message", event => {
          const { method, params } = JSON.parse(event.data);
          notifyRuntimeEvent(method, params, threadsRef.current, id => void loadThread({ id } as Thread)); void sendQueuedFollowUp(method, params).catch(e => setError(String(e)));
          const threadId: string | undefined = params.threadId ?? params.thread?.id;
          if (threadId && method === "turn/started" && !completedTurns.current.has(params.turn.id)) {
            planTurns.current.delete(threadId);
            setAttention(previous => ({ unread: previous.unread.filter(id => id !== threadId), plans: without(previous.plans, threadId) }));
          }
          if (threadId && method === "item/completed" && params.item?.type === "plan") planTurns.current.set(threadId, params.turnId);
          if (threadId && method === "turn/completed" && !completedTurns.current.has(params.turn.id) && params.turn.status === "completed" && !params.turn.error) {
            const unread = selectedRef.current?.id !== threadId || viewRef.current !== "chat";
            const planReady = planTurns.current.get(threadId) === params.turn.id || params.turn.items?.some((item: Item) => item.type === "plan");
            setAttention(previous => ({
              unread: unread ? [...new Set([...previous.unread, threadId])] : previous.unread.filter(id => id !== threadId),
              plans: planReady ? { ...previous.plans, [threadId]: params.turn.id } : previous.plans,
            }));
          }
          if (method === "turn/plan/updated" && Array.isArray(params.plan)) setPlans(prev => ({ ...prev, [params.threadId]: { turnId: params.turnId, explanation: params.explanation ?? null, steps: params.plan } }));
          // A new turn starts without a list; the last turn's list goes until this one makes its own.
          if (method === "turn/started") { setPlans(prev => prev[params.threadId] && prev[params.threadId].turnId !== params.turn.id ? without(prev, params.threadId) : prev); setRewindActions(prev => without(prev, params.threadId)); }
          if (method === "turn/started" && !completedTurns.current.has(params.turn.id)) { setActiveTurns(prev => ({ ...prev, [params.threadId]: params.turn.id })); setRuntimeNotices(prev => without(prev, params.threadId)); setFailedTurns(prev => without(prev, params.threadId)); patchThread(params.threadId, { status: { type: "active" } }); }
          if (method === "turn/completed") {
            completedTurns.current.add(params.turn.id);
            setActiveTurns(prev => prev[params.threadId] !== params.turn.id ? prev : without(prev, params.threadId));
            refreshThreads().catch(e => setError(String(e)));
            if (params.turn?.error) {
              setFailedTurns(prev => ({ ...prev, [params.threadId]: { turnId: params.turn.id, error: params.turn.error } }));
              setRuntimeNotices(prev => without(prev, params.threadId));
            } else {
              setFailedTurns(prev => without(prev, params.threadId));
              setRuntimeNotices(prev => without(prev, params.threadId));
            }
          }
          if (method === "error" && threadId) {
            const notice = runtimeErrorNotice(params);
            if (notice) setRuntimeNotices(prev => ({ ...prev, [threadId]: notice }));
          }
          if (method === "thread/status/changed" && params.status) patchThread(params.threadId, { status: params.status });
          // The engine's applied permission mode, from this or any other client.
          if (method === "thread/settings/updated" && params.permissions) setThreadModes(prev => ({ ...prev, [params.threadId]: params.permissions }));
          if (method === "thread/settings/updated" && params.threadSettings?.model) {
            const settings = { model: params.threadSettings.model, modelProvider: params.threadSettings.modelProvider, reasoningEffort: params.threadSettings.effort ?? null };
            settingsOf.current[params.threadId] = settings; patchThread(params.threadId, settings);
          }
          // Another client started working in a chat this window has not listed yet; Elpis lists it once stored.
          if (method === "thread/status/changed" && !threadsRef.current.some(thread => thread.id === params.threadId)) void (async () => {
            for (let attempt = 0; attempt < 5 && !threadsRef.current.some(thread => thread.id === params.threadId); attempt++) {
              await refreshThreads().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 1000));
            }
          })();
          if (method === "thread/started" && params.thread?.parentThreadId) upsertThread(params.thread);
          if (method === "thread/name/updated" || method === "thread/started") refreshThreads().catch(e => setError(String(e)));
          if (method === "thread/deleted" || (method === "thread/archived" && rewindSwitch.current !== params.threadId)) removeThreads(new Set([params.threadId]), method === "thread/deleted");
          const line = threadId ? activityOf(method, params) : null;
          if (line && threadId) setActivity(prev => prev[threadId] === line ? prev : { ...prev, [threadId]: line });
          if (!threadId || threadId !== selectedRef.current?.id) return;
          const itemKey = liveEventItemKey(method, params);
          if (itemKey) liveVersions.current.set(itemKey, ++liveRevision.current);
          setEntries(prev => mergeLiveItem(prev, method, params, threadId));
        });
        events.addEventListener("approval", event => { const approval = JSON.parse(event.data); notifyApproval(approval, threadsRef.current, id => void loadThread({ id } as Thread)); setApprovals(prev => [...prev.filter(a => a.id !== approval.id), approval]); });
        events.addEventListener("approvalResolved", event => { const { id } = JSON.parse(event.data); setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id); });
        events.addEventListener("unsupportedApproval", event => { const { method } = JSON.parse(event.data); setError(`Elpis requested an unsupported approval (${method}). Update the app to answer this request.`); });
        events.addEventListener("account", () => { setAccountRefresh(n => n + 1); void refreshModels(); });
      } catch (e) { if (!disposed) setError(String(e)); }
    }
    initialize(); return () => { disposed = true; catalogRequest.current++; events?.close(); };
  }, [refreshThreads, patchThread, upsertThread, removeThreads, select, liveKeysAfter, clearApprovalDraft, refreshModels]);

  const loadChildren = useCallback(async (id: string, cursor?: string, expand = true) => {
    if (childPaging.current.has(id)) return;
    childPaging.current.add(id); setLoadingChildren(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?ancestorThreadId=${encodeURIComponent(id)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
      setThreads(prev => mergeListedThreads(prev, result.data, hidden.current));
      if (cursor) loadedChildPages.current.add(id);
      if (cursor || !loadedChildPages.current.has(id)) setChildCursors(prev => ({ ...prev, [id]: result.nextCursor }));
      if (expand) setExpanded(prev => ({ ...prev, [id]: true }));
    } catch (e) { setError(String(e)); }
    finally { childPaging.current.delete(id); setLoadingChildren(prev => ({ ...prev, [id]: false })); }
  }, []);
  useEffect(() => { if (selected?.id && !selected.parentThreadId) loadChildren(selected.id); }, [selected?.id, selected?.parentThreadId, loadChildren]);
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useEffect(() => {
    if (!selected || !selectedLiveError || view !== "chat" || loading) return;
    const id = selected.id; let disposed = false, inFlight = false;
    const timer = setInterval(async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const historyRevision = liveRevision.current;
      try {
        const result = await api<{ thread: Thread; data: Entry[] }>(`/threads/${encodeURIComponent(id)}?limit=100`); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
        if (disposed || selectedRef.current?.id !== id) return;
        select(result.thread);
        setEntries(prev => {
          const fresh = [...result.data].reverse(); const byId = new Map(fresh.map(entry => [`${entry.turnId}:${entry.item.id}`, entry]));
          const merged = prev.map(entry => byId.get(`${entry.turnId}:${entry.item.id}`) || entry);
          const previousIds = new Set(prev.map(entry => `${entry.turnId}:${entry.item.id}`));
          merged.push(...fresh.filter(entry => !previousIds.has(`${entry.turnId}:${entry.item.id}`)));
          const preserved = mergeHistoryWithLive(prev, merged, liveKeysAfter(historyRevision));
          return JSON.stringify(preserved) === JSON.stringify(prev) ? prev : preserved;
        });
      } catch (e) { if (!disposed) setError(String(e)); } finally { inFlight = false; }
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selectedLiveError, view, loading, select, liveKeysAfter]);
  // Follow the control room even when its parent rows are collapsed in the sidebar.
  const knownIds = new Set(threads.map(thread => thread.id));
  const observedIds = JSON.stringify([...new Set([
    ...Object.keys(expanded).filter(id => expanded[id]),
    ...(view === "agents" ? threads.filter(thread => !thread.parentThreadId || !knownIds.has(thread.parentThreadId)).map(thread => thread.id) : []),
  ])].sort());
  useEffect(() => {
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true; if (view === "agents") setAgentsLoading(true);
      try {
        if (view === "agents") await refreshThreads();
        const ids = JSON.parse(observedIds) as string[];
        for (let start = 0; start < ids.length && !disposed; start += 3) await Promise.all(ids.slice(start, start + 3).map(id => loadChildren(id, undefined, false)));
      } catch (cause) { if (!disposed) setError(String(cause)); }
      finally { inFlight = false; if (!disposed) setAgentsLoading(false); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [observedIds, view, loadChildren, refreshThreads]);
  // Name the parent and the agent a continued chat came from, even when they are not on the loaded page.
  const relatedIds = [selected?.parentThreadId, selected?.forkedFromId].filter((id): id is string => !!id && !threads.some(thread => thread.id === id) && !related[id]);
  useEffect(() => {
    for (const id of relatedIds) api<{ thread: Thread }>(`/threads/${encodeURIComponent(id)}?limit=1`).then(result => setRelated(prev => ({ ...prev, [id]: result.thread }))).catch(() => {});
  }, [relatedIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const element = scroll.current; if (!element) return; if (restoreScroll.current) { const previous = restoreScroll.current; restoreScroll.current = null; element.scrollTop = previous.top + element.scrollHeight - previous.height; } else if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); }, [entries, selected?.id]);

  // A chat that was at its end stays there when its box changes size (full view turns the column into a card).
  useEffect(() => {
    const element = scroll.current, content = element?.firstElementChild; if (!element || !content) return;
    const observer = new ResizeObserver(() => { if (stickToBottom.current) element.scrollTo({ top: element.scrollHeight }); });
    observer.observe(element); observer.observe(content); return () => observer.disconnect();
  }, [view]);

  const activeTurn = selected ? activeTurns[selected.id] : undefined;
  useEffect(() => {
    const id = selected?.id; if (!id || activeTurn) return;
    let disposed = false;
    api<{ action?: "undo" | "redo" } | null>(`/threads/${encodeURIComponent(id)}/rewind`, { action: "status" }).then(result => {
      if (!disposed) setRewindActions(prev => ({ ...prev, [id]: result?.action }));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [selected?.id, activeTurn]);
  // A new chat runs with the configured defaults until a mode is chosen, so the button shows those.
  const configuredMode: PermissionMode = providerSettings?.options?.approvalPolicy !== "never" ? "ask"
    : providerSettings.options.sandboxMode === "bypass-permissions" ? "bypass" : providerSettings.options.sandboxMode === "danger-full-access" ? "full" : "ask";
  const permissionMode: PermissionMode = selected ? threadModes[selected.id] ?? "ask" : newMode ?? configuredMode;
  const planMode = selected ? nextTurn[selected.id]?.plan ?? threadPlans[selected.id] ?? false : newPlan;
  // The last finished turn's proposed plan, while the chat is still in Plan mode and it is unanswered.
  const lastTurnId = entries.at(-1)?.turnId;
  const proposedPlan = selected && planMode && lastTurnId && lastTurnId !== activeTurn && planAnswered[selected.id] !== lastTurnId && entries.some(entry => entry.turnId === lastTurnId && entry.item.type === "plan") ? lastTurnId : null;
  const outsideChatApprovals = approvals.filter(approval => view !== "chat" || approval.params.threadId !== selected?.id);
  const continues = selected?.desktopAccess?.mode === "continue";
  const choices = providerChoices(models, providerSettings);
  const newChoice = choices.find(choice => choice.id === choiceId) ?? choices[0];
  const needsModelId = !selected && !!newChoice?.provider;
  const selectedChoice = selected ? choiceOf(selected, choices) : null;
  const pending = selected ? nextTurn[selected.id] : undefined;
  const turnModel = selected ? pending?.model ?? selected.model ?? "" : model;
  const dictationProvider = chatProvider(turnModel, selected ? selected.modelProvider : newChoice?.provider, providerSettings?.main.provider);
  const turnEfforts = effortsOf(turnModel || providerSettings?.main.model, models);
  const turnEffort = selected ? pending?.effort ?? selected.reasoningEffort ?? "" : effort;
  const knownModel = (selected ? selectedChoice?.models : newChoice?.models)?.find(item => item.model === (turnModel || providerSettings?.main.model));
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const composerNotice = [fileNotice, imageBlocked ? TEXT_ONLY_NOTICE : ""].filter(Boolean).join("\n");
  const sendBlocked = (!text.trim() && !attachments.length) || busy || dictating || attaching || imageBlocked || !ready || !connected || (!shellMode && needsModelId && !model.trim());
  const recoveryAttachments = selected ? attachmentDrafts.current[`recovery-${selected.id}`] ?? [] : [];

  const find = (id?: string | null) => id ? threads.find(thread => thread.id === id) ?? related[id] : undefined;
  const selectedTitle = selected ? title(selected) : "";
  useEffect(() => { if (ready) updateTabs(followChat(tabsRef.current, selected ? { id: selected.id, title: selectedTitle } : null)); }, [ready, selected?.id, selectedTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTabs(renameTabs(tabsRef.current, id => { const thread = find(id); return thread ? title(thread) : undefined; })); }, [threads, related]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const store = window.elpisDesktop?.storage; if (tabsRestored && store && !writeTabs(tabs, store)) setError("Could not save the open chat tabs on this device."); }, [tabs, tabsRestored]);
  // Back and forward: each place reached (a chat, a new chat, a page) joins the stack; the first one only starts it.
  useEffect(() => {
    if (!ready) return;
    const place = { view, threadId: view === "chat" ? selected?.id ?? null : null };
    const next = historySeeded.current ? visit(historyRef.current, place) : startHistory(place);
    historySeeded.current = true;
    if (next !== historyRef.current) { historyRef.current = next; setHistory(next); }
  }, [ready, view, selected?.id]);
  // Elpis can replace turns only in chats it lets this app write directly, and not while one is running.
  const replaceable = !!selected && !continues && !activeTurn && selected.status?.type !== "active" && connected && !busy;
  const turnEntries = new Map<string, Entry[]>();
  for (const entry of entries) { const group = turnEntries.get(entry.turnId) ?? []; group.push(entry); turnEntries.set(entry.turnId, group); }
  const replacementOptions = new Map([...turnEntries].map(([id, group]) => [id, replacementEligibility(group, id, { historyComplete: !loading && itemCursor === null })]));
  const failedTurn = selected ? failedTurns[selected.id] : undefined;
  const failedInput = failedTurn ? replacementOptions.get(failedTurn.turnId) : undefined;
  const recoveredEdit = selected ? savedDraft(`recovery-${selected.id}`) : "";
  // The message box's history keys (lib/prompt-history.ts): ↑/↓ and Ctrl+R through what you sent, Esc Esc to edit the last.
  const promptKeys = usePromptKeys(selected?.id ?? newDraftKey.current, { entries, box: () => composerRef.current, read: () => textRef.current, write: writePrompt, editLast: editLastMessage });
  const regenerate = (() => {
    if (!replaceable) return null;
    const last = entries.at(-1); if (!last) return null;
    const turn = entries.filter(entry => entry.turnId === last.turnId);
    const eligibility = replacementOptions.get(last.turnId);
    const prompt = eligibility?.allowed ? eligibility.prompt : null;
    const reply = turn.filter(entry => entry.item.type === "agentMessage").at(-1);
    return prompt && reply ? { turnId: last.turnId, prompt, replyId: reply.item.id } : null;
  })();
  const parent = find(selected?.parentThreadId), source = find(selected?.forkedFromId);
  const waitingIds = new Set(approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId));
  const working = threads.filter(thread => agentState(thread, waitingIds) === "working").length;
  // The chat's team: a root shows its agents; an agent shows its siblings and the way back to the root.
  const teamRoot = selected ? (selected.parentThreadId ? find(selected.parentThreadId) ?? { id: selected.parentThreadId } as Thread : selected) : null;
  const team = teamRoot ? threads.filter(thread => thread.parentThreadId === teamRoot.id) : [];
  const folder = (path?: string | null) => path ? path.split("/").filter(Boolean).at(-1) || path : "";

  function openNewChat(draftKey = newDraftKey.current) { saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); newDraftKey.current = draftKey; request.current++; stickToBottom.current = true; restoreScroll.current = null; select(null); setEntries([]); setItemCursor(null); setText(savedDraft(draftKey)); setError(""); restoreAttachments(draftKey); setLoading(false); setView("chat"); setSidebar(false); requestAnimationFrame(() => composerRef.current?.focus()); }
  const newChat = () => openNewChat(tabDraftKey(activeTab(tabsRef.current)));
  const split = useSessionSplit({ thread: selected, text, attachments }, () => composerRef.current?.focus(), remaining => {
    const restore = () => { editDraft(remaining.text); setAttachments(remaining.attachments); saveAttachments(remaining.thread?.id || newDraftKey.current, remaining.attachments); };
    if (remaining.thread) void loadThread(remaining.thread).then(restore); else { newChat(); restore(); }
  });
  const openSplit = (thread: Thread) => { side.closePanel(); setAgentsPanel(false); setView("chat"); split.open(thread); };
  const openSessionWindow = (thread?: Thread) => { void sessionWindowApi()?.(thread?.id).catch(cause => setError(String(cause))); };

  /** An empty tab keeps its unsent text under its own key; the first one uses the project's new-chat draft. */
  const tabDraftKey = (tab: ChatTab) => tab.draftKey ?? (projectId ? `new-${projectId}` : "new");
  /** Puts the tab's chat (or empty chat) on screen. */
  function openTab(tab: ChatTab) {
    if (tab.threadId) void loadThread(find(tab.threadId) ?? { id: tab.threadId, ...(tab.title ? { name: tab.title } : {}) } as Thread);
    else openNewChat(tabDraftKey(tab));
  }
  function showTab(tab: ChatTab) {
    if (tab.id === tabsRef.current.activeId) { showChat(); return; }
    updateTabs(activate(tabsRef.current, tab.id)); openTab(tab);
  }
  /** The "+" and Ctrl+T: a new empty chat beside the others (a sibling chat, never an agent or a fork). */
  function newChatTab() { const tab = makeTab(); updateTabs(addTab(tabsRef.current, tab)); openNewChat(tabDraftKey(tab)); }
  function closeChatTab(id: string) {
    const before = tabsRef.current, next = closeTab(before, id);
    if (next === before) return;
    updateTabs(next);
    if (id === before.activeId) openTab(activeTab(next));
  }
  function cycleTabs(delta: number) { const next = cycle(tabsRef.current, delta); if (next !== tabsRef.current) { updateTabs(next); openTab(activeTab(next)); } }
  /** Back (-1) or Forward (1): to the previous or next place visited, skipping chats that are gone. */
  function goHistory(delta: -1 | 1) {
    const found = step(historyRef.current, delta, place => !place.threadId || !hidden.current.has(place.threadId));
    if (!found) return;
    historyRef.current = found.history; setHistory(found.history);
    const { view: target, threadId } = found.place;
    if (target !== "chat") show(target as View);
    else if (threadId === (selectedRef.current?.id ?? null)) show("chat");
    else if (threadId) void loadThread(find(threadId) ?? { id: threadId } as Thread);
    else openNewChat();
  }
  /** Middle-click on a chat in the sidebar: its own tab (or the one it already has). */
  function openInNewTab(thread: Thread) {
    const owner = tabFor(tabsRef.current, thread.id);
    if (owner) { showTab(owner); return; }
    updateTabs(addTab(tabsRef.current, makeTab(thread.id, title(thread)))); void loadThread(thread);
  }
  async function selectProject(next: Project | null) {
    setProjectChanging(true);
    try {
      if (next && window.elpisDesktop?.resolveFolder) await window.elpisDesktop.resolveFolder(next.cwd);
      await saveProjects(projects, next?.id ?? null); setProjectId(next?.id ?? null); setCwd(next?.cwd ?? ""); openNewChat(next ? `new-${next.id}` : "new");
    } finally { setProjectChanging(false); }
  }
  async function saveProject(next: Project) {
    const known = projects.some(item => item.id === next.id), updated = known ? projects.map(item => item.id === next.id ? next : item) : [...projects, next];
    if (known) { await saveProjects(updated, projectId); setProjects(updated); if (projectId === next.id) setCwd(next.cwd); return; }
    await saveProjects(updated, next.id); setProjects(updated); setProjectId(next.id); setCwd(next.cwd); openNewChat(`new-${next.id}`);
  }
  /** "Add new project" in the sidebar and the project menu: one click opens the native folder chooser, as in the ChatGPT app.
   * A browser has no chooser, so it asks for the path instead. */
  async function addProject() {
    try {
      const chosen = await chooseProject(projects);
      if (chosen === undefined) setProjectEdit(null);
      else if (chosen) await (projects.some(item => item.id === chosen.id) ? selectProject(chosen) : saveProject(chosen));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  /** Forgets the project; its folder and chats stay as they are. */
  async function removeProject(item: Project) {
    const updated = projects.filter(other => other.id !== item.id), current = projectId === item.id ? null : projectId;
    try { await saveProjects(updated, current); setProjects(updated); if (!current) { setProjectId(null); setCwd(""); } }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const show = (next: View) => { if (next !== "chat") side.toggleFull(false); if (next === "settings") { setSettingsVisited(true); setSettingsNavigation(value => value + 1); } if (next === "newAgent") setNewAgentVisited(true); if (next === "observability") setObservabilityVisited(true); setView(next); setSidebar(false); };
  const manageConnections = () => { setSettingsSection("providers"); show("settings"); };
  /** ChatGPT's "Fork chat from here": a new chat with the history through that turn, opened at once. */
  async function forkFrom(thread: Thread, lastTurnId: string) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/fork`, { lastTurnId }); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("fork"); upsertThread(result.thread);
      if (request.current !== originalRequest || selectedRef.current?.id !== thread.id) return;
      await loadThread(result.thread);
      if (selectedRef.current?.id === result.thread.id) restoreComposerFocus(originalFocus);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  /** What a reopened chat reports about its approval mode and Plan mode. */
  function rememberModes(id: string, live: Live) {
    if (live.permissions) setThreadModes(prev => ({ ...prev, [id]: live.permissions! }));
    if (typeof live.planMode === "boolean") setThreadPlans(prev => ({ ...prev, [id]: live.planMode! }));
  }
  const setPlan = (on: boolean) => selected ? setOverride(selected.id, { plan: on }) : setNewPlan(on);
  /** The plan card's answers (components/plan-card.tsx). Accept leaves Plan mode and asks Elpis to carry the plan out,
   * after switching the chat to `permissions` when one is chosen; Keep planning sends what should change, in Plan mode,
   * or with nothing to say just stays there. */
  async function answerPlan(thread: Thread, turnId: string, answer: { implement: true; permissions?: PermissionMode } | { feedback: string }) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    setPlanAnswered(prev => ({ ...prev, [thread.id]: turnId })); setError("");
    const implement = "implement" in answer, feedback = implement ? "" : answer.feedback.trim();
    if (!implement && !feedback) { focusComposer(); return; }
    try {
      if (implement && answer.permissions) {
        const changed = await api<{ permissions: PermissionMode }>(`/threads/${encodeURIComponent(thread.id)}/permissions`, { permissions: answer.permissions });
        setThreadModes(prev => ({ ...prev, [thread.id]: changed.permissions }));
      }
      const result = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/turns`, implement ? { text: IMPLEMENT_PLAN, mode: "default" } : { text: feedback });
      if (!result.turn?.id) throw new Error("Elpis did not acknowledge the new turn. Check the conversation before retrying.");
      if (implement) { setThreadPlans(prev => ({ ...prev, [thread.id]: false })); setNextTurn(prev => { const { plan: _, ...rest } = prev[thread.id] ?? {}; return Object.keys(rest).length ? { ...prev, [thread.id]: rest } : without(prev, thread.id); }); }
      if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: result.turn!.id }));
    } catch (e) { setPlanAnswered(prev => without(prev, thread.id)); setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  /** A chat's permission mode changes now, as the terminal's /permissions does: the engine applies it to the
   * running turn too, and the composer shows the mode the engine reports. A new chat's mode goes in its thread/start. */
  const permissionsLocked = !ready || busy || projectChanging || changingPermissions;
  const choosePermissions = (next: PermissionMode) => selected ? void changePermissions(selected.id, next) : setNewMode(next);
  /** Shift+Tab in the message box, as in Claude Code: Ask for approval, then Approve for me, then Plan mode, then back.
   * Full access and Bypass are chosen from the menu only; Shift+Tab from them returns to Ask for approval. */
  function cycleMode() {
    if (permissionsLocked) return;
    if (planMode) setPlan(false);
    else if (permissionMode === "auto") { choosePermissions("ask"); setPlan(true); }
    else choosePermissions(permissionMode === "ask" ? "auto" : "ask");
  }
  async function changePermissions(id: string, mode: PermissionMode) {
    setChangingPermissions(true); setError("");
    try {
      const result = await api<{ permissions: PermissionMode }>(`/threads/${encodeURIComponent(id)}/permissions`, { permissions: mode });
      setThreadModes(prev => ({ ...prev, [id]: result.permissions }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChangingPermissions(false); }
  }
  function setOverride(id: string, patch: NextTurn) {
    const thread = selectedRef.current; if (!thread) return;
    setNextTurn(prev => {
      const merged = { ...prev[id], ...patch };
      if (merged.model === (thread.model ?? undefined)) delete merged.model;
      if (merged.effort === (thread.reasoningEffort ?? undefined) || merged.effort === "") delete merged.effort;
      if (merged.plan === (threadPlans[id] ?? false)) delete merged.plan;
      return Object.keys(merged).length ? { ...prev, [id]: merged } : without(prev, id);
    });
  }
  /** Sends the composer's message, or `own`: a command's message (such as /init's prompt), sent without the composer's files.
   * While a turn runs, `followUp` steers or queues this one message instead of following Settings (Ctrl+Enter). */
  async function send(own?: string, followUp?: Preferences["followUp"]) {
    if (own === undefined && shellMode) { await sendShell(); return; }
    const sideQuestion = own === undefined ? /^\/btw(?:[\s:,.]\s*([\s\S]*))?$/i.exec(textRef.current.trim()) : null;
    if (sideQuestion) { if (selected) editDraft(""); askSideQuestion(sideQuestion[1]); return; }
    const outgoing = own ?? textRef.current, files = own === undefined ? attachmentsRef.current : [];
    if ((!outgoing.trim() && !files.length) || busy || dictating || attaching || projectChanging || !connected) return;
    if (imageBlocked && own === undefined) return; // the box already says why
    if (needsModelId && !model.trim()) { setError("Enter a model ID for the selected provider."); return; }
    setBusy(true); setError("");
    const sentText = outgoing, sentAttachments = [...files];
    const sentMentions = own === undefined ? usedMentions(outgoing, [...pickedMentions.current.values()]) : [];
    pickedMentions.current = new Map();
    const originalId = selected?.id || newDraftKey.current, originalRequest = request.current;
    const originalFocus = document.activeElement;
    const attached = { ...(sentAttachments.length ? { attachments: sentAttachments } : {}), ...(sentMentions.length ? { mentions: sentMentions } : {}) };
    let errorThreadId = selected?.id;
    try {
      let thread = selected;
      if (!thread) {
        const result = await api<{ thread: Thread }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}), ...(newWorktree ? { worktree: true } : {}) });
        thread = result.thread; errorThreadId = thread.id; if (newMode) setThreadModes(prev => ({ ...prev, [result.thread.id]: newMode }));
        saveDraft(thread.id, originalRequest === request.current ? textRef.current : sentText);
        saveAttachments(thread.id, originalRequest === request.current ? attachmentsRef.current : sentAttachments);
        if (originalRequest === request.current) { saveDraft(originalId, ""); saveAttachments(originalId, []); select(thread); }
        setThreads(prev => [thread!, ...prev]);
      }
      const used: NextTurn | undefined = selected ? pending : effort || newPlan ? { ...(effort ? { effort } : {}), ...(newPlan ? { plan: true } : {}) } : undefined;
      const turnOptions: FollowUpOptions = { ...(used?.model ? { model: used.model } : {}), ...(used?.effort ? { effort: used.effort } : {}), ...(used?.plan !== undefined ? { mode: used.plan ? "plan" : "default" } : {}) };
      if (activeTurn && !continues && queueFollowUp(thread.id, sentText, sentAttachments, { ...turnOptions, ...(sentMentions.length ? { mentions: sentMentions } : {}) }, followUp)) { /* queued until the running turn completes */ } else if (activeTurn && !continues) {
        await api(`/threads/${encodeURIComponent(thread.id)}/steer`, { text: sentText, expectedTurnId: activeTurn, ...attached });
      } else {
        const result = await api<{ turn?: { id: string }; thread?: Thread; continuedFrom?: string; sendError?: string }>(`/threads/${encodeURIComponent(thread.id)}/turns`, { text: sentText, ...attached, ...turnOptions, ...(continues ? { continueAs: `${title(thread)} (continued)` } : {}) });
        if (result.thread && result.sendError) {
          const forkDraft = savedDraft(result.thread.id);
          const hasNewerForkDraft = !!forkDraft.trim() && forkDraft !== sentText || savedAttachments(result.thread.id).length > 0;
          const targetKey = hasNewerForkDraft ? `recovery-${result.thread.id}` : result.thread.id;
          saveDraft(targetKey, sentText); saveAttachments(targetKey, sentAttachments); upsertThread(result.thread);
          setRuntimeNotices(previous => ({ ...previous, [result.thread!.id]: result.sendError + (hasNewerForkDraft ? " Your current draft is kept; recover the unsent message below." : "") }));
          if (savedDraft(thread.id) === sentText) saveDraft(thread.id, "");
          clearSubmittedAttachments(thread.id, sentAttachments); clearSubmittedAttachments(originalId, sentAttachments);
          if (selectedRef.current?.id === thread.id && textRef.current === sentText && request.current === originalRequest) setText("");
          if (selectedRef.current?.id === thread.id && request.current === originalRequest) await loadThread(result.thread);
          return;
        }
        if (!result.turn?.id) throw new Error("Elpis did not acknowledge the new turn. Check the conversation before retrying.");
        if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [result.thread?.id || thread!.id]: result.turn!.id }));
        if (used?.plan !== undefined) { setThreadPlans(prev => ({ ...prev, [result.thread?.id || thread!.id]: used.plan! })); if (!selected) setNewPlan(false); }
        if (selected && used) {
          setNextTurn(prev => without(prev, selected.id));
          const effective = { ...settingsOf.current[thread.id], ...(used.model ? { model: used.model } : {}), ...(used.effort ? { reasoningEffort: used.effort } : {}) };
          settingsOf.current[thread.id] = effective; patchThread(thread.id, effective);
        }
        if (result.thread) {
          upsertThread(result.thread);
          if (savedDraft(thread.id) === sentText) saveDraft(thread.id, "");
          clearSubmittedAttachments(thread.id, sentAttachments); clearSubmittedAttachments(originalId, sentAttachments);
          if (selectedRef.current?.id === thread.id && textRef.current === sentText && request.current === originalRequest) setText("");
          if (selectedRef.current?.id === thread.id && request.current === originalRequest) await loadThread(result.thread);
          return;
        }
      }
      if (savedDraft(originalId) === sentText) saveDraft(originalId, "");
      if (savedDraft(thread.id) === sentText) saveDraft(thread.id, "");
      clearSubmittedAttachments(originalId, sentAttachments); clearSubmittedAttachments(thread.id, sentAttachments);
      if (selectedRef.current?.id === thread.id && textRef.current === sentText && originalRequest === request.current) setText("");
    } catch (e) {
      for (const mention of sentMentions) pickedMentions.current.set(mention.path, mention);
      if (errorThreadId) setRuntimeNotices(previous => ({ ...previous, [errorThreadId!]: e instanceof Error ? e.message : String(e) }));
      else if (originalRequest === request.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      if (request.current === originalRequest && (errorThreadId ? selectedRef.current?.id === errorThreadId : !selectedRef.current)) restoreComposerFocus(originalFocus);
    }
  }
  async function sendShell() {
    const command = textRef.current, originalRequest = request.current;
    if (!command.trim() || busy || !connected || projectChanging) return;
    if (attachmentsRef.current.length) { setFileNotice("Bash mode is on. Return to chat to send attachments."); return; }
    setBusy(true); setError("");
    let thread = selectedRef.current;
    const originalId = thread?.id || newDraftKey.current;
    try {
      if (!thread) {
        const result = await api<{ thread: Thread }>("/threads", { ...(newMode ? { permissions: newMode } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(newChatFolder(cwd) ? { cwd: newChatFolder(cwd) } : {}) });
        thread = result.thread; upsertThread(thread);
        if (request.current === originalRequest) { saveDraft(originalId, ""); saveDraft(thread.id, command); shellCreated.current = thread.id; select(thread); }
      }
      await api(`/threads/${encodeURIComponent(thread.id)}/shell`, { command });
      if (savedDraft(thread.id) === command) saveDraft(thread.id, "");
      if (selectedRef.current?.id === thread.id && textRef.current === command && request.current === originalRequest) setText("");
    } catch (e) { if (request.current === originalRequest) setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); if (request.current === originalRequest) focusComposer(); }
  }
  async function stop(thread: Thread) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    try { await api(`/threads/${encodeURIComponent(thread.id)}/interrupt`, activeTurns[thread.id] ? { turnId: activeTurns[thread.id] } : {}); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  async function deleteThread(thread: Thread) {
    const ids = new Set([thread.id]);
    const descendants = await scanDeletionThreads<Thread>(({ archived, limit, cursor }) => api(`/threads?ancestorThreadId=${encodeURIComponent(thread.id)}&archived=${archived}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    for (const child of descendants) ids.add(child.id);
    const result = await api<{ alsoDeleted: string[]; worktree?: WorktreeOutcome }>(`/threads/${encodeURIComponent(thread.id)}/delete`, {});
    for (const id of result.alsoDeleted) ids.add(id);
    removeThreads(ids, true); noteKept(keptNotice(title(thread), "deleted", result.worktree));
  }
  async function renameThread(thread: Thread, name: string) {
    const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/rename`, { name });
    patchThread(thread.id, { name: result.thread.name ?? name });
  }
  // Elpis archives the chat with the agents it spawned; hide every loaded one.
  async function archiveThread(thread: Thread) {
    try { const result = await api<{ worktree?: WorktreeOutcome }>(`/threads/${encodeURIComponent(thread.id)}/archive`, {}); removeThreads(new Set([thread.id]), false); noteKept(keptNotice(title(thread), "archived", result.worktree)); }
    catch (e) { setError(`Could not archive “${title(thread)}”: ${e instanceof Error ? e.message : String(e)}`); }
  }
  function unarchived(thread: Thread) { hidden.current.delete(thread.id); upsertThread(thread); refreshThreads().catch(e => setError(String(e))); }
  /** Edit-and-resend and regenerate: Elpis replaces the turn and every later one, then runs the new text. */
  async function replaceFrom(turnId: string, replacement: string, editKey?: string, retryModel?: string) {
    const thread = selectedRef.current; if (!thread) return;
    const originalFocus = document.activeElement, originalRequest = request.current;
    if (savedDraft(`recovery-${thread.id}`) || savedAttachments(`recovery-${thread.id}`).length) throw new Error("Recover the saved edited message before replacing another turn.");
    const eligibility = replacementOptions.get(turnId);
    if (!eligibility?.allowed) throw new Error(eligibility && !eligibility.allowed ? eligibility.reason : "The complete input for this turn is unavailable.");
    const index = entries.findIndex(entry => entry.turnId === turnId);
    const stale = new Set(entries.slice(Math.max(index, 0)).map(entry => entry.turnId));
    const overrides = retryModel ? { ...nextTurn[thread.id], model: retryModel } : nextTurn[thread.id];
    const sendReplacement = () => api<{ turn?: { id: string }; rewound?: boolean; sendError?: string }>(`/threads/${encodeURIComponent(thread.id)}/revert`, { beforeTurnId: turnId, text: replacement,
      ...(overrides?.model ? { model: overrides.model } : {}), ...(overrides?.effort ? { effort: overrides.effort } : {}) });
    const result = editKey ? await submitDraft(editKey, sendReplacement) : await sendReplacement();
    if (result.rewound && result.sendError) {
      saveDraft(`recovery-${thread.id}`, replacement);
      if (selectedRef.current?.id === thread.id) await loadThread(thread);
      setRuntimeNotices(prev => ({ ...prev, [thread.id]: `${result.sendError} Your edited message is saved separately below; your composer draft is unchanged.` }));
      return;
    }
    if (!result.turn) throw new Error("Elpis did not acknowledge the replacement turn. Check the conversation before retrying.");
    if (editKey) setMessageEdits(previous => previous[editKey] === replacement ? without(previous, editKey) : previous);
    const startedTurn = result.turn;
    if (overrides) setNextTurn(prev => without(prev, thread.id));
    if (selectedRef.current?.id === thread.id) { stickToBottom.current = true; setEntries(prev => prev.filter(entry => !stale.has(entry.turnId))); }
    if (!completedTurns.current.has(startedTurn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: startedTurn.id }));
    if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus);
  }
  /** "Rewind to here": Elpis drops the turn and every later one (thread/revert, as edit-and-resend does) without sending anything;
   * the turn's prompt returns to an empty message box when it can be resent as text. */
  async function rewindFrom(turnId: string, mode: RestoreMode, version?: string) {
    const thread = selectedRef.current; if (!thread) return;
    const prompt = replacementOptions.get(turnId);
    await switchRewind({ action: "restore", beforeTurnId: turnId, mode, ...(version ? { version } : {}) }, mode === "code");
    if (mode !== "code" && prompt?.allowed && !textRef.current.trim()) editDraft(prompt.prompt);
    if (mode !== "code") focusComposer();
  }
  async function switchRewind(body: { action: string; beforeTurnId?: string; mode?: RestoreMode; version?: string }, filesOnly = false) {
    const thread = selectedRef.current; if (!thread) return;
    const draft = textRef.current; rewindSwitch.current = thread.id; setRewindBusy(true);
    try {
      const result = await api<{ thread?: Thread; undo?: "undo" | "redo" }>(`/threads/${encodeURIComponent(thread.id)}/rewind`, body);
      if (filesOnly || selectedRef.current?.id !== thread.id) return;
      const next = result.thread ?? thread;
      transcripts.current.delete(next.id); hidden.current.delete(next.id); upsertThread(next);
      if (next.id !== thread.id) { hidden.current.add(thread.id); setThreads(prev => prev.filter(item => item.id !== thread.id)); }
      setEntries([]); await loadThread(next);
      if (draft.trim()) editDraft(draft);
      setRewindActions(prev => ({ ...prev, [thread.id]: undefined, [next.id]: result.undo }));
    } finally { rewindSwitch.current = null; setRewindBusy(false); }
  }
  /** Answers a request; `instead` is "Deny, and tell Elpis what to do instead" (body: { text }). */
  async function answer(id: string, body: unknown, key: string, instead = false) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    await submitDraft(key, () => api(`/approvals/${encodeURIComponent(id)}${instead ? "/instead" : ""}`, body));
    setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id);
    if (request.current === originalRequest) restoreComposerFocus(originalFocus);
  }
  async function older() { if (!selected || !itemCursor) return; setLoading(true); const id = selected.id; try { const result = await api<{ data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(id)}?limit=100&cursor=${encodeURIComponent(itemCursor)}`); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (selectedRef.current?.id === id) { stickToBottom.current = false; if (scroll.current) restoreScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }; setEntries(prev => [...result.data.reverse(), ...prev]); setItemCursor(result.nextCursor); } } catch (e) { setError(String(e)); } finally { setLoading(false); } }
  const openById = (id: string) => loadThread(threads.find(thread => thread.id === id) || related[id] || { id });
  /** "Open in Elpis TUI": the chat opens here and its terminal resumes it in the TUI (`elpis resume <id>`). */
  const openInTui = (thread: Thread) => {
    if (selectedRef.current?.id !== thread.id || view !== "chat") void loadThread(thread);
    setTuiLaunch({ key: side.openTerminal(thread.cwd || cwd, thread.id), threadId: thread.id, token: Date.now() });
  };
  // The TUI's /app (`elpis-app --open-thread <id>`): the running window opens that chat.
  const openFromTui = useRef(openById); openFromTui.current = openById;
  useEffect(() => window.elpisDesktop?.onOpenThread?.(id => void openFromTui.current(id)), []);
  // Quick Entry's text opens a new chat and is sent, as in Claude; the tray's New chat opens one empty (desktop/main.cjs).
  // The text waits until the new chat is on screen and Elpis can send.
  const [desktopPrompt, setDesktopPrompt] = useState<string | null>(null);
  const openFromDesktop = useRef(newChat); openFromDesktop.current = newChat;
  useEffect(() => window.elpisDesktop?.onNewChat?.(prompt => { openFromDesktop.current(); setDesktopPrompt(prompt.trim() ? prompt : null); }), []);
  useEffect(() => {
    if (desktopPrompt === null || selected || view !== "chat" || !connected || busy || dictating || attaching || projectChanging) return;
    setDesktopPrompt(null); void send(desktopPrompt);
  }, [desktopPrompt, selected, view, connected, busy, dictating, attaching, projectChanging]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The terminal's slash commands this app performs (codex-rs/tui/src/slash_command.rs), in its popup order and mostly in its words.
   * Commands that run the model or rewrite the chat wait for an idle chat; controls and views are always there. */
  const openSettings = (tab: SettingsTab) => { setSettingsSection(tab); show("settings"); };
  const focusComposer = () => composerRef.current?.focus();
  /** A queued message's Edit in composer, as in Claude: it returns to the box above whatever is typed, with its files and @-mentions. */
  function editQueued(item: FollowUp) {
    editDraft([item.text, textRef.current].filter(part => part.trim()).join("\n\n"));
    for (const mention of item.mentions ?? []) pickedMentions.current.set(mention.path, mention);
    if (item.attachments.length) {
      const all = [...attachmentsRef.current, ...item.attachments], kept = all.slice(0, ATTACHMENT_LIMITS.count);
      setAttachments(kept); saveAttachments(selectedRef.current?.id || newDraftKey.current, kept);
      if (kept.length < all.length) setFileNotice(`A message holds up to ${ATTACHMENT_LIMITS.count} files; the extra files of the queued message were left out.`);
    }
    focusComposer();
  }
  /** Puts an earlier message (or the draft) in the box with the caret at its start or end, as the history keys do. */
  function writePrompt(value: string, caret: "start" | "end") {
    editDraft(value);
    requestAnimationFrame(() => { const at = caret === "end" ? value.length : 0; composerRef.current?.setSelectionRange(at, at); });
  }
  /** Esc Esc in an empty box opens the newest message you sent for editing, as in Claude; one that cannot be replaced says why. */
  function editLastMessage() {
    if (!replaceable || !selected) return;
    const last = entries.filter(entry => entry.item.type === "userMessage").at(-1); if (!last) return;
    const option = replacementOptions.get(last.turnId);
    if (!option?.allowed) { if (option) setSlashNotice(option.reason); return; }
    setMessageEdits(previous => ({ ...previous, [JSON.stringify([selected.id, last.turnId, last.item.id])]: option.prompt }));
  }
  /** The "+" menu's Add files or photos: the one chooser, for pictures and documents alike. */
  const pickFiles = () => filePickerRef.current?.click();
  /** The "+" menu's Mention: an "@" at the caret (after a space when words come before it), which opens the picker. */
  function startMention() {
    const box = composerRef.current, at = box?.selectionStart ?? textRef.current.length, before = textRef.current.slice(0, at);
    const glue = before && !/\s$/.test(before) ? " " : "", next = before + glue + "@" + textRef.current.slice(at), position = before.length + glue.length + 1;
    editDraft(next); setCaret(position); box?.focus(); requestAnimationFrame(() => box?.setSelectionRange(position, position));
  }
  /** The "+" menu's Slash commands: a "/" in an empty box, which opens the command list. */
  function startSlash() { editDraft("/"); setCaret(1); focusComposer(); }
  function askSideQuestion(question?: string) {
    if (!selected) { setError("Start a conversation before asking a side question."); return; }
    setSideChat({ parentId: selected.id, open: true, question: { id: ++sideRequests.current, text: question ?? "" } });
  }
  // Returning from a disappearing action must not override a field the person chose while it was pending.
  const restoreComposerFocus = (origin: Element | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === origin) focusComposer();
  });
  const focusSearch = () => { if (view === "settings") show("chat"); setSidebar(true); setSidebarCollapsed(false); requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); }); };
  /** A composer control opened for a command takes the focus; the composer gets it back when the control closes. */
  const openComposerControl = (label: string) => { const trigger = composerRef.current?.form?.querySelector<HTMLElement>(`[aria-label="${label}"]`); if (trigger) openControl(trigger, () => composerRef.current); };
  const closePanel = () => { setPanel(null); focusComposer(); };
  const lastTurn = entries.at(-1)?.turnId;
  const idle = !busy && !activeTurn && selected?.status?.type !== "active";
  const writable = !!selected && !continues;
  const chatFolder = selected ? selected.cwd : newChatFolder(cwd);
  const chooseEffort = (level?: string) => {
    if (!level) { openComposerControl("Reasoning effort"); return; }
    const match = turnEfforts.find(item => item.toLowerCase() === level.toLowerCase());
    if (!match) { setSlashNotice(`${modelLabel(turnModel || providerSettings?.main.model, models)} does not offer the reasoning effort “${level}”. It offers: ${turnEfforts.join(", ")}.`); return; }
    if (selected) setOverride(selected.id, { effort: match }); else setEffort(match);
  };
  async function startReview(thread: Thread, target: ReviewTarget) {
    setPanel(null); setError("");
    try {
      const result = await api<{ turn?: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/review`, { target });
      if (!result.turn?.id) throw new Error("Elpis did not acknowledge the review. Check the conversation before retrying.");
      if (!completedTurns.current.has(result.turn.id)) setActiveTurns(prev => ({ ...prev, [thread.id]: result.turn!.id }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    focusComposer();
  }
  function compactChat(thread: Thread, guidance?: string) {
    // The terminal reads a lone number as its pressure setting; this app has no such setting to save.
    if (guidance && /^\d+(\.\d+)?%?$/.test(guidance)) { setSlashNotice("A number sets the terminal's pressure compaction, which this app does not save. Compact now, or add words to guide the summary."); return; }
    api(`/threads/${encodeURIComponent(thread.id)}/compact`, guidance ? { instructions: guidance } : {}).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }
  async function exportChat(thread: Thread) {
    try {
      const all: Entry[] = []; let cursor: string | null = null;
      do { // Pages come newest first; each older page goes in front.
        const result: { data: Entry[]; nextCursor: string | null } = await api(`/threads/${encodeURIComponent(thread.id)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("conversations");
        all.unshift(...[...result.data].reverse()); cursor = result.nextCursor;
      } while (cursor && all.length < 100000);
      const link = document.createElement("a"), file = exportFileName(title(thread));
      link.href = URL.createObjectURL(new Blob([conversationMarkdown(title(thread), all)], { type: "text/markdown" })); link.download = file;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      setSlashNotice(`Exported the conversation as ${file}.`);
    } catch (e) { setError(`Could not export: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function turnSmartPruneOn() {
    try {
      const current = await api<{ version?: string | null; smartPrune?: { enabled: boolean | null } }>("/settings");
      if (current.smartPrune?.enabled) { setSlashNotice("Smart Prune is already on."); return; }
      await saveSettings("/settings", { version: current.version, options: { automaticPruning: true } });
      setSlashNotice("Smart Prune is on. It applies to new chats.");
    } catch (e) { setError(`Could not turn Smart Prune on: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const sessionRows: [string, string][] = [
    ["Model", modelLabel(turnModel || providerSettings?.main.model, models)],
    ["Provider", providerLabel(turnModel || providerSettings?.main.model, selected ? selected.modelProvider : newChoice?.provider ?? providerSettings?.main.provider, providerSettings?.providers)],
    ["Reasoning effort", turnEffort || "Default"],
    ["Permissions", permissionLabel(permissionMode)],
    ["Folder", chatFolder || "Default folder"],
    ["Chat", selected?.id ?? "Not started yet"],
  ];
  const slashCommands: SlashCommand[] = [
    { name: "btw", description: "Ask a quick side question without adding to the session", available: !!selected, args: true, run: askSideQuestion },
    { name: "model", description: "choose what model and reasoning effort to use", available: !busy, run: () => openComposerControl("Model") },
    { name: "effort", description: "change how hard the model thinks: /effort [low|medium|high|…]", available: !busy && turnEfforts.length > 0, args: true, run: chooseEffort },
    { name: "pruner-model", description: "view or set the model that prunes context; follows /memory-model when unset", run: () => openSettings("configuration") },
    { name: "memory-model", description: "set Smart Prune's fallback model; memory uses the responding agent", run: () => openSettings("configuration") },
    { name: "permissions", description: "choose what Elpis is allowed to do", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "yolo", description: "choose Full access or Bypass permissions", available: !busy, run: () => openComposerControl("Change permissions") },
    { name: "settings", description: "open Settings", run: () => openSettings("general") },
    { name: "memories", description: "configure memory use and generation", run: () => openSettings("personalization") },
    { name: "hooks", description: "view and manage lifecycle hooks", run: () => openSettings("hooks") },
    { name: "review", description: "review my current changes and find issues", available: writable && idle, args: true, run: text => { if (!selected) return; if (text) void startReview(selected, { type: "custom", instructions: text }); else setPanel("review"); } },
    { name: "rename", description: "rename the current thread", available: !!selected, args: true, run: text => { if (text && selected) renameThread(selected, text).catch(e => setError(e instanceof Error ? e.message : String(e))); else setRenameRequest(true); } },
    { name: "new", description: "start a new chat during a conversation", run: newChat },
    { name: "archive", description: "archive this session", available: !!selected, run: () => { if (selected) void archiveThread(selected); } },
    { name: "delete", description: "permanently delete this session", available: !!selected, run: () => { if (selected) setDeleteTargets([selected]); } },
    { name: "resume", description: "resume a saved chat", run: focusSearch },
    { name: "fork", description: "fork the current chat", available: !!selected && !!lastTurn && !activeTurn, run: () => { if (selected && lastTurn) void forkFrom(selected, lastTurn); } },
    { name: "init", description: "create an AGENTS.md file with instructions for Elpis", available: !continues && idle, run: () => void send(INIT_PROMPT) },
    { name: "compact", description: "compact now, or add words to guide the summary", available: writable && idle, args: true, run: text => { if (selected) compactChat(selected, text); } },
    { name: "prune", description: "turn Smart Prune on for new chats", available: idle, run: () => void turnSmartPruneOn() },
    { name: "plan", description: planMode ? "turn Plan mode off" : "turn Plan mode on", available: !busy, run: () => setPlan(!planMode) },
    { name: "agent", description: "switch the active agent thread", available: team.length > 0 && !panelShown, run: () => { setAgentsPanel(true); requestAnimationFrame(() => document.querySelector<HTMLElement>(".team-panel .team-row.active, .team-panel .team-row")?.focus()); } },
    { name: "agents", description: "open the task list to resume, rename or delete chats", run: () => show("agents") },
    { name: "copy", description: "copy the last response", available: !!lastReply(entries), run: () => { const reply = lastReply(entries); if (reply) navigator.clipboard.writeText(reply).then(() => setSlashNotice("Copied the last reply."), () => setError("Could not copy: the clipboard is unavailable.")); } },
    { name: "export", description: "export the conversation as markdown", available: !!selected && entries.length > 0 && idle, run: () => { if (selected) void exportChat(selected); } },
    { name: "diff", description: "show git diff (including untracked files)", available: !!selected, run: () => setPanel("diff") },
    { name: "status", description: "show current session configuration and token usage", run: () => setPanel("status") },
    { name: "pwd", description: "show the current working directory", available: !!chatFolder, run: () => setSlashNotice(`Current working directory: ${chatFolder}`) },
    { name: "usage", description: "inspect this session; /usage account opens usage and limits", args: true, run: text => { if (text) openSettings("usage"); else setPanel("status"); } },
    { name: "context", description: "show context usage as a grid, by category, with checkpoints and system files", available: !!selected, run: () => window.dispatchEvent(new CustomEvent("elpis:open-context")) },
    { name: "theme", description: "choose the theme", run: () => openSettings("appearance") },
    { name: "mcp", description: "list and manage MCP servers", run: () => openSettings("mcp") },
    { name: "rag", description: "use the configured RAG MCP server or manage it with /rag <request>", available: !continues && idle, run: () => void send("/rag") },
  ];
  const slash = useSlashMenu(text, slashCommands, () => { editDraft(""); setPanel(null); setSlashNotice(""); });
  const mention = useMentionMenu({ text, caret, cwd: chatFolder || undefined, threads, currentId: selected?.id,
    onPick: result => { pickedMentions.current.set(result.mention.path, result.mention); editDraft(result.text); setCaret(result.caret); requestAnimationFrame(() => composerRef.current?.setSelectionRange(result.caret, result.caret)); } });
  // A panel belongs to the chat and page it was opened on; a notice goes when the person types again.
  useEffect(() => { setPanel(null); }, [selected?.id, view]);
  useEffect(() => { if (shellCreated.current !== selected?.id || view !== "chat") setShellMode(false); shellCreated.current = null; setSideChat(null); }, [selected?.id, view]);
  useEffect(() => { if (text) setSlashNotice(""); }, [text]);

  const searchedThreads = searchTerm && searchResults.query === searchTerm ? mergeListedThreads(threads, searchResults.data, hidden.current) : threads;
  const matchedOnServer = new Set(searchTerm && searchResults.query === searchTerm ? searchResults.data.map(thread => thread.id) : []);
  const filtered = searchedThreads.filter(t => (matchedOnServer.has(t.id) || `${title(t)} ${t.agentNickname || ""} ${t.model || ""} ${t.id}`.toLowerCase().includes(searchTerm.toLowerCase())));
  const roots = filtered.filter(t => !isUnlinkedAgent(t, searchedThreads) && (!t.parentThreadId || !filtered.some(p => p.id === t.parentThreadId)));
  const unlinked = filtered.filter(t => isUnlinkedAgent(t, searchedThreads));
  const ordered = [...roots.filter(t => pins.includes(t.id)), ...roots.filter(t => !pins.includes(t.id))];
  // Esc stops the running reply, as in Claude, wherever in the chat the focus is, unless a menu, dialog or field owns the key.
  const escapeStops = useRef<(event: KeyboardEvent) => void>(() => {});
  escapeStops.current = event => { if (selected && activeTurn && view === "chat" && stopsOnEscape(event)) { event.preventDefault(); void stop(selected); } };
  useEffect(() => { const onKey = (event: KeyboardEvent) => escapeStops.current(event); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  shortcutAction.current = (id, index) => {
    const at = selected ? ordered.findIndex(t => t.id === selected.id) : -1;
    if (id === "new-chat") newChat();
    else if (id === "command-menu") { commandReturnFocus.current = document.activeElement as HTMLElement | null; setCommandMenuOpen(true); }
    else if (id === "side-chat" && selected && view === "chat") { setSideChat(previous => previous?.parentId === selected.id ? { ...previous, open: !previous.open } : { parentId: selected.id, open: true }); if (sideChat?.open) focusComposer(); }
    else if (id === "search") focusSearch();
    else if (id === "undo-delete") void undoDelete();
    else if (id === "sidebar") showSidebar(narrow() ? !sidebar : sidebarCollapsed);
    else if (id === "settings") { setSettingsSection("general"); show("settings"); }
    else if (id === "back" || id === "forward") goHistory(id === "back" ? -1 : 1);
    else if (id === "shortcuts") { shortcutsReturnFocus.current = document.activeElement as HTMLElement | null; setShortcutsOpen(true); }
    else if (id === "previous-chat" && ordered.length) void loadThread(ordered[at <= 0 ? 0 : at - 1]);
    else if (id === "next-chat" && ordered.length) void loadThread(ordered[at < 0 ? 0 : Math.min(ordered.length - 1, at + 1)]);
    else if (id === "go-to-chat" && index !== undefined && ordered[index]) void loadThread(ordered[index]);
    else if (id === "rename" && selected) setRenameRequest(true);
    else if (id === "archive" && selected) void archiveThread(selected);
    else if (id === "pin" && selected) togglePin(selected);
    else if (id === "copy-folder" && (selected?.cwd || cwd)) void navigator.clipboard.writeText(selected?.cwd || cwd);
    else if (id === "new-tab" && desktop) { newChatTab(); }
    else if (id === "close-tab" && desktop && view === "chat") closeChatTab(tabs.activeId);
    else if ((id === "next-tab" || id === "previous-tab") && desktop && view === "chat") cycleTabs(id === "next-tab" ? 1 : -1);
    else if (id === "full-view" && desktop) { if (view !== "chat") show("chat"); side.toggleFull(view === "chat" ? undefined : true); }
    else if (id === "terminal" && hasTerminal) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleTerminal(selected?.cwd || cwd, !away)) focusComposer(); }
    else if (id === "files" && desktop) { const away = view !== "chat"; if (away) show("chat"); if (!side.toggleFiles(!away)) focusComposer(); }
  };
  function togglePin(thread: Thread) {
    const next = pins.includes(thread.id) ? pins.filter(id => id !== thread.id) : [thread.id, ...pins];
    setPins(next); savePins(next);
  }
  /** A narrow window slides the sidebar over the page; a wide one collapses it (the sidebar button and Ctrl+B), as in ChatGPT and Claude. */
  function narrow() { return matchMedia("(max-width: 760px)").matches || (panelShown && panelDrawer); }
  function showSidebar(open: boolean) { if (!narrow()) { setSidebarCollapsed(!open); return; } setSidebar(open); if (open) setSidebarCollapsed(false); }
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [...threadList.current?.querySelectorAll<HTMLButtonElement>(".thread-row > .thread-link") ?? []];
  const rowOf = (element: Element | null) => element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** Opens the shared delete confirmation for these chats. */
  const chatsOf = (ids: string[]) => ids.map(id => searchedThreads.find(thread => thread.id === id) ?? find(id)).filter((thread): thread is Thread => !!thread);
  /** Deletes these chats as one step Ctrl+Z undoes: after the shared confirmation, or at once when it is turned off.
   * `focusAt` is the sidebar row to focus afterwards, so Ctrl+Z reaches the app and not a text field. */
  function deleteChats(ids: string[], focusAt?: number) {
    const targets = chatsOf(ids);
    if (!targets.length) return;
    if (preferences.confirmDeleteChats) { setDeleteTargets(targets); return; }
    void trashChats(targets).then(() => { if (focusAt !== undefined) requestAnimationFrame(() => { const links = rowLinks(); (links[focusAt] ?? links.at(-1))?.focus(); }); }, e => setError(String(e instanceof Error ? e.message : e)));
  }
  /** The bridge archives them now and deletes them for good when Elpis quits (bridge/trash.mjs). */
  async function trashChats(targets: Thread[]) {
    const ids = targets.map(thread => thread.id);
    if (selectedRef.current && ids.includes(selectedRef.current.id)) shownWhenDeleted.current.add(selectedRef.current.id);
    const { trashed, worktrees } = await api<{ trashed: string[]; worktrees?: { threadId: string; worktree: WorktreeOutcome }[] }>("/trash", { threadIds: ids });
    for (const { threadId, worktree } of worktrees ?? []) { const thread = targets.find(item => item.id === threadId); if (thread) noteKept(keptNotice(title(thread), "deleted", worktree)); }
    removeThreads(new Set(trashed), false);
    setDeletedNotice(targets.length === 1 ? `Deleted “${title(targets[0])}”` : `Deleted ${targets.length} chats`);
  }
  /** Ctrl+Z and the notice's Undo: the newest deletion comes back, with the chat that was open opened again. */
  async function undoDelete() {
    try {
      const { threads: back, restored } = await api<{ threads: Thread[]; restored?: string[] }>("/trash/undo", {});
      if (!back.length) return;
      setDeletedNotice(null);
      for (const id of restored ?? back.map(thread => thread.id)) hidden.current.delete(id);
      for (const thread of back) upsertThread(remember(thread));
      await refreshThreads();
      const reopen = back.find(thread => shownWhenDeleted.current.has(thread.id));
      for (const thread of back) shownWhenDeleted.current.delete(thread.id);
      if (reopen) await loadThread(reopen);
    } catch (e) { setError(`Could not bring back the deleted chat: ${e instanceof Error ? e.message : String(e)}`); }
  }
  useEffect(() => { if (!deletedNotice) return; const timer = setTimeout(() => setDeletedNotice(null), 8000); return () => clearTimeout(timer); }, [deletedNotice]);
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(thread: Thread, event: React.MouseEvent<HTMLButtonElement>) {
    if (event.altKey) { event.preventDefault(); openSplit(thread); return; }
    const ids = [...new Set(rowLinks().map(rowOf).filter((id): id is string => !!id))];
    if (event.ctrlKey || event.metaKey) {
      const base = marked.length ? marked : selected && ids.includes(selected.id) ? [selected.id] : [];
      setMarked(base.includes(thread.id) ? base.filter(id => id !== thread.id) : [...base, thread.id]); markAnchor.current = thread.id;
    } else if (event.shiftKey) {
      const to = ids.indexOf(thread.id), at = ids.indexOf(markAnchor.current ?? selected?.id ?? thread.id), from = at < 0 ? to : at;
      setMarked(ids.slice(Math.min(from, to), Math.max(from, to) + 1)); event.currentTarget.focus();
    } else { setMarked([]); markAnchor.current = thread.id; void loadThread(thread); }
  }
  /** Keys on a focused chat row: D deletes the marked chats, else this one (Claude's shortcut); ↑/↓ open the chat above or below; Escape clears the marks. */
  function listKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement, id = rowOf(target);
    if (!id || !event.currentTarget.contains(target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape" && marked.length) setMarked([]);
    else if (letterKey(event) === "u") attentionFor(id).planReady ? attentionFor(id).onComplete() : attentionFor(id).onToggleRead();
    else if (letterKey(event) === "d") deleteChats(marked.length ? marked : [id], rowLinks().findIndex(link => link.parentElement === target.closest(".thread-row")));
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const links = rowLinks(), next = links[links.findIndex(link => link.parentElement === target.closest(".thread-row")) + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      next.focus(); next.click();
    } else return;
    event.preventDefault();
  }
  function attentionFor(id: string) {
    return { unread: attention.unread.includes(id), planReady: !!attention.plans[id],
      onToggleRead: () => setAttention(previous => ({ ...previous, unread: previous.unread.includes(id) ? previous.unread.filter(value => value !== id) : [...previous.unread, id] })),
      onComplete: () => {
        setPlanAnswered(previous => ({ ...previous, [id]: attention.plans[id] }));
        setAttention(previous => ({ unread: previous.unread.filter(value => value !== id), plans: without(previous.plans, id) }));
      },
    };
  }
  function threadRow(thread: Thread, depth = 0) {
    const name = title(thread), state = agentState(thread, waitingIds, new Set(attention.unread)), pinned = pins.includes(thread.id);
    const subtitle = attentionLine(approvals.find(approval => (approval.params.threadId ?? approval.ownerThreadId) === thread.id), !!attention.plans[thread.id]);
    return <ThreadActions key={thread.id} thread={thread} onRequestDelete={() => deleteChats(marked.includes(thread.id) ? marked : [thread.id])} onRename={renameThread} onArchive={archiveThread} pinned={pinned} onPin={togglePin} onOpenInTui={hasTerminal ? openInTui : undefined} onOpenSplit={!split.pane ? openSplit : undefined} onOpenWindow={windowAvailable ? openSessionWindow : undefined} onNewWindow={windowAvailable ? () => openSessionWindow() : undefined}
      attention={attentionFor(thread.id)}
      selection={marked.length > 1 && marked.includes(thread.id) ? chatsOf(marked) : undefined}
      agents={!depth && !isAgent(thread) ? { shown: !!expanded[thread.id], onToggle: () => expanded[thread.id] ? setExpanded(prev => ({ ...prev, [thread.id]: false })) : void loadChildren(thread.id) } : undefined}
      area={<div className={`thread-row${depth ? " child" : ""}${selected?.id === thread.id && view === "chat" ? " active" : ""}${marked.includes(thread.id) ? " selected" : ""}`} data-thread-id={thread.id} style={depth ? { paddingLeft: `${Math.min(depth, 5) * 14}px` } : undefined} />}>
      {menu => <>
      {state === "unread" ? <button className="thread-dot" data-state={state} aria-label="Unread response. Mark as read" title="Unread response. Mark as read" onClick={() => markRead(thread.id)} /> : <span className="thread-dot" role="img" data-state={state} aria-label={stateLabels[state]} title={stateLabels[state]} />}
      <button className="thread-link" onMouseDown={event => { if (event.shiftKey || event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1 && desktop) { event.preventDefault(); openInNewTab(thread); } }} onClick={event => clickRow(thread, event)} title={name}>
        <span className="thread-title">{name}</span>
        {subtitle && <span className="thread-subtitle" title={subtitle}>{subtitle}</span>}
        {thread.forkedFromId && <span className="thread-nickname">Continued agent chat</span>}
      </button>
      {!depth && <span className="row-hover-actions"><Button variant="ghost" size="icon-xs" aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} title={pinned ? "Unpin" : "Pin"} onClick={() => togglePin(thread)}><PinIcon size={13} className={pinned ? "fill-current" : undefined} /></Button><Button variant="ghost" size="icon-xs" aria-label={`Archive ${name}`} title="Archive" onClick={() => void archiveThread(thread)}><ArchiveIcon size={13} /></Button></span>}
      {menu}
      </>}
    </ThreadActions>;
  }
  /** A chat's menu around its tab or title: the "…" button and right-click on `area` share one list. The shown chat's is "Chat actions". */
  const threadMenu = (thread: Thread, area: React.ReactElement, content: (menu: React.ReactNode) => React.ReactNode, shown: boolean) =>
    <ThreadActions label={shown ? "Chat actions" : undefined} thread={thread} attention={attentionFor(thread.id)} onRequestDelete={() => deleteChats([thread.id])} onRename={renameThread} onArchive={archiveThread} pinned={pins.includes(thread.id)} onPin={togglePin} onOpenInTui={hasTerminal ? openInTui : undefined} onOpenSplit={!split.pane ? openSplit : undefined} onOpenWindow={windowAvailable ? openSessionWindow : undefined} onNewWindow={windowAvailable ? () => openSessionWindow() : undefined} renameRequested={shown && renameRequest} onRenameRequestHandled={() => setRenameRequest(false)} area={area}>{content}</ThreadActions>;
  const chatActions = (area: React.ReactElement, content: React.ReactNode) => view === "chat" && selected
    ? threadMenu(selected, area, menu => <>{content}{menu}</>, true)
    : cloneElement(area, undefined, content);
  /** One chat tab: its title and close button, the "…" on the shown one, and the chat's menu on right-click. */
  function chatTab(tab: ChatTab) {
    const shown = tab.id === tabs.activeId, thread = tab.threadId ? (shown && selected?.id === tab.threadId ? selected : find(tab.threadId)) : undefined;
    const label = thread ? title(thread) : tab.threadId ? tab.title || "Chat" : "New chat";
    return <Tab key={tab.id} chat icon={<ChatIcon size={14} />} label={label} active={shown} closeLabel={`Close ${label} tab`} trailing={shown}
      wrap={thread ? (area, content) => threadMenu(thread, area, content, shown) : undefined} onSelect={() => showTab(tab)} onClose={() => closeChatTab(tab.id)} />;
  }
  function descendants(parentId: string, depth: number, seen = new Set<string>()): React.ReactNode {
    if (seen.has(parentId)) return null; const next = new Set(seen).add(parentId);
    return filtered.filter(c => c.parentThreadId === parentId).map(child => <div key={child.id}>{threadRow(child, depth)}{descendants(child.id, depth + 1, next)}</div>);
  }
  const heading = view === "chat" ? (selected ? title(selected) : "") : { agents: "Agents", agentsGuide: "Guide to managing agents", canvas: "Canvas", loveSpot: "Love Spot", customize: "Customize", observability: "Observability", newAgent: "New agent", settings: "Settings" }[view];
  const chatName = selected ? title(selected) : "New chat";
  const chatState = selected ? agentState(selected, waitingIds) : "idle", floatState = activeTurn && chatState === "idle" ? "working" : chatState;
  const meta = selected ? [selected.agentNickname, selected.agentRole && selected.agentRole !== "default" ? selected.agentRole : null].filter(Boolean).join(" · ") : "";
  const commandActions: CommandAction[] = ["new-chat", "search", "settings", "shortcuts", "sidebar", ...(desktop ? ["files", "full-view"] : []), ...(hasTerminal ? ["terminal"] : []), ...(selected ? ["rename", "pin", "archive"] : [])].filter(id => id !== "new-chat" || !projectChanging).map(id => {
    const shortcut = SHORTCUTS.find(item => item.id === id)!;
    return { id, name: id === "pin" ? `${pins.includes(selected!.id) ? "Unpin" : "Pin"} chat` : id === "shortcuts" ? "Keyboard shortcuts" : shortcut.label, keys: shortcut.keys, run: () => { if (id === "shortcuts") { shortcutsReturnFocus.current = commandReturnFocus.current; setShortcutsOpen(true); } else shortcutAction.current(id); } };
  });
  for (const [target, name] of [["agents", "Agents"], ["agentsGuide", "Guide to managing agents"], ["canvas", "Canvas"], ["loveSpot", "Love Spot"], ["observability", "Observability"], ["customize", "Customize"]] as const) commandActions.push({ id: target, name, run: () => { if (target === "agentsGuide") setGuideBack(view === "canvas" ? "Canvas" : "Agents"); show(target); } });

  return <div className={`app-shell${split.pane ? " session-pane" : ""}${split.thread && view === "chat" ? " session-split" : ""}${dark ? " dark" : ""}${desktop ? " has-title-bar" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${panelShown ? " panel-active" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    {desktop && <div className="title-bar"><Button variant="ghost" size="icon" aria-label={sidebarCollapsed || (panelShown && panelDrawer && !sidebar) ? "Open sidebar" : "Close sidebar"} title={`${sidebarCollapsed ? "Open" : "Close"} sidebar (Ctrl+B)`} onClick={() => showSidebar(narrow() ? !sidebar : sidebarCollapsed)}><PanelLeft /></Button><NavButtons canBack={canBack(history)} canForward={canForward(history)} onBack={() => goHistory(-1)} onForward={() => goHistory(1)} /></div>}
    <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} returnFocus={shortcutsReturnFocus} />
    {commandMenuOpen && <CommandMenu threads={threads} projects={busy || projectChanging ? [] : projects} actions={commandActions} returnFocus={commandReturnFocus} onClose={() => setCommandMenuOpen(false)} onThread={thread => { void loadThread(thread); }} onProject={item => { void selectProject(item).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }} onNewChat={prompt => { newChat(); setDesktopPrompt(prompt); }} />}
    {desktop && <StartupSplash done={ready && connected} steps={[{ label: "Elpis engine connected", ok: connected }, { label: "models loaded", ok: models.length > 0 }, { label: "conversations loaded", ok: ready }]} />}
    <ProjectDialog projects={projects} editing={projectEdit} onClose={() => setProjectEdit(undefined)} onSave={saveProject} />
    <DeleteChatsDialog threads={deleteTargets} trash={trashChats} onClose={() => setDeleteTargets(null)} />
    <RewindDialog threadId={selected?.id} turnId={rewindTurn} prompt={rewindTurn ? entries.find(entry => entry.turnId === rewindTurn && entry.item.type === "userMessage")?.item.content?.map(part => part.text ?? "").join("\n") ?? "" : ""} turns={rewindTurn ? Math.max(1, turnEntries.size - [...turnEntries.keys()].indexOf(rewindTurn)) : null} onConfirm={(mode, version) => rewindFrom(rewindTurn!, mode, version)} onClose={() => setRewindTurn(null)} />
    <aside className={`sidebar${sidebar ? " open" : ""}`} aria-label="Workspace navigation">
      <div className="brand"><Button className="sidebar-toggle" variant="ghost" size="icon-sm" aria-label="Close sidebar" title="Close sidebar (Ctrl+B)" onClick={() => showSidebar(false)}><PanelLeft size={16} /></Button><img src={brandMark} alt="Elpis" width={73} height={36} /></div>
      <nav className="nav-list" aria-label="Workspace">
        <Button className="new-chat" variant="ghost" aria-current={view === "chat" && !selected ? "page" : undefined} disabled={projectChanging} onClick={newChat}><NewChatIcon size={16} />New chat</Button>
        <Button variant="ghost" aria-current={view === "agents" ? "page" : undefined} onClick={() => show("agents")}><AgentsIcon size={16} />Agents{working > 0 && <span className="nav-badge" aria-hidden="true"><i />{working}</span>}</Button>
        <Button variant="ghost" aria-current={view === "canvas" ? "page" : undefined} onClick={() => show("canvas")}><Workflow size={16} />Canvas</Button>
        <Button variant="ghost" aria-current={view === "loveSpot" ? "page" : undefined} onClick={() => show("loveSpot")}><img src="/love-spot.png" alt="" width={16} height={16} />Love Spot</Button>
        <Button variant="ghost" aria-current={view === "customize" ? "page" : undefined} onClick={() => show("customize")}><Blocks size={16} />Customize</Button>
        <Button variant="ghost" aria-current={view === "observability" ? "page" : undefined} onClick={() => show("observability")}><Activity size={16} />Observability</Button>      </nav>
      <SearchField ref={searchInput} hint="Ctrl Shift K" aria-label="Search conversations" placeholder="Search conversations" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); setSearch(""); focusComposer(); } }} />
      <div className="thread-list" ref={threadList} onKeyDown={listKeys}>
        {!searchTerm && <section aria-label="Projects"><div className="section-label section-label-row">Projects<Button variant="ghost" size="icon-xs" aria-label="Add new project" title="Add new project: choose a folder" onClick={() => void addProject()}><PlusIcon size={13} /></Button></div>
          {projects.map(item => { const open = !collapsedProjects[item.id], chats = threads.filter(t => !t.parentThreadId && sameFolder(t.cwd && projectFolderOf(t.cwd), item.cwd)).slice(0, 5);
            return <div key={item.id} className="project-group">
              <ProjectActions project={item} onEdit={setProjectEdit} onRemove={removeProject} area={<div className={`project-row${project?.id === item.id ? " active" : ""}`} />}>
                {menu => <><button className="project-toggle" aria-expanded={open} title={item.cwd} onClick={() => setCollapsedProjects(prev => ({ ...prev, [item.id]: open }))}><ChevronRight size={13} className="project-chevron" /><FolderIcon size={14} /><span>{item.name}</span></button>
                  <span className="project-row-actions">{menu}</span><Button className="project-new-chat" variant="ghost" size="icon-xs" aria-label={`Start new chat in ${item.name}`} title="New chat in this project" disabled={!ready || busy} onClick={() => void selectProject(item)}><PlusIcon size={13} /></Button></>}
              </ProjectActions>
              {open && <div className="project-chats">{chats.map(t => threadRow(t))}{!chats.length && <p className="project-empty">No chats yet</p>}</div>}
            </div>; })}
        </section>}
        {[{ label: "Pinned", list: roots.filter(t => pins.includes(t.id)) }, { label: searchTerm ? "Results" : "Recents", list: roots.filter(t => !pins.includes(t.id)) }].filter(group => group.list.length).map(group => <section key={group.label} aria-label={group.label}><div className="section-label-row"><div className="section-label">{group.label}</div>{group.label === "Recents" && attention.unread.length > 0 && <Button variant="ghost" size="xs" onClick={() => setAttention(previous => ({ ...previous, unread: [] }))}>Mark all as read</Button>}</div>
          {group.list.map(t => <div key={t.id}>{threadRow(t)}{expanded[t.id] && descendants(t.id, 1)}{expanded[t.id] && childCursors[t.id] && <Button variant="ghost" size="xs" onClick={() => loadChildren(t.id, childCursors[t.id]!)}>More agents</Button>}</div>)}
        </section>)}
        {unlinked.length > 0 && <div className="unlinked-thread-list" aria-label="Agents whose parent is not listed"><div className="section-label mt-4" title="Their parent conversation is not in the current list.">Other agents</div>{unlinked.map(thread => threadRow(thread))}</div>}
        {ready && !threads.length && <p className="px-2 text-xs text-muted-foreground">Your conversations will appear here.</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.loading && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Searching saved conversations…</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.error && <p role="alert" className="px-2 py-3 text-xs text-destructive">Could not search saved conversations: {searchResults.error}</p>}
        {searchTerm && searchResults.query === searchTerm && !searchResults.loading && !searchResults.error && !filtered.length && <p className="px-2 py-3 text-xs text-muted-foreground">No matching conversations.</p>}
        {searchTerm ? searchResults.nextCursor && <Button variant="ghost" className="w-full" disabled={searchResults.loading} onClick={() => void loadMoreSearch()}>More search results</Button> : nextCursor && <Button variant="ghost" className="w-full" disabled={moreLoading} onClick={() => void loadMoreConversations()}>Load more</Button>}
      </div>
      <UsagePanel refreshKey={accountRefresh} onOpen={() => { setSettingsSection("usage"); show("settings"); }} />
      <div className="sidebar-footer"><AccountMenu refreshKey={accountRefresh} dark={dark} onTheme={() => setTheme(dark ? "light" : "dark")} onSettings={() => openSettings("general")} onAccounts={manageConnections} /></div>
      <span className="status-line"><i className={`status-dot${connected ? " connected" : ""}`} />{connected ? "Local workspace" : "Disconnected"}</span>
      <ResizeEdge label="Resize sidebar" width={sidebarWidth} min={SIDEBAR.min} max={SIDEBAR.max} initial={SIDEBAR.initial} grows="right" onResize={resizeSidebar} />
    </aside>
    <main className="workspace" style={panelShown && !fullView && side.width ? { "--side-w": `clamp(360px, ${side.width}px, 70%)` } as CSSProperties : undefined}>
      <header className={`workspace-header${heading ? "" : " untitled"}`}>
        {outsideChatApprovals.length > 0 && <div className="pending-input-anchor"><Button ref={pendingInputButton} className="pending-input-trigger" variant="secondary" size="sm" aria-label={`Needs input (${outsideChatApprovals.length})`} aria-expanded={pendingInputOpen} aria-controls="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") setPendingInputOpen(false); }} onClick={() => setPendingInputOpen(value => !value)}><span className="pending-count">{outsideChatApprovals.length}</span>Needs input<span className="pending-task-name">{title(threads.find(thread => thread.id === outsideChatApprovals[0].params.threadId) || outsideChatApprovals[0].thread || {id:outsideChatApprovals[0].params.threadId || "unreported"})}</span></Button></div>}
        <Button className="mobile-menu sidebar-open" variant="ghost" size="icon-sm" aria-label="Open sidebar" title="Open sidebar (Ctrl+B)" onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>
        <img className="mobile-brand" src={brandMark} alt="" aria-hidden="true" width={49} height={24} />
        <div className="header-titles min-w-0 flex-1">
          {view === "chat" && desktop && !split.pane
            ? <TabStrip label="Chat tabs" activeKey={tabs.activeId} add={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New chat tab" title="New chat tab (Ctrl+T)" onClick={newChatTab}><PlusIcon size={15} /></Button>}>
                {tabs.tabs.map(chatTab)}
              </TabStrip>
            : chatActions(<div className="header-title-row" />, <h1>{heading}</h1>)}
          {view === "agents" && <p className="page-description">Your conversations and agents. Open a chat or follow a running task.</p>}
          {view === "chat" && selected && meta && <p className="thread-meta">{meta}</p>}
          {view === "chat" && selected && (selected.parentThreadId || selected.forkedFromId) && <p className="thread-links">
            {selected.parentThreadId && <Button variant="link" size="xs" aria-label={`Open parent: ${parent ? title(parent) : "parent conversation"}`} onClick={() => openById(selected.parentThreadId!)}>Agent of {parent ? title(parent) : "its parent conversation"}</Button>}
            {selected.forkedFromId && <Button variant="link" size="xs" aria-label={`Open original: ${source ? title(source) : "original chat"}`} onClick={() => openById(selected.forkedFromId!)}>Continued from {source ? title(source) : "the original chat"}</Button>}
          </p>}
        </div>
        {view === "chat" && desktop && <Button className="header-action" variant="ghost" size="icon-sm" aria-pressed={side.open} aria-label={side.open ? "Hide side panel" : "Show side panel"} title={side.open ? "Hide side panel" : "Side panel: terminals and browser tabs"} onClick={() => side.open ? side.closePanel() : side.openPanel()}>{side.open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</Button>}
        {selected && view === "chat" && team.length > 0 && !panelShown && <Button className="header-action" variant="ghost" size="icon-sm" aria-label={agentsPanel ? "Hide agents panel" : "Show agents panel"} aria-pressed={agentsPanel} onClick={() => setAgentsPanel(value => !value)}><PanelRight size={16} /></Button>}
        {(split.pane || (split.thread && view === "chat")) && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Close split view" title="Close split view" onClick={split.close}><X size={16} /></Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Refresh conversation" disabled={loading} onClick={() => loadThread(selected)}><RefreshCw size={16} /></Button>}
      </header>
      <div className="workspace-notices">
      {deletedNotice && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1 truncate">{deletedNotice}</span><Button variant="outline" size="sm" title="Undo (Ctrl+Z)" onClick={() => void undoDelete()}>Undo</Button><Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setDeletedNotice(null)}><X size={15} /></Button></div>}
      {selected && rewindActions[selected.id] && <div className="error-banner notice" role="status"><span className="min-w-0 flex-1">Your files stay as they are.</span><Button variant="outline" size="sm" disabled={rewindBusy || !!activeTurn} onClick={() => void switchRewind({ action: rewindActions[selected.id]! }).catch(cause => setError(String(cause)))}>{rewindActions[selected.id] === "undo" ? "Undo rewind" : "Redo rewind"}</Button></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></Button></div>}
      {worktreeNotice && <div className="error-banner warning worktree-notice" role="status"><span>{worktreeNotice}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss worktree notice" onClick={() => setWorktreeNotice("")}><X size={15} /></Button></div>}
      {catalogError && <div className="error-banner" role="alert"><span className="min-w-0">Models unavailable: {catalogError} Sign in or check Models &amp; accounts, then retry.</span><Button className="shrink-0" variant="outline" size="sm" disabled={catalogLoading} onClick={() => void refreshModels()}>Retry models</Button></div>}
      {catalogLoading && !catalogError && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">Loading models…</p>}
      {selected && runtimeNotices[selected.id] && <div className="error-banner" role="alert"><span>{runtimeNotices[selected.id]}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss conversation error" onClick={() => setRuntimeNotices(prev => without(prev, selected.id))}><X size={15} /></Button></div>}
      {selected && (recoveredEdit || recoveryAttachments.length > 0) && <div className="error-banner"><details className="min-w-0 w-full"><summary>Recover unsent message</summary><pre className="whitespace-pre-wrap break-words py-2" dir="auto">{recoveredEdit}</pre>{recoveryAttachments.length > 0 && <p>Files: {recoveryAttachments.map(part => part.name).join(", ")}</p>}<div className="flex flex-wrap items-center gap-2">{recoveredEdit && <CopyButton label="Copy unsent message" text={() => recoveredEdit} />}<Button variant="outline" size="sm" disabled={!!text.trim() || attachments.length > 0} title={text.trim() || attachments.length ? "Keep or clear your current draft before restoring this message." : undefined} onClick={() => { saveDraft(`recovery-${selected.id}`, ""); saveAttachments(`recovery-${selected.id}`, []); editDraft(recoveredEdit); setAttachments(recoveryAttachments); saveAttachments(selected.id, recoveryAttachments); }}>Use in composer</Button>{(!!text.trim() || attachments.length > 0) && <span>Your current draft is kept. Save it, or clear it to restore the unsent message.</span>}</div></details></div>}
      {!connected && ready && <div className="error-banner" role="status">Reconnecting to Elpis… Your draft is saved.</div>}
      {outsideChatApprovals.length > 0 && pendingInputOpen && <section id="pending-input-panel" aria-label="Pending input" className="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") { setPendingInputOpen(false); pendingInputButton.current?.focus(); } }}>
        <div className="pending-panel-heading"><div><h2>Needs input</h2><p>{outsideChatApprovals.length} {outsideChatApprovals.length === 1 ? "request" : "requests"} waiting for you</p></div><Button variant="ghost" size="icon-sm" aria-label="Close pending input" onClick={() => { setPendingInputOpen(false); pendingInputButton.current?.focus(); }}><X size={16}/></Button></div>
        <div className="pending-request-list">{outsideChatApprovals.map(approval => {
          const thread = threads.find(item => item.id === approval.params.threadId);
          const requester = thread ?? approval.thread; const name = requester ? title(requester) : approval.params.threadId || "Conversation not reported";
          return <div key={approvalDraftKey(approval)} className="pending-request"><div className="pending-request-heading"><p>{name}</p>{approval.params.threadId && <Button variant="ghost" size="sm" onClick={() => { setPendingInputOpen(false); openById(approval.params.threadId!); }}>Open chat</Button>}</div><ApprovalCard approval={approval} globalKeys={false} answer={(id, body) => answer(id, body, approvalDraftKey(approval))} deny={(id, text) => answer(id, { text }, approvalDraftKey(approval), true)} busy={!!pendingDrafts[approvalDraftKey(approval)]} answers={approvalDrafts[approvalDraftKey(approval)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(approval, id, value)} /></div>;
        })}</div>
      </section>}
      </div>
      <div className={`workspace-body${panelShown ? " panel-open" : ""}${fullView ? ` full-view${side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${view !== "chat" ? " no-browser" : ""}`}><div className="workspace-content" {...(fullView ? { role: "region", "aria-label": "Floating chat" } : {})}>
      {fullView && <FloatChatBar title={chatName} onCollapse={() => side.setChatCollapsed(true)} />}
      {settingsVisited && <div className="page-scroll" hidden={view !== "settings"}><ViewBoundary label="Settings" resetKey={settingsNavigation}><SettingsView initialTab={settingsSection} navigationKey={settingsNavigation} active={view === "settings"} threadId={selected?.id} accountRefresh={accountRefresh} theme={theme} onTheme={setTheme} onUnarchived={unarchived} onDeleteThread={deleteThread} onBack={() => { show("chat"); requestAnimationFrame(focusComposer); }} onProvidersChanged={async () => { await reloadSettings(); void refreshModels(); }} /></ViewBoundary></div>}
      {view === "agentsGuide" && <div className="page-scroll"><AgentsGuide back={guideBack} onBack={() => show(guideBack === "Canvas" ? "canvas" : "agents")} /></div>}
      {view === "canvas" && <ViewBoundary label="Canvas"><CanvasGuideHelp onOpen={() => { setGuideBack("Canvas"); show("agentsGuide"); }}><AgentsCanvas models={models} cwd={newChatFolder(cwd) || undefined} dark={dark} onOpenChat={id => { show("chat"); void openById(id); }}
        projectMenu={<ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} />} /></CanvasGuideHelp></ViewBoundary>}
      {view === "loveSpot" && <LoveSpot dark={dark} />}
      {view === "customize" && <div className="page-scroll"><ViewBoundary label="Customize"><CustomizeView cwd={cwd} onOpenSettings={() => openSettings("mcp")}
        onConnectGithub={hasTerminal ? () => { show("chat"); setTuiLaunch({ key: side.openTerminal(cwd), command: "github-login", token: Date.now() }); } : undefined}
        onCreateSkill={() => { newChat(); requestAnimationFrame(() => editDraft("Use $skill-creator to create a new skill that ")); }} /></ViewBoundary></div>}
      {observabilityVisited && <div className="page-scroll" hidden={view !== "observability"}><ObservabilityView onOpenChat={id => void openById(id)} /></div>}
      {view === "agents" && <div className="page-scroll"><ViewBoundary label="Agents"><div className="mx-auto mb-3 max-w-[1080px]"><AgentsGuideLink onOpen={() => { setGuideBack("Agents"); show("agentsGuide"); }} /></div><AgentsView threads={threads} activity={activity} models={models} providers={providerSettings?.providers} loading={agentsLoading} pendingThreadIds={approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId)} moreConversations={!!nextCursor} loadingMore={moreLoading} onMoreConversations={loadMoreConversations} childCursors={childCursors} loadingChildren={loadingChildren} onMoreAgents={id => void loadChildren(id, childCursors[id] ?? undefined, false)} onOpen={loadThread} onStop={stop} onDelete={deleteThread} onNewAgent={() => show("newAgent")} /></ViewBoundary></div>}
      {newAgentVisited && <div className="page-scroll" hidden={view !== "newAgent"}><button type="button" className="back-link" onClick={() => show("agents")}><ArrowLeft size={18} aria-hidden="true" />Back to Agents</button><ViewBoundary label="New agent" resetKey={newAgentVersion}><NewAgentForm key={newAgentVersion} models={models} settings={providerSettings} defaultCwd={cwd} connected={connected} onConfigure={manageConnections} onCreated={(thread, turnId, unsent, failure) => { setNewAgentVersion(value => value + 1); upsertThread(thread); if (unsent) saveDraft(thread.id, unsent); if (turnId && !completedTurns.current.has(turnId)) setActiveTurns(prev => ({ ...prev, [thread.id]: turnId })); void loadThread(thread).then(() => { if (failure && selectedRef.current?.id === thread.id) setError(failure); }); }} /></ViewBoundary></div>}
      {view === "chat" && <div className="chat-split"><div className={`chat-view${!selected && !entries.length ? " empty-chat" : ""}`}>
        <div className="chat-scroll-wrap"><div className="chat-scroll" ref={scroll} onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}><div className="chat-content">
          {itemCursor && <Button variant="outline" disabled={loading} onClick={older}>Load earlier messages</Button>}
          {loading && !entries.length && <p role="status" className="chat-loading text-muted-foreground">Loading conversation…</p>}
          {!loading && !entries.length && !activeTurn && <div className="empty-state">{selected ? <><h2>This conversation has no messages yet.</h2><p>Messages and tool activity appear here.</p></> : <><img className="empty-mark" src={brandMark} alt="" aria-hidden="true" /><h2>{project ? <>What should we build in <ProjectMenu variant="heading" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} />?</> : "What should we build?"}</h2></>}</div>}
          <ViewBoundary label="The conversation" resetKey={selected?.id}><Transcript entries={entries} activeTurnId={activeTurn ?? null} onViewChanges={desktop && selected ? side.openChanges : undefined} mediaOf={e => selected ? mediaUrl(selected.id, e) : undefined} renderItem={e => { const editKey = JSON.stringify([selected?.id, e.turnId, e.item.id]); return <ChatMessage key={editKey} item={e.item} mediaBase={selected ? mediaUrl(selected.id, e) : undefined} threads={threads} speaker={selected?.agentNickname || "Elpis"} onOpenThread={openById}
            editDraft={messageEdits[editKey]} editPending={!!pendingDrafts[editKey]} onEditDraftChange={value => { setMessageEdits(previous => value === null ? without(previous, editKey) : { ...previous, [editKey]: value }); if (value === null) focusComposer(); }}
            onEdit={replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed ? text => replaceFrom(e.turnId, text, editKey) : undefined}
            editBlockedReason={replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed === false ? (replacementOptions.get(e.turnId) as { allowed: false; reason: string }).reason : undefined}
            time={e.item.type === "userMessage" ? e.startedAtMs : undefined}
            onFork={selected && e.item.type === "agentMessage" && e.turnId !== activeTurn ? () => void forkFrom(selected, e.turnId) : undefined} onRewind={replaceable ? () => setRewindTurn(e.turnId) : undefined}
            onRegenerate={regenerate && e.item.id === regenerate.replyId ? () => { replaceFrom(regenerate.turnId, regenerate.prompt).catch(error => setError(String(error instanceof Error ? error.message : error))); } : undefined} />; }} /></ViewBoundary>
          {failedTurn && <FailedTurnCard key={`${selected?.id}:${failedTurn.turnId}`} failure={failedTurn} models={selectedChoice?.models ?? models} currentModel={selected?.model} disabled={!replaceable}
            blockedReason={continues ? "Continue this conversation here before trying again." : failedInput?.allowed ? undefined : failedInput?.reason ?? "The original complete input is unavailable, so this turn cannot be safely resent."}
            onRetry={!continues && failedInput?.allowed ? retryModel => replaceFrom(failedTurn.turnId, failedInput.prompt, undefined, retryModel) : undefined} />}
          {selected && proposedPlan && <PlanCard mode={permissionMode} busy={busy || !connected} onImplement={permissions => answerPlan(selected, proposedPlan, { implement: true, permissions })} onKeepPlanning={feedback => answerPlan(selected, proposedPlan, { feedback })} />}
          {approvals.filter(a => a.params.threadId === selected?.id).map(a => <ApprovalCard key={approvalDraftKey(a)} approval={a} answer={(id, body) => answer(id, body, approvalDraftKey(a))} deny={(id, text) => answer(id, { text }, approvalDraftKey(a), true)} busy={!!pendingDrafts[approvalDraftKey(a)]} answers={approvalDrafts[approvalDraftKey(a)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(a, id, value)} />)}
        </div><PromptRail scroller={scroll} version={entries} /></div></div>
        <div className="composer-wrap">
          {sideChat && selected?.id === sideChat.parentId && <SideChat key={sideChat.parentId} parentId={sideChat.parentId} open={sideChat.open} question={sideChat.question} onClose={() => { setSideChat(previous => previous ? { ...previous, open: false } : null); focusComposer(); }} />}
          <ViewBoundary label="This panel" resetKey={panel}>
          {panel === "status" && <SessionPanel rows={sessionRows} threadId={selected?.id} onUsage={() => { setPanel(null); openSettings("usage"); }} onClose={closePanel} />}
          {panel === "review" && selected && <ReviewPanel threadId={selected.id} onStart={target => void startReview(selected, target)} onClose={closePanel} />}
          {panel === "diff" && selected && <DiffPanel threadId={selected.id} onClose={closePanel} />}
          </ViewBoundary>
          {slashNotice && <p role="status" className="mx-auto mb-2 w-full max-w-[740px] px-1 text-sm text-muted-foreground">{slashNotice}</p>}
          {selected && plans[selected.id] && <TaskList plan={plans[selected.id]} running={activeTurns[selected.id] === plans[selected.id].turnId} />}
          <QueuedFollowUps threadId={selected?.id} activeTurnId={activeTurn} onError={setError} onComplete={restoreComposerFocus} onEdit={editQueued} />
          {!selected && <div className="composer-tray"><EnvironmentMenu folder={chatFolder || null} disabled={!ready || busy} worktree={newWorktree} onWorktree={setNewWorktree} /><ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} /></div>}
          <form className="composer" onSubmit={e => { e.preventDefault(); send(); }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { const files = transferFiles(e.dataTransfer); if (files.length || e.dataTransfer.types.includes("Files")) { e.preventDefault(); void addFiles(files); } }}>
            {!shellMode && <><SlashMenu menu={slash} /><MentionMenu menu={mention} /></>}
            <input ref={filePickerRef} type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" aria-label="Choose files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addFiles(files); }} />
            <AttachmentChips attachments={attachments} disabled={busy || attaching} onRemove={id => { const next = attachmentsRef.current.filter(item => item.id !== id); setAttachments(next); saveAttachments(selectedRef.current?.id || newDraftKey.current, next); focusComposer(); }} />
            {attaching && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Reading files…</p>}
            {imageBlocked && <p role="alert" className="m-2 text-sm text-destructive">This model accepts text only. Choose an image-capable model or remove the images.</p>}
            {shellMode && <p role="status" className="bash-mode-notice"><span className="composer-pill">bash</span><span>Bash mode. Press Escape to return to chat.</span></p>}
            {!shellMode && promptKeys.status && <PromptStatusLine status={promptKeys.status} />}
            <Textarea ref={composerRef} aria-label="Message Elpis" {...(mention.open ? mention.inputProps : slash.inputProps)} onBlur={() => { slash.close(); mention.close(); promptKeys.cancel(); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} placeholder={shellMode ? "Run a shell command…" : continues ? `Message ${title(selected!)}…` : selected && activeTurn ? followUpHint(preferences) : selected ? "Ask for a follow-up" : "Ask Elpis to build, fix or explain something"} value={text} onChange={e => { const value = e.target.value; if (!shellMode && !textRef.current && value.startsWith("!") && !attachmentsRef.current.length) { setShellMode(true); promptKeys.cancel(); editDraft(value.slice(1)); setCaret(value.length - 1); } else { editDraft(value); setCaret(e.target.selectionStart); } }} onPaste={e => { const files = transferFiles(e.clipboardData); if (files.length) { if (!e.clipboardData.getData("text/plain")) e.preventDefault(); void addFiles(files); } }} disabled={!ready || !connected || projectChanging} onKeyDown={e => { if (shellMode) { if (e.key === "Escape" || (e.key === "Backspace" && !textRef.current)) { e.preventDefault(); e.stopPropagation(); setShellMode(false); promptKeys.cancel(); return; } if (isSendKey(e, preferences)) { e.preventDefault(); void sendShell(); } return; } if (mention.onKeyDown(e) || slash.onKeyDown(e) || promptKeys.onKeyDown(e)) return; if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); cycleMode(); return; } if (activeTurn && !continues) { const followUp = followUpKey(e, preferences); if (followUp) { e.preventDefault(); send(undefined, followUp); } } else if (isSendKey(e, preferences)) { e.preventDefault(); send(); } }} />
            {composerNotice && <div className="flex items-center gap-2 px-3 text-sm text-destructive" role="alert"><span className="whitespace-pre-line">{composerNotice}</span>{fileNotice && <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss file notice" onClick={() => setFileNotice("")}><X size={14} /></Button>}</div>}
            <div className="composer-controls"><div className="model-controls"><PlusMenu disabled={!ready || !connected || busy || projectChanging} attachDisabled={shellMode || attaching || attachments.length >= ATTACHMENT_LIMITS.count} slashDisabled={!!text} plan={planMode} returnFocus={composerRef}
                onAttach={pickFiles} onMention={() => { setShellMode(false); startMention(); }} onSlash={() => { setShellMode(false); startSlash(); }} onPlan={setPlan} onShell={() => { setShellMode(true); slash.close(); mention.close(); promptKeys.cancel(); focusComposer(); }} />
              {planMode && <PlanPill disabled={!ready || busy} onOff={() => setPlan(false)} />}
              <PermissionsMenu mode={permissionMode} disabled={permissionsLocked} onChange={choosePermissions} />
            </div><div className="composer-right">
              <ContextUsage threadId={selected?.id} />
              <ModelPicker choices={!selected ? choices : selectedChoice?.provider ? [selectedChoice] : choices.filter(choice => !choice.provider)} models={models}
                model={selected ? turnModel : model} choiceId={selected ? selectedChoice?.id || "" : choiceId} defaultModel={selected ? null : providerSettings?.main.model}
                disabled={!ready || busy || projectChanging} onConfigure={manageConnections} onKeySaved={() => void reloadSettings().catch(() => {})} onChange={choice => { if (selected) setOverride(selected.id, { model: choice.model }); else { setChoiceId(choice.choiceId); setModel(choice.model); setEffort(""); } }} />
              {turnEfforts.length > 0 && <OptionSelect aria-label="Reasoning effort" className="model-select" value={turnEffort} onChange={e => selected ? setOverride(selected.id, { effort: e.target.value }) : setEffort(e.target.value)} disabled={!ready || busy}>
                <option value=""><span className="effort-long">Default effort</span><span className="effort-short">Default</span></option>
                {turnEffort && !turnEfforts.includes(turnEffort) && <option value={turnEffort}>{turnEffort}</option>}
                {turnEfforts.map(value => <option key={value} value={value}>{value}</option>)}
              </OptionSelect>}
              {ready && <Dictation key={selected?.id || newDraftKey.current} provider={dictationProvider} disabled={!ready || !connected || busy || projectChanging} onBusy={setDictating}
                selection={() => ({ text: textRef.current, start: composerRef.current?.selectionStart ?? textRef.current.length, end: composerRef.current?.selectionEnd ?? textRef.current.length })}
                onTranscript={(selection, transcript) => {
                  const result = insertTranscript(textRef.current, selection, transcript); editDraft(result.text);
                  requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(result.caret, result.caret); });
                }} />}
              {activeTurn && <Button type="button" size="icon" variant="secondary" aria-label="Stop generation" onClick={() => selected && stop(selected)}><Square size={16} /></Button>}<Button type="submit" className="send-button" size={activeTurn && !continues ? "sm" : "icon"} aria-label={shellMode ? "Run shell command" : activeTurn && !continues ? "Send follow-up" : "Send message"} title={activeTurn && !continues ? followUpTooltip(preferences) : undefined} disabled={sendBlocked}>{activeTurn && !continues && !shellMode ? "Send follow-up" : <SendIcon size={18} />}</Button>{activeTurn && !continues && !shellMode && <SendOptionsMenu choice={followUpChoices(preferences)[1]} disabled={sendBlocked} returnFocus={composerRef} onChoose={follow => void send(undefined, follow)} />}</div></div>
          </form>
          <div className="composer-meta">
            {selected?.cwd && <span className="composer-chip" title={selected.cwd}><FolderIcon size={13} />{folder(selected.cwd)}</span>}
            {selected?.cwd && <BranchChip key={selected.id} threadId={selected.id} running={!!activeTurn} onNotice={setSlashNotice} />}
            <span className="composer-hint">{continues ? "Elpis takes direct messages for this agent only from its parent; sending continues its history in a new chat with the same model." : selectedLiveError ? `Not following live (${selectedLiveError}); the chat refreshes every few seconds.` : ""}</span>
            <ElpisFeatures threadId={selected?.id} />
          </div>
        </div>
      </div>
      {selected && teamRoot && team.length > 0 && agentsPanel && !panelShown && <aside className="team-panel" aria-label="Agents in this chat">
        <div className="team-heading"><span>Agents</span><small>{team.filter(thread => agentState(thread, waitingIds) === "working").length} working · {team.length} total</small></div>
        <button className={`team-row root${selected.id === teamRoot.id ? " active" : ""}`} onClick={() => openById(teamRoot.id)}><span className="team-state"><i /></span><span className="team-title">{title(teamRoot)}</span><small>Main chat</small></button>
        {team.map(thread => { const state = agentState(thread, waitingIds);
          return <button key={thread.id} className={`team-row ${state}${selected.id === thread.id ? " active" : ""}`} onClick={() => loadThread(thread)} title={activity[thread.id] || title(thread)}>
            <span className="team-state" aria-label={stateLabels[state]}><i /></span>
            <span className="team-title">{title(thread)}{thread.agentNickname && thread.agentNickname !== title(thread) && <em>{thread.agentNickname}</em>}</span>
            <small>{state === "working" && activity[thread.id] ? activity[thread.id] : [modelLabel(thread.model, models), thread.reasoningEffort].filter(Boolean).join(" · ")}</small>
          </button>; })}
      </aside>}
      </div>}
      </div>{fullView && side.chatCollapsed && <FloatChatPill title={chatName} state={floatState} onRestore={() => side.setChatCollapsed(false)} />}{desktop && <SidePanel panel={side} browser={browser} hasTerminal={hasTerminal} dark={dark} cwd={selected?.cwd || cwd} threadId={selected?.id} running={!!activeTurn} launch={tuiLaunch} covered={pendingInputOpen || sidebar || view !== "chat"} onAttach={attachFromBrowser} imagesAllowed={!(knownModel?.inputModalities && !knownModel.inputModalities.includes("image"))} />}</div>
      {split.thread && view === "chat" && <iframe key={split.thread.id} ref={split.frame} className="split-session" title="Split session" src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`} />}
    </main>
  </div>;
}
