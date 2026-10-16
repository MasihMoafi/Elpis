"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, PanelRight, Folder, GitBranch, Globe, Menu, Moon, Paperclip, Plus, RefreshCw, Search, Settings2, Square, SquarePen, Sun, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/chat-message";
import { CopyButton } from "@/components/markdown-text";
import { liveEventItemKey, mergeHistoryWithLive, mergeLiveItem, runtimeErrorNotice } from "@/lib/live-events";
import { replacementEligibility } from "@/lib/turn-replacement";
import { AgentsView } from "@/components/agents-view";
import { NewAgentForm } from "@/components/new-agent-form";
import { SettingsView } from "@/components/settings-view";
import { ThreadActions } from "@/components/thread-actions";
import { WorkflowEditor } from "@/components/workflow-editor";
import { UsagePanel } from "@/components/provider-usage";
import { Dictation } from "@/components/dictation";
import { ProjectPicker } from "@/components/project-picker";
import { ModelPicker } from "@/components/model-picker";
import { appStorage, readProjects, saveProjects, type Project } from "@/lib/projects";
import { agentState, mergeListedThreads } from "@/lib/agents";
import { insertTranscript } from "@/lib/dictation";
import { BrowserPanel } from "@/components/browser-panel";
import { readDraft, writeDraft } from "@/lib/drafts";
import { ATTACHMENT_ACCEPT, attachmentFromFile, readAttachmentDraft, validateAttachments, withoutSubmittedAttachments, writeAttachmentDraft, type Attachment } from "@/lib/attachments";
import { scanDeletionThreads } from "@/lib/thread-deletion";
import type { ThemeChoice } from "@/components/appearance-settings";
import { activityOf, api, choiceOf, effortsOf, isAgent, isUnlinkedAgent, modelLabel, providerChoices, providerLabel, title,
  type Approval, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";

const DECISION_LABELS: Record<string, string> = { accept: "Allow", acceptForSession: "Allow for this session", decline: "Decline", cancel: "Cancel" };
// Elpis offers "always allow" amendments as objects naming the command prefix or host they cover.
function decisionLabel(decision: unknown): string | null {
  if (typeof decision === "string") return DECISION_LABELS[decision] || null;
  if (!decision || typeof decision !== "object") return null;
  if ("acceptWithExecpolicyAmendment" in decision) return "Always allow this prefix";
  if ("applyNetworkPolicyAmendment" in decision) return "Always allow this host";
  return null;
}
function decisionScope(decision: unknown): string | null {
  if (!decision || typeof decision !== "object") return null;
  if ("acceptWithExecpolicyAmendment" in decision) {
    const value = (decision as {acceptWithExecpolicyAmendment: {execpolicy_amendment?: unknown}}).acceptWithExecpolicyAmendment.execpolicy_amendment;
    return Array.isArray(value) ? value.map(argument => JSON.stringify(argument)).join(" ") : JSON.stringify(value ?? decision);
  }
  if ("applyNetworkPolicyAmendment" in decision) return JSON.stringify((decision as {applyNetworkPolicyAmendment: unknown}).applyNetworkPolicyAmendment);
  return null;
}
type QuestionAnswers = Record<string, string[]>;
const approvalDraftKey = (approval: Approval) => JSON.stringify([approval.ownerThreadId, approval.id]);
function ApprovalCard({ approval, answer, answers, onAnswerChange, busy }: { approval: Approval; answer: (id: string, body: unknown) => Promise<void>; answers: QuestionAnswers; onAnswerChange: (id: string, value: string) => void; busy: boolean }) {
  const [error, setError] = useState("");
  async function submit(body: unknown) { if (busy) return; setError(""); try { await answer(approval.id, body); } catch (e) { setError(String(e)); } }
  const offered = (approval.params.availableDecisions ?? Object.keys(DECISION_LABELS)).filter(decision => decisionLabel(decision));
  const questions = approval.params.questions;
  return <section className="approval">
    <h3>{questions ? "Elpis needs your input" : "Approval requested"}</h3>
    {approval.params.reason && <p className="approval-reason">{approval.params.reason}</p>}
    {approval.params.command && <pre>{approval.params.command}</pre>}
    {offered.map((decision, index) => decisionScope(decision) && <div className="approval-scope" key={index}><p>{typeof decision === "object" && decision && "acceptWithExecpolicyAmendment" in decision ? "Command prefix scope (argv)" : "Host policy scope"}:</p><code>{decisionScope(decision)}</code></div>)}
    {questions?.map(q => <label key={q.id}>{q.question}
      {q.options ? <OptionSelect className="rounded-md border p-2" disabled={busy} value={answers[q.id]?.[0] || ""} onChange={e => onAnswerChange(q.id, e.target.value)}><option value="">Choose an answer</option>{q.options.map(o => <option key={o.label} value={o.label}>{o.label}{o.description ? ` — ${o.description}` : ""}</option>)}</OptionSelect> : null}
      <Input aria-label={`Answer: ${q.header || q.id}`} placeholder={q.options ? "Or write your own answer" : "Your answer"} type={q.isSecret ? "password" : "text"} disabled={busy} value={answers[q.id]?.[0] || ""} onChange={e => onAnswerChange(q.id, e.target.value)} />
    </label>)}
    {error && <p role="alert">{error}</p>}
    <div className="approval-actions">
      {questions
        ? <Button disabled={busy || questions.some(q => !answers[q.id]?.[0])} onClick={() => submit({ answers })}>Send answers</Button>
        : offered.map((decision, index) => <Button key={index} variant={decision === "accept" ? "default" : "outline"} className="h-auto min-h-8 max-w-full py-1.5 text-left whitespace-normal [overflow-wrap:anywhere]" disabled={busy} onClick={() => submit({ decision })}>{decisionLabel(decision)}</Button>)}
    </div>
  </section>;
}

type View = "chat" | "agents" | "newAgent" | "workflows" | "settings";
type NextTurn = { model?: string; effort?: string };
const without = <T,>(record: Record<string, T>, key: string) => { if (!(key in record)) return record; const next = { ...record }; delete next[key]; return next; };
const greeting = () => { const hour = new Date().getHours(); return hour < 5 ? "Working late?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"; };
// Sidebar sections by last activity, as in ChatGPT and Claude; the list keeps Elpis's own order inside each.
function recencyGroups(threads: Thread[]) {
  const day = 86400, midnight = new Date().setHours(0, 0, 0, 0) / 1000;
  const label = (seconds?: number) => !seconds ? "Earlier" : seconds >= midnight ? "Today" : seconds >= midnight - day ? "Yesterday" : seconds >= midnight - 7 * day ? "Previous 7 days" : seconds >= midnight - 30 * day ? "Previous 30 days" : "Earlier";
  const groups: { label: string; threads: Thread[] }[] = [];
  for (const thread of threads) { const name = label(thread.recencyAt ?? thread.updatedAt); const group = groups.find(item => item.label === name); if (group) group.threads.push(thread); else groups.push({ label: name, threads: [thread] }); }
  return groups;
}

export default function Home() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<Thread | null>(null);
  const selectedRef = useRef<Thread | null>(null);
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
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  // New conversations: where to run and with what.
  const [choiceId, setChoiceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectChanging, setProjectChanging] = useState(false);
  const project = projects.find(item => item.id === projectId) ?? null;
  // Existing conversations: overrides for their next turn only.
  const [nextTurn, setNextTurn] = useState<Record<string, NextTurn>>({});
  const [text, setTextState] = useState("");
  const textRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
  const draftAnswer = (approval: Approval, id: string, value: string) => {
    const key = approvalDraftKey(approval);
    setApprovalDrafts(previous => ({ ...previous, [key]: { id: approval.id, answers: { ...previous[key]?.answers, [id]: [value] } } }));
  };
  const newDraftKey = useRef("new");
  const [error, setError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready || !searchTerm) { setSearchResults({ query: "", data: [], nextCursor: null, loading: false, error: "" }); return; }
    let disposed = false;
    setSearchResults({ query: searchTerm, data: [], nextCursor: null, loading: true, error: "" });
    const timer = setTimeout(() => {
      api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(searchTerm)}`)
        .then(result => { if (!disposed) setSearchResults({ query: searchTerm, data: result.data, nextCursor: result.nextCursor, loading: false, error: "" }); })
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
    if (readingFiles.current) { setFileNotice("Wait for the current files to finish reading."); return; }
    const owner = selectedRef.current?.id || newDraftKey.current;
    readingFiles.current = true; setAttaching(true); setFileNotice("");
    try {
      if (savedAttachments(owner).length + files.length > 3) throw Error("Attach up to three files per message. Remove a file before adding more.");
      const added: Attachment[] = [];
      for (const file of files) added.push(await attachmentFromFile(file, body => api("/attachments/extract", body)));
      const next = validateAttachments([...savedAttachments(owner), ...added]); saveAttachments(owner, next);
      if ((selectedRef.current?.id || newDraftKey.current) === owner) setAttachments(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if ((selectedRef.current?.id || newDraftKey.current) === owner) setFileNotice(message);
      else setRuntimeNotices(previous => ({ ...previous, [owner]: message }));
    } finally { readingFiles.current = false; setAttaching(false); }
  }
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const rootPaging = useRef(false), loadedRootPages = useRef(false);
  const childPaging = useRef(new Set<string>()), loadedChildPages = useRef(new Set<string>());
  const [workflowVisited, setWorkflowVisited] = useState(false);
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [newAgentVisited, setNewAgentVisited] = useState(false);
  const [newAgentVersion, setNewAgentVersion] = useState(0);
  const [settingsNavigation, setSettingsNavigation] = useState(0);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  // A fast turn can finish over SSE before its HTTP start response arrives.
  const completedTurns = useRef(new Set<string>());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [liveError, setLiveError] = useState<Record<string, string>>({});
  const [runtimeNotices, setRuntimeNotices] = useState<Record<string, string>>({});
  const [related, setRelated] = useState<Record<string, Thread>>({});
  const [accountRefresh, setAccountRefresh] = useState(0);
  const [view, setView] = useState<View>("chat");
  const [settingsSection, setSettingsSection] = useState<"providers" | "elpis">("providers");
  const [desktop, setDesktop] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  useEffect(() => { setDesktop(!!window.elpisDesktop?.browser); }, []);
  const [pendingInputOpen, setPendingInputOpen] = useState(false);
  const pendingInputButton = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(false);
  const [agentsPanel, setAgentsPanel] = useState(true);
  // Theme: System follows the operating system; the choice is kept on this device.
  const [theme, setThemeChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const brandMark = "/branding/elpis-symbol-amber-loop.svg";
  const setTheme = (next: ThemeChoice) => { setThemeChoice(next); try { appStorage().setItem("elpis-theme", next); } catch { setError("Could not save appearance on this device."); } };
  const searchInput = useRef<HTMLInputElement>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [childCursors, setChildCursors] = useState<Record<string, string | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const request = useRef(0);
  const liveRevision = useRef(0), liveVersions = useRef(new Map<string, number>());
  const liveKeysAfter = useCallback((revision: number) => new Set([...liveVersions.current].filter(([, version]) => version > revision).map(([key]) => key)), []);

  const select = useCallback((thread: Thread | null) => { selectedRef.current = thread; setSelected(thread); try { window.elpisDesktop?.storage?.setItem("elpis-last-chat", thread?.id || ""); } catch { /* The in-memory selection remains usable. */ } }, []);
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
    for (const id of ids) hidden.current.add(id);
    if (permanent) {
      for (const id of ids) for (const key of [id, `recovery-${id}`]) { delete drafts.current[key]; writeDraft(key, ""); delete attachmentDrafts.current[key]; writeAttachmentDraft(key, []); }
      setMessageEdits(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !ids.has((JSON.parse(key) as [string, string, string])[0]))));
    }
    setThreads(prev => prev.filter(thread => !ids.has(thread.id)));
    setApprovals(prev => prev.filter(approval => !ids.has(approval.params.threadId ?? "")));
    if (selectedRef.current && ids.has(selectedRef.current.id)) { request.current++; select(null); setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setEntries([]); setItemCursor(null); }
  }, [select, setText, savedDraft, restoreAttachments]);
  const refreshThreads = useCallback(async () => {
    const routesAtRequest = { ...settingsOf.current };
    const result = await api<{ data: Thread[]; nextCursor: string | null }>("/threads?limit=100");
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
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&cursor=${encodeURIComponent(nextCursor)}`);
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
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?limit=100&searchTerm=${encodeURIComponent(query)}&cursor=${encodeURIComponent(searchResults.nextCursor)}`);
      setSearchResults(previous => previous.query === query ? { query, data: mergeListedThreads(previous.data, result.data, hidden.current), nextCursor: result.nextCursor, loading: false, error: "" } : previous);
    } catch (cause) { setSearchResults(previous => previous.query === query ? { ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) } : previous); }
  }

  const loadThread = useCallback(async (thread: Thread) => {
    saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); setText(savedDraft(thread.id));
    const id = ++request.current; stickToBottom.current = true; restoreScroll.current = null;
    liveVersions.current.clear(); const historyRevision = liveRevision.current;
    select(thread); setView("chat"); setSidebar(false); setEntries([]); setItemCursor(null); setLoading(true); setError(""); restoreAttachments(thread.id);
    try {
      const result = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`);
      if (request.current !== id) return;
      select(remember(result.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...result.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(result.nextCursor);
    } catch (e) { if (request.current === id) setError(String(e)); return; }
    finally { if (request.current === id) setLoading(false); }
    // Follow it live in this app: subscribe, and learn the turn it is running now.
    try {
      const live = await api<{ thread: Thread; activeTurnId?: string | null }>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
      if (request.current !== id || live.thread?.id !== thread.id) return;
      remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread);
      if (live.activeTurnId && !completedTurns.current.has(live.activeTurnId)) setActiveTurns(prev => ({ ...prev, [thread.id]: live.activeTurnId! }));
      setLiveError(prev => without(prev, thread.id));
    } catch (e) { if (request.current === id) setLiveError(prev => ({ ...prev, [thread.id]: e instanceof Error ? e.message : String(e) })); }
  }, [select, setText, upsertThread, saveDraft, savedDraft, liveKeysAfter, restoreAttachments]);

  useEffect(() => { setText(savedDraft(newDraftKey.current)); }, [savedDraft]);

  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = appStorage().getItem("elpis-theme"); const stored = readProjects(); newDraftKey.current = stored.selectedId ? `new-${stored.selectedId}` : "new"; setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setProjects(stored.projects); setProjectId(stored.selectedId); setCwd(stored.projects.find(item => item.id === stored.selectedId)?.cwd ?? ""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not restore workspace preferences."); }
    if (saved === "system" || saved === "light" || saved === "dark") setThemeChoice(saved);
    const media = matchMedia("(prefers-color-scheme: dark)"); setSystemDark(media.matches);
    const follow = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", follow); return () => media.removeEventListener("change", follow);
  }, []);
  useEffect(() => window.elpisDesktop?.storage?.onError(setError), []);
  // Ctrl+K (Cmd+K on macOS) searches chats, as in ChatGPT and Claude.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault(); setSidebar(true); searchInput.current?.focus(); searchInput.current?.select();
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
        const settings = await api<ProviderSettings>("/settings").catch(() => null);
        if (disposed || attempt !== recovery) return;
        setProviderSettings(settings?.main && Array.isArray(settings.providers) ? settings : null);
        if (!thread) return;
        const historyRevision = liveRevision.current;
        const history = await api<{ thread: Thread; data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(thread.id)}?limit=100`);
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        select(remember(history.thread)); setEntries(previous => mergeHistoryWithLive(previous, [...history.data].reverse(), liveKeysAfter(historyRevision))); setItemCursor(history.nextCursor);
        const live = await api<{ thread: Thread; activeTurnId?: string | null }>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
        if (disposed || attempt !== recovery || request.current !== requestId || selectedRef.current?.id !== thread.id) return;
        remember(live.thread); select({ ...selectedRef.current, ...live.thread }); upsertThread(live.thread);
        setActiveTurns(previous => live.activeTurnId && !completedTurns.current.has(live.activeTurnId) ? { ...previous, [thread.id]: live.activeTurnId } : without(previous, thread.id));
        setLiveError(previous => without(previous, thread.id));
      } catch (error) {
        if (!disposed && attempt === recovery && thread) setLiveError(previous => ({ ...previous, [thread.id]: error instanceof Error ? error.message : String(error) }));
      }
    }
    async function initialize() {
      try {
        const token = new URLSearchParams(location.hash.slice(1)).get("token");
        if (token) { await api("/session", { token }); history.replaceState(null, "", location.pathname + location.search); }
        const health = await api<{ connected: boolean }>("/health"); if (disposed) return; wasConnected = health.connected; setConnected(health.connected);
        void refreshModels();
        await refreshThreads();
        const settings = await api<ProviderSettings>("/settings").catch(() => null); if (disposed) return;
        setProviderSettings(settings?.main && Array.isArray(settings.providers) ? settings : null); setReady(true);
        const last = window.elpisDesktop?.storage?.getItem("elpis-last-chat");
        if (last && !selectedRef.current && request.current === 0) await loadThread({ id: last } as Thread);
        events = new EventSource("/api/events");
        events.addEventListener("connection", event => {
          const available = Boolean(JSON.parse(event.data).connected);
          if (!available) { disconnected(); return; }
          const recovered = !wasConnected; wasConnected = true; setConnected(true);
          if (recovered) void reconnect();
        });
        events.onerror = disconnected;
        events.addEventListener("message", event => {
          const { method, params } = JSON.parse(event.data);
          const threadId: string | undefined = params.threadId ?? params.thread?.id;
          if (method === "turn/started" && !completedTurns.current.has(params.turn.id)) { setActiveTurns(prev => ({ ...prev, [params.threadId]: params.turn.id })); setRuntimeNotices(prev => without(prev, params.threadId)); patchThread(params.threadId, { status: { type: "active" } }); }
          if (method === "turn/completed") {
            completedTurns.current.add(params.turn.id);
            setActiveTurns(prev => prev[params.threadId] !== params.turn.id ? prev : without(prev, params.threadId));
            refreshThreads().catch(e => setError(String(e)));
            if (params.turn?.error) setRuntimeNotices(prev => ({ ...prev, [params.threadId]: params.turn.error.message || "The turn failed." }));
            else setRuntimeNotices(prev => without(prev, params.threadId));
          }
          if (method === "error" && threadId) {
            const notice = runtimeErrorNotice(params);
            if (notice) setRuntimeNotices(prev => ({ ...prev, [threadId]: notice }));
          }
          if (method === "thread/status/changed" && params.status) patchThread(params.threadId, { status: params.status });
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
          if (method === "thread/deleted" || method === "thread/archived") removeThreads(new Set([params.threadId]), method === "thread/deleted");
          const line = threadId ? activityOf(method, params) : null;
          if (line && threadId) setActivity(prev => prev[threadId] === line ? prev : { ...prev, [threadId]: line });
          if (!threadId || threadId !== selectedRef.current?.id) return;
          const itemKey = liveEventItemKey(method, params);
          if (itemKey) liveVersions.current.set(itemKey, ++liveRevision.current);
          setEntries(prev => mergeLiveItem(prev, method, params, threadId));
        });
        events.addEventListener("approval", event => { const approval = JSON.parse(event.data); setApprovals(prev => [...prev.filter(a => a.id !== approval.id), approval]); });
        events.addEventListener("approvalResolved", event => { const { id } = JSON.parse(event.data); setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id); });
        events.addEventListener("unsupportedApproval", () => setError("Elpis requested an approval this app cannot answer. Use the original client to continue."));
        events.addEventListener("account", () => { setAccountRefresh(n => n + 1); void refreshModels(); });
      } catch (e) { if (!disposed) setError(String(e)); }
    }
    initialize(); return () => { disposed = true; catalogRequest.current++; events?.close(); };
  }, [refreshThreads, patchThread, upsertThread, removeThreads, select, liveKeysAfter, clearApprovalDraft, refreshModels]);

  const loadChildren = useCallback(async (id: string, cursor?: string, expand = true) => {
    if (childPaging.current.has(id)) return;
    childPaging.current.add(id); setLoadingChildren(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?ancestorThreadId=${encodeURIComponent(id)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
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
        const result = await api<{ thread: Thread; data: Entry[] }>(`/threads/${encodeURIComponent(id)}?limit=100`);
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

  const activeTurn = selected ? activeTurns[selected.id] : undefined;
  const outsideChatApprovals = approvals.filter(approval => view !== "chat" || approval.params.threadId !== selected?.id);
  const continues = selected?.desktopAccess?.mode === "continue";
  const choices = providerChoices(models, providerSettings);
  const newChoice = choices.find(choice => choice.id === choiceId) ?? choices[0];
  const needsModelId = !selected && !!newChoice?.provider;
  const selectedChoice = selected ? choiceOf(selected, choices) : null;
  const pending = selected ? nextTurn[selected.id] : undefined;
  const turnModel = selected ? pending?.model ?? selected.model ?? "" : model;
  const turnEfforts = effortsOf(turnModel || providerSettings?.main.model, models);
  const turnEffort = selected ? pending?.effort ?? selected.reasoningEffort ?? "" : effort;
  const knownModel = (selected ? selectedChoice?.models : newChoice?.models)?.find(item => item.model === (turnModel || providerSettings?.main.model));
  const imageBlocked = attachments.some(part => part.type === "image") && !!knownModel?.inputModalities && !knownModel.inputModalities.includes("image");
  const recoveryAttachments = selected ? attachmentDrafts.current[`recovery-${selected.id}`] ?? [] : [];

  const find = (id?: string | null) => id ? threads.find(thread => thread.id === id) ?? related[id] : undefined;
  // Elpis can replace turns only in chats it lets this app write directly, and not while one is running.
  const replaceable = !!selected && !continues && !activeTurn && selected.status?.type !== "active" && connected && !busy;
  const turnEntries = new Map<string, Entry[]>();
  for (const entry of entries) { const group = turnEntries.get(entry.turnId) ?? []; group.push(entry); turnEntries.set(entry.turnId, group); }
  const replacementOptions = new Map([...turnEntries].map(([id, group]) => [id, replacementEligibility(group, id, { historyComplete: !loading && itemCursor === null })]));
  const recoveredEdit = selected ? savedDraft(`recovery-${selected.id}`) : "";
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
  const newChat = () => openNewChat();
  async function selectProject(next: Project | null) {
    setProjectChanging(true);
    try {
      if (next && window.elpisDesktop?.resolveFolder) await window.elpisDesktop.resolveFolder(next.cwd);
      await saveProjects(projects, next?.id ?? null); setProjectId(next?.id ?? null); setCwd(next?.cwd ?? ""); openNewChat(next ? `new-${next.id}` : "new");
    } finally { setProjectChanging(false); }
  }
  async function saveProject(next: Project) {
    const updated = [...projects.filter(item => item.id !== next.id), next];
    await saveProjects(updated, next.id); setProjects(updated); setProjectId(next.id); setCwd(next.cwd); openNewChat(`new-${next.id}`);
  }
  const show = (next: View) => { if (next === "workflows") setWorkflowVisited(true); if (next === "settings") { setSettingsVisited(true); setSettingsNavigation(value => value + 1); } if (next === "newAgent") setNewAgentVisited(true); setView(next); setSidebar(false); };
  const manageConnections = () => { setSettingsSection("providers"); show("settings"); };
  function setOverride(id: string, patch: NextTurn) {
    const thread = selectedRef.current; if (!thread) return;
    setNextTurn(prev => {
      const merged = { ...prev[id], ...patch };
      if (merged.model === (thread.model ?? undefined)) delete merged.model;
      if (merged.effort === (thread.reasoningEffort ?? undefined) || merged.effort === "") delete merged.effort;
      return Object.keys(merged).length ? { ...prev, [id]: merged } : without(prev, id);
    });
  }
  async function send() {
    if ((!textRef.current.trim() && !attachmentsRef.current.length) || busy || dictating || attaching || projectChanging || !connected) return;
    if (imageBlocked) { setFileNotice("This model accepts text only. Choose an image-capable model or remove the images."); return; }
    if (needsModelId && !model.trim()) { setError("Enter a model ID for the selected provider."); return; }
    setBusy(true); setError("");
    const sentText = textRef.current, sentAttachments = [...attachmentsRef.current];
    const originalId = selected?.id || newDraftKey.current, originalRequest = request.current;
    const attached = sentAttachments.length ? { attachments: sentAttachments } : {};
    let errorThreadId = selected?.id;
    try {
      let thread = selected;
      if (!thread) {
        const result = await api<{ thread: Thread }>("/threads", { ...(model.trim() ? { model: model.trim() } : {}), ...(newChoice?.provider ? { provider: newChoice.provider } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) });
        thread = result.thread; errorThreadId = thread.id;
        saveDraft(thread.id, originalRequest === request.current ? textRef.current : sentText);
        saveAttachments(thread.id, originalRequest === request.current ? attachmentsRef.current : sentAttachments);
        if (originalRequest === request.current) { saveDraft(originalId, ""); saveAttachments(originalId, []); select(thread); }
        setThreads(prev => [thread!, ...prev]);
      }
      const used = selected ? pending : effort ? { effort } : undefined;
      if (activeTurn && !continues) {
        await api(`/threads/${encodeURIComponent(thread.id)}/steer`, { text: sentText, expectedTurnId: activeTurn, ...attached });
      } else {
        const result = await api<{ turn?: { id: string }; thread?: Thread; continuedFrom?: string; sendError?: string }>(`/threads/${encodeURIComponent(thread.id)}/turns`, { text: sentText, ...attached, ...(used?.model ? { model: used.model } : {}), ...(used?.effort ? { effort: used.effort } : {}), ...(continues ? { continueAs: `${title(thread)} (continued)` } : {}) });
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
      if (errorThreadId) setRuntimeNotices(previous => ({ ...previous, [errorThreadId!]: e instanceof Error ? e.message : String(e) }));
      else if (originalRequest === request.current) setError(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  }
  async function stop(thread: Thread) {
    try { await api(`/threads/${encodeURIComponent(thread.id)}/interrupt`, activeTurns[thread.id] ? { turnId: activeTurns[thread.id] } : {}); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function deleteThread(thread: Thread) {
    const ids = new Set([thread.id]);
    const descendants = await scanDeletionThreads<Thread>(({ archived, limit, cursor }) => api(`/threads?ancestorThreadId=${encodeURIComponent(thread.id)}&archived=${archived}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    for (const child of descendants) ids.add(child.id);
    const result = await api<{ alsoDeleted: string[] }>(`/threads/${encodeURIComponent(thread.id)}/delete`, {});
    for (const id of result.alsoDeleted) ids.add(id);
    removeThreads(ids, true);
  }
  async function renameThread(thread: Thread, name: string) {
    const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/rename`, { name });
    patchThread(thread.id, { name: result.thread.name ?? name });
  }
  // Elpis archives the chat with the agents it spawned; hide every loaded one.
  async function archiveThread(thread: Thread) {
    try { await api(`/threads/${encodeURIComponent(thread.id)}/archive`, {}); removeThreads(new Set([thread.id]), false); }
    catch (e) { setError(`Could not archive “${title(thread)}”: ${e instanceof Error ? e.message : String(e)}`); }
  }
  function unarchived(thread: Thread) { hidden.current.delete(thread.id); upsertThread(thread); refreshThreads().catch(e => setError(String(e))); }
  /** Edit-and-resend and regenerate: Elpis replaces the turn and every later one, then runs the new text. */
  async function replaceFrom(turnId: string, replacement: string, editKey?: string) {
    const thread = selectedRef.current; if (!thread) return;
    if (savedDraft(`recovery-${thread.id}`) || savedAttachments(`recovery-${thread.id}`).length) throw new Error("Recover the saved edited message before replacing another turn.");
    const eligibility = replacementOptions.get(turnId);
    if (!eligibility?.allowed) throw new Error(eligibility && !eligibility.allowed ? eligibility.reason : "The complete input for this turn is unavailable.");
    const index = entries.findIndex(entry => entry.turnId === turnId);
    const stale = new Set(entries.slice(Math.max(index, 0)).map(entry => entry.turnId));
    const overrides = nextTurn[thread.id];
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
  }
  async function createWorkflowTarget(options: { cwd?: string; model?: string; provider?: string }) {
    const requestId = request.current; saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current);
    const result = await api<{ thread: Thread }>("/threads", options);
    setThreads(previous => [result.thread, ...previous.filter(thread => thread.id !== result.thread.id)]);
    if (request.current === requestId) { ++request.current; stickToBottom.current = true; restoreScroll.current = null; select(result.thread); setEntries([]); setItemCursor(null); setText(savedDraft(result.thread.id)); setLoading(false); setError(""); restoreAttachments(result.thread.id); }
    return result.thread;
  }
  async function resumeWorkflowTarget() {
    const thread = selectedRef.current; if (!thread || isAgent(thread)) throw new Error("Select a root conversation.");
    const result = await api<{ thread: Thread; activeTurnId?: string | null }>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
    upsertThread(result.thread); if (selectedRef.current?.id === thread.id) select(result.thread);
    if (result.activeTurnId && !completedTurns.current.has(result.activeTurnId)) setActiveTurns(previous => ({ ...previous, [thread.id]: result.activeTurnId! }));
  }
  function workflowStarted(ack: { threadId: string; turnId: string }) {
    if (!completedTurns.current.has(ack.turnId)) setActiveTurns(previous => ({ ...previous, [ack.threadId]: ack.turnId }));
    void refreshThreads();
  }
  async function answer(id: string, body: unknown, key: string) { await submitDraft(key, () => api(`/approvals/${encodeURIComponent(id)}`, body)); setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id); }
  async function older() { if (!selected || !itemCursor) return; setLoading(true); const id = selected.id; try { const result = await api<{ data: Entry[]; nextCursor: string | null }>(`/threads/${encodeURIComponent(id)}?limit=100&cursor=${encodeURIComponent(itemCursor)}`); if (selectedRef.current?.id === id) { stickToBottom.current = false; if (scroll.current) restoreScroll.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }; setEntries(prev => [...result.data.reverse(), ...prev]); setItemCursor(result.nextCursor); } } catch (e) { setError(String(e)); } finally { setLoading(false); } }
  const openById = (id: string) => loadThread(threads.find(thread => thread.id === id) || related[id] || { id });

  const inProject = (thread: Thread) => { const seen = new Set<string>(); let root = thread; while (root.parentThreadId && !seen.has(root.id)) { seen.add(root.id); const parent = searchedThreads.find(item => item.id === root.parentThreadId); if (!parent) break; root = parent; } return !project || root.cwd?.replace(/\/+$/, "") === project.cwd.replace(/\/+$/, ""); };
  const searchedThreads = searchTerm && searchResults.query === searchTerm ? mergeListedThreads(threads, searchResults.data, hidden.current) : threads;
  const matchedOnServer = new Set(searchTerm && searchResults.query === searchTerm ? searchResults.data.map(thread => thread.id) : []);
  const filtered = searchedThreads.filter(t => inProject(t) && (matchedOnServer.has(t.id) || `${title(t)} ${t.agentNickname || ""} ${t.model || ""} ${t.id}`.toLowerCase().includes(searchTerm.toLowerCase())));
  const roots = filtered.filter(t => !isUnlinkedAgent(t, searchedThreads) && (!t.parentThreadId || !filtered.some(p => p.id === t.parentThreadId)));
  const unlinked = filtered.filter(t => isUnlinkedAgent(t, searchedThreads));
  function threadRow(thread: Thread, depth = 0) {
    const name = title(thread), state = agentState(thread, waitingIds);
    const stateTitle = state === "waiting" ? "Needs input" : "Working";
    return <div key={thread.id} className={`thread-row${depth ? " child" : ""}${selected?.id === thread.id && view === "chat" ? " active" : ""}`} data-thread-id={thread.id} style={depth ? { paddingLeft: `${Math.min(depth, 5) * 14}px` } : undefined}>
      <button className="thread-link" onClick={() => loadThread(thread)} title={name}>
        <span className="thread-title">{name}</span>
        {thread.forkedFromId && <span className="thread-nickname">Continued agent chat</span>}
      </button>
      {(state === "working" || state === "waiting") && <span className={`thread-working${state === "waiting" ? " waiting" : ""}`} title={stateTitle} aria-label={stateTitle} />}
      {!depth && !isAgent(thread) && <Button variant="ghost" size="icon-xs" aria-label={`Show agents of ${name}`} aria-expanded={!!expanded[thread.id]} onClick={() => expanded[thread.id] ? setExpanded(prev => ({ ...prev, [thread.id]: false })) : loadChildren(thread.id)}><GitBranch size={13} /></Button>}
      <ThreadActions thread={thread} onDelete={deleteThread} onRename={renameThread} onArchive={archiveThread} />
    </div>;
  }
  function descendants(parentId: string, depth: number, seen = new Set<string>()): React.ReactNode {
    if (seen.has(parentId)) return null; const next = new Set(seen).add(parentId);
    return filtered.filter(c => c.parentThreadId === parentId).map(child => <div key={child.id}>{threadRow(child, depth)}{descendants(child.id, depth + 1, next)}</div>);
  }
  const heading = view === "chat" ? (selected ? title(selected) : "") : { agents: "Agents", newAgent: "New agent", workflows: "Workflows", settings: "Settings" }[view];
  const meta = selected ? [selected.agentNickname, selected.agentRole && selected.agentRole !== "default" ? selected.agentRole : null, providerLabel(selected.model, selected.modelProvider, providerSettings?.providers), modelLabel(selected.model, models), selected.reasoningEffort].filter(Boolean).join(" · ") : "";

  return <div className={`app-shell${dark ? " dark" : ""}`}>
    <aside className={`sidebar${sidebar ? " open" : ""}`} aria-label="Workspace navigation">
      <div className="brand"><img src={brandMark} alt="Elpis" width={28} height={28} /><span>Elpis</span><Button className="ml-auto mobile-menu" variant="ghost" size="icon-sm" aria-label="Close sidebar" onClick={() => setSidebar(false)}><X size={16} /></Button></div>
      <nav className="nav-list" aria-label="Workspace">
        <Button className="new-chat" variant="ghost" aria-current={view === "chat" && !selected ? "page" : undefined} disabled={projectChanging} onClick={newChat}><SquarePen size={16} />New chat</Button>
        <Button variant="ghost" aria-current={view === "agents" ? "page" : undefined} onClick={() => show("agents")}><GitBranch size={16} />Agents{working > 0 && <span className="nav-badge" aria-hidden="true"><i />{working}</span>}</Button>
        <Button variant="ghost" aria-current={view === "workflows" ? "page" : undefined} onClick={() => show("workflows")}><Workflow size={16} />Workflows</Button>
      </nav>
      <label className="sidebar-search"><Search size={14} aria-hidden="true" /><Input ref={searchInput} aria-label="Search conversations" placeholder="Search conversations" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} /><kbd aria-hidden="true">Ctrl K</kbd></label>
      <ProjectPicker projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onSave={saveProject} />
      <div className="thread-list">
        {recencyGroups(roots).map(group => <section key={group.label} aria-label={group.label}><div className="section-label">{group.label}</div>
          {group.threads.map(t => <div key={t.id}>{threadRow(t)}{expanded[t.id] && descendants(t.id, 1)}{expanded[t.id] && childCursors[t.id] && <Button variant="ghost" size="xs" onClick={() => loadChildren(t.id, childCursors[t.id]!)}>More agents</Button>}</div>)}
        </section>)}
        {unlinked.length > 0 && <div className="unlinked-thread-list" aria-label="Agents whose parent is not listed"><div className="section-label mt-4" title="Their parent conversation is not in the current list.">Other agents</div>{unlinked.map(thread => threadRow(thread))}</div>}
        {ready && !threads.length && <p className="px-2 text-xs text-muted-foreground">Your conversations will appear here.</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.loading && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Searching saved conversations…</p>}
        {searchTerm && searchResults.query === searchTerm && searchResults.error && <p role="alert" className="px-2 py-3 text-xs text-destructive">Could not search saved conversations: {searchResults.error}</p>}
        {searchTerm && searchResults.query === searchTerm && !searchResults.loading && !searchResults.error && !filtered.length && <p className="px-2 py-3 text-xs text-muted-foreground">No matching conversations{project ? " in this project" : ""}.</p>}
        {!searchTerm && ready && project && threads.length > 0 && !roots.length && <p className="px-2 text-xs text-muted-foreground">No conversations in this project yet.</p>}
        {searchTerm ? searchResults.nextCursor && <Button variant="ghost" className="w-full" disabled={searchResults.loading} onClick={() => void loadMoreSearch()}>More search results</Button> : nextCursor && <Button variant="ghost" className="w-full" disabled={moreLoading} onClick={() => void loadMoreConversations()}>Load more</Button>}
      </div>
      <UsagePanel refreshKey={accountRefresh} />
      <div className="sidebar-footer"><nav className="nav-list flex-1" aria-label="Settings"><Button variant="ghost" aria-current={view === "settings" ? "page" : undefined} onClick={() => { setSettingsSection("providers"); show("settings"); }}><Settings2 size={16} />Settings</Button></nav><Button size="icon-sm" variant="ghost" aria-label={dark ? "Use light theme" : "Use dark theme"} onClick={() => setTheme(dark ? "light" : "dark")}>{dark ? <Sun size={15} /> : <Moon size={15} />}</Button></div>
      <span className="status-line"><i className={`status-dot${connected ? " connected" : ""}`} />{connected ? "Local workspace" : "Disconnected"}</span>
    </aside>
    <main className="workspace">
      <header className={`workspace-header${view === "workflows" && !outsideChatApprovals.length && !desktop ? " desktop-hidden" : ""}${heading ? "" : " untitled"}`}>
        {outsideChatApprovals.length > 0 && <div className="pending-input-anchor"><Button ref={pendingInputButton} className="pending-input-trigger" variant="secondary" size="sm" aria-label={`Needs input (${outsideChatApprovals.length})`} aria-expanded={pendingInputOpen} aria-controls="pending-input-panel" onKeyDown={event => { if (event.key === "Escape") setPendingInputOpen(false); }} onClick={() => setPendingInputOpen(value => !value)}><span className="pending-count">{outsideChatApprovals.length}</span>Needs input<span className="pending-task-name">{title(threads.find(thread => thread.id === outsideChatApprovals[0].params.threadId) || outsideChatApprovals[0].thread || {id:outsideChatApprovals[0].params.threadId || "unreported"})}</span></Button></div>}
        <Button className="mobile-menu" variant="ghost" size="icon-sm" aria-label="Open sidebar" onClick={() => setSidebar(true)}><Menu size={18} /></Button>
        <img className="mobile-brand" src={brandMark} alt="" aria-hidden="true" width={24} height={24} />
        <div className="header-titles min-w-0 flex-1">
          <h1>{heading}</h1>
          {view === "agents" && <p className="page-description">Your conversations and agents. Open a chat or follow a running task.</p>}
          {view === "chat" && selected && <p className="thread-meta">{meta}</p>}
          {view === "chat" && selected && (selected.parentThreadId || selected.forkedFromId) && <p className="thread-links">
            {selected.parentThreadId && <Button variant="link" size="xs" aria-label={`Open parent: ${parent ? title(parent) : "parent conversation"}`} onClick={() => openById(selected.parentThreadId!)}>Agent of {parent ? title(parent) : "its parent conversation"}</Button>}
            {selected.forkedFromId && <Button variant="link" size="xs" aria-label={`Open original: ${source ? title(source) : "original chat"}`} onClick={() => openById(selected.forkedFromId!)}>Continued from {source ? title(source) : "the original chat"}</Button>}
          </p>}
          {view === "chat" && pending && <p className="next-turn">Next turn: {[pending.model && modelLabel(pending.model, models), pending.effort && `${pending.effort} reasoning`].filter(Boolean).join(" · ")}</p>}
        </div>
        {activeTurn && view === "chat" && <span className="header-action text-xs text-muted-foreground">Working…</span>}
        {desktop && <Button className="header-action" variant="ghost" size="sm" aria-label={browserOpen ? "Hide browser" : "Open browser"} aria-pressed={browserOpen} onClick={() => { void window.elpisDesktop?.browser.command("toggle").catch(error => setError(error.message)); }}><Globe size={15}/>Browser</Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="sm" onClick={() => { setSettingsSection("elpis"); show("settings"); }}>Context</Button>}
        {selected && view === "chat" && team.length > 0 && !browserOpen && <Button className="header-action" variant="ghost" size="icon-sm" aria-label={agentsPanel ? "Hide agents panel" : "Show agents panel"} aria-pressed={agentsPanel} onClick={() => setAgentsPanel(value => !value)}><PanelRight size={16} /></Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Refresh conversation" disabled={loading} onClick={() => loadThread(selected)}><RefreshCw size={16} /></Button>}
      </header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></Button></div>}
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
          return <div key={approvalDraftKey(approval)} className="pending-request"><div className="pending-request-heading"><p>{name}</p>{approval.params.threadId && <Button variant="ghost" size="sm" onClick={() => { setPendingInputOpen(false); openById(approval.params.threadId!); }}>Open chat</Button>}</div><ApprovalCard approval={approval} answer={(id, body) => answer(id, body, approvalDraftKey(approval))} busy={!!pendingDrafts[approvalDraftKey(approval)]} answers={approvalDrafts[approvalDraftKey(approval)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(approval, id, value)} /></div>;
        })}</div>
      </section>}
      <div className={`workspace-body${browserOpen ? " browser-open" : ""}`}><div className="workspace-content">
      {workflowVisited && <div className="page-scroll workflow-page" hidden={view !== "workflows"}><WorkflowEditor runtime={{ visible: view === "workflows", connected, target: selected, targetIsChild: !!selected && isAgent(selected), activeTurnId: activeTurn, models, providerSettings, onConfigure: manageConnections, defaultCwd: selected?.cwd || cwd, defaultModel: selected?.model || model, defaultProvider: selected?.modelProvider || newChoice?.provider || "", onCreateTarget: createWorkflowTarget, onResumeTarget: resumeWorkflowTarget, onStarted: workflowStarted, onStop: async ack => { await api(`/threads/${encodeURIComponent(ack.threadId)}/interrupt`, { turnId: ack.turnId }); }, onOpenThread: openById }} /></div>}
      {settingsVisited && <div className="page-scroll" hidden={view !== "settings"}><SettingsView initialTab={settingsSection} navigationKey={settingsNavigation} active={view === "settings"} threadId={selected?.id} accountRefresh={accountRefresh} theme={theme} onTheme={setTheme} onUnarchived={unarchived} onDeleteThread={deleteThread} onProvidersChanged={async () => { const settings = await api<ProviderSettings>("/settings"); setProviderSettings(settings); void refreshModels(); }} /></div>}
      {view === "agents" && <div className="page-scroll"><AgentsView threads={threads} activity={activity} models={models} providers={providerSettings?.providers} loading={agentsLoading} pendingThreadIds={approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId)} moreConversations={!!nextCursor} loadingMore={moreLoading} onMoreConversations={loadMoreConversations} childCursors={childCursors} loadingChildren={loadingChildren} onMoreAgents={id => void loadChildren(id, childCursors[id] ?? undefined, false)} onOpen={loadThread} onStop={stop} onDelete={deleteThread} onNewAgent={() => show("newAgent")} /></div>}
      {newAgentVisited && <div className="page-scroll" hidden={view !== "newAgent"}><Button variant="ghost" size="sm" onClick={() => show("agents")}>Back to Agents</Button><NewAgentForm key={newAgentVersion} models={models} settings={providerSettings} defaultCwd={cwd} connected={connected} onConfigure={manageConnections} onCreated={(thread, turnId, unsent, failure) => { setNewAgentVersion(value => value + 1); upsertThread(thread); if (unsent) saveDraft(thread.id, unsent); if (turnId && !completedTurns.current.has(turnId)) setActiveTurns(prev => ({ ...prev, [thread.id]: turnId })); void loadThread(thread).then(() => { if (failure && selectedRef.current?.id === thread.id) setError(failure); }); }} /></div>}
      {view === "chat" && <div className="chat-split"><div className={`chat-view${!selected && !entries.length ? " empty-chat" : ""}`}>
        <div className="chat-scroll" ref={scroll} onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}><div className="chat-content">
          {itemCursor && <Button variant="outline" disabled={loading} onClick={older}>Load earlier messages</Button>}
          {loading && <p role="status" className="text-muted-foreground">Loading conversation…</p>}
          {!loading && !entries.length && <div className="empty-state">{selected ? <><h2>This conversation has no messages yet.</h2><p>Messages and tool activity appear here.</p></> : <><img className="empty-mark" src={brandMark} alt="" aria-hidden="true" /><h2>{greeting()}</h2><p>What should Elpis work on?</p></>}</div>}
          {entries.map(e => { const editKey = JSON.stringify([selected?.id, e.turnId, e.item.id]); return <ChatMessage key={editKey} item={e.item} mediaBase={selected ? `/api/threads/${encodeURIComponent(selected.id)}/turns/${encodeURIComponent(e.turnId)}/items/${encodeURIComponent(e.item.id)}/media` : undefined} threads={threads} speaker={selected?.agentNickname || "Elpis"} onOpenThread={openById}
            editDraft={messageEdits[editKey]} editPending={!!pendingDrafts[editKey]} onEditDraftChange={value => setMessageEdits(previous => value === null ? without(previous, editKey) : { ...previous, [editKey]: value })}
            onEdit={replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed ? text => replaceFrom(e.turnId, text, editKey) : undefined}
            editBlockedReason={replaceable && e.item.type === "userMessage" && replacementOptions.get(e.turnId)?.allowed === false ? (replacementOptions.get(e.turnId) as { allowed: false; reason: string }).reason : undefined}
            onRegenerate={regenerate && e.item.id === regenerate.replyId ? () => { replaceFrom(regenerate.turnId, regenerate.prompt).catch(error => setError(String(error instanceof Error ? error.message : error))); } : undefined} />; })}
          {approvals.filter(a => a.params.threadId === selected?.id).map(a => <ApprovalCard key={approvalDraftKey(a)} approval={a} answer={(id, body) => answer(id, body, approvalDraftKey(a))} busy={!!pendingDrafts[approvalDraftKey(a)]} answers={approvalDrafts[approvalDraftKey(a)]?.answers ?? {}} onAnswerChange={(id, value) => draftAnswer(a, id, value)} />)}
        </div></div>
        <div className="composer-wrap">
          <form className="composer" onSubmit={e => { e.preventDefault(); send(); }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length || e.dataTransfer.types.includes("Files")) { e.preventDefault(); void addFiles(Array.from(e.dataTransfer.files)); } }}>
            <input ref={filePickerRef} type="file" multiple accept={ATTACHMENT_ACCEPT} className="hidden" aria-label="Choose files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addFiles(files); }} />
            {attachments.length > 0 && <ul aria-label="Message attachments" className="flex flex-wrap gap-2 p-2">{attachments.map(part => <li key={part.id} className="flex max-w-full items-start gap-2 rounded-md border p-2 text-sm">
              {part.type === "image" ? <img src={part.dataUrl} alt={part.name} className="h-16 w-16 rounded object-contain" /> : <span aria-hidden="true">📄</span>}
              <span className="max-w-48 break-words">{part.name}<small className="block text-muted-foreground">{part.type === "image" ? "Image" : "Text snapshot"}</small></span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${part.name}`} disabled={busy || attaching} onClick={() => { const next = attachmentsRef.current.filter(item => item.id !== part.id); setAttachments(next); saveAttachments(selectedRef.current?.id || newDraftKey.current, next); }}><X className="size-3" /></Button>
            </li>)}</ul>}
            {attaching && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">Reading files…</p>}
            {imageBlocked && <p role="alert" className="m-2 text-sm text-destructive">This model accepts text only. Choose an image-capable model or remove the images.</p>}
            <Textarea ref={composerRef} aria-label="Message Elpis" placeholder={continues ? `Message ${title(selected!)}…` : selected ? "Ask for a follow-up" : "Ask Elpis to build, fix or explain something"} value={text} onChange={e => editDraft(e.target.value)} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { if (!e.clipboardData.getData("text/plain")) e.preventDefault(); void addFiles(files); } }} disabled={!ready || !connected || projectChanging} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            {fileNotice && <div className="flex items-center gap-2 px-3 text-sm text-destructive" role="alert"><span>{fileNotice}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss file notice" onClick={() => setFileNotice("")}><X size={14} /></Button></div>}
            <div className="composer-controls"><div className="model-controls"><Button type="button" variant="ghost" size="icon-sm" aria-label="Attach files" title="Attach images, PDF, or text files" disabled={!ready || !connected || busy || attaching || projectChanging || attachments.length >= 3} onClick={() => filePickerRef.current?.click()}><Paperclip className="size-4" /></Button>
              <ModelPicker choices={!selected ? choices : selectedChoice?.provider ? [selectedChoice] : choices.filter(choice => !choice.provider)} models={models}
                model={selected ? turnModel : model} choiceId={selected ? selectedChoice?.id || "" : choiceId} defaultModel={selected ? null : providerSettings?.main.model}
                disabled={!ready || busy || projectChanging} onConfigure={manageConnections} onChange={choice => { if (selected) setOverride(selected.id, { model: choice.model }); else { setChoiceId(choice.choiceId); setModel(choice.model); setEffort(""); } }} />
              {turnEfforts.length > 0 && <OptionSelect aria-label="Reasoning effort" className="model-select" value={turnEffort} onChange={e => selected ? setOverride(selected.id, { effort: e.target.value }) : setEffort(e.target.value)} disabled={!ready || busy}>
                <option value="">Default effort</option>
                {turnEffort && !turnEfforts.includes(turnEffort) && <option value={turnEffort}>{turnEffort}</option>}
                {turnEfforts.map(value => <option key={value} value={value}>{value}</option>)}
              </OptionSelect>}
            </div><div className="flex items-center gap-2">{activeTurn && <Button type="button" size="icon" variant="secondary" aria-label="Stop generation" onClick={() => selected && stop(selected)}><Square size={16} /></Button>}<Button type="submit" className="send-button" size={activeTurn && !continues ? "sm" : "icon"} aria-label={activeTurn && !continues ? "Send follow-up" : "Send message"} disabled={(!text.trim() && !attachments.length) || busy || dictating || attaching || imageBlocked || !ready || !connected || (needsModelId && !model.trim())}>{activeTurn && !continues ? "Send follow-up" : <ArrowUp size={18} />}</Button></div></div>
            {ready && <Dictation key={selected?.id || newDraftKey.current} disabled={!ready || !connected || busy || projectChanging} onBusy={setDictating}
              selection={() => ({ text: textRef.current, start: composerRef.current?.selectionStart ?? textRef.current.length, end: composerRef.current?.selectionEnd ?? textRef.current.length })}
              onTranscript={(selection, transcript) => {
                const result = insertTranscript(textRef.current, selection, transcript); editDraft(result.text);
                requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(result.caret, result.caret); });
              }} />}
          </form>
          <div className="composer-meta">
            {!selected && <span className="composer-chip" title={cwd || "Use the folder configured in Elpis"}><Folder size={13} />{project?.name || "Default workspace"}</span>}
            {selected?.cwd && <span className="composer-chip" title={selected.cwd}><Folder size={13} />{folder(selected.cwd)}</span>}
            {selected && <span className="composer-chip" title={providerLabel(selected.model, selected.modelProvider, providerSettings?.providers)}>{providerLabel(selected.model, selected.modelProvider, providerSettings?.providers)}</span>}
            <span className="composer-hint">{continues ? "Elpis takes direct messages for this agent only from its parent; sending continues its history in a new chat with the same model." : selectedLiveError ? `Not following live (${selectedLiveError}); the chat refreshes every few seconds.` : "Enter to send · Shift+Enter for a new line"}</span>
          </div>
          {!selected && !entries.length && roots.length > 0 && <section className="home-recents" aria-label="Recent chats"><h3>Recent</h3>{roots.slice(0, 4).map(thread => <button key={thread.id} onClick={() => loadThread(thread)}><span>{title(thread)}</span><small>{[providerLabel(thread.model, thread.modelProvider, providerSettings?.providers), modelLabel(thread.model, models)].filter(Boolean).join(" · ")}</small></button>)}</section>}
        </div>
      </div>
      {selected && teamRoot && team.length > 0 && agentsPanel && !browserOpen && <aside className="team-panel" aria-label="Agents in this chat">
        <div className="team-heading"><span>Agents</span><small>{team.filter(thread => agentState(thread, waitingIds) === "working").length} working · {team.length} total</small></div>
        <button className={`team-row root${selected.id === teamRoot.id ? " active" : ""}`} onClick={() => openById(teamRoot.id)}><span className="team-state"><i /></span><span className="team-title">{title(teamRoot)}</span><small>Main chat</small></button>
        {team.map(thread => { const state = agentState(thread, waitingIds);
          return <button key={thread.id} className={`team-row ${state}${selected.id === thread.id ? " active" : ""}`} onClick={() => loadThread(thread)} title={activity[thread.id] || title(thread)}>
            <span className="team-state" aria-label={{ waiting: "Needs input", working: "Working", error: "Error", idle: "Idle", unknown: "Status unavailable" }[state]}><i /></span>
            <span className="team-title">{title(thread)}{thread.agentNickname && thread.agentNickname !== title(thread) && <em>{thread.agentNickname}</em>}</span>
            <small>{state === "working" && activity[thread.id] ? activity[thread.id] : [modelLabel(thread.model, models), thread.reasoningEffort].filter(Boolean).join(" · ")}</small>
          </button>; })}
      </aside>}
      </div>}
      </div><BrowserPanel onVisibleChange={setBrowserOpen} covered={pendingInputOpen || sidebar}/></div>
    </main>
  </div>;
}
