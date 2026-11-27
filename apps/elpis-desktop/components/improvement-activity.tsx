"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Hammer, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkingMark } from "@/components/working-mark";
import { api, type Thread } from "@/lib/api";
import { errorText } from "@/lib/error-text.mts";

type Request = { request: string; target: { id: string; label: string; image: string } };
type Pending = Request & { id: string; error?: string; threadId?: string };
type Announcement = { request: string; phase: "starting" | "started" | "failed" };
type Activity = {
  start: (request: Request) => void;
  pending: Pending[];
  announcement: Announcement | null;
  retry: (job: Pending) => void;
  dismiss: (id: string) => void;
  isChange: (id: string) => boolean;
};
const ActivityContext = createContext<Activity | null>(null);

/** Start the work without navigating away; retain an unconfirmed request for the user to recover. */
export function ImprovementActivityProvider({ onCreated, children }: { onCreated: (thread: Thread) => void; children: ReactNode }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [changes, setChanges] = useState<Set<string>>(() => new Set());
  const running = useRef(new Set<string>());
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(null), 4000);
    return () => clearTimeout(timer);
  }, [announcement]);
  useEffect(() => {
    let active = true;
    void api<{ data?: { threadId?: string }[] }>("/improvements").then(result => {
      const ids = Array.isArray(result.data) ? result.data.flatMap(row => row.threadId ? [row.threadId] : []) : [];
      if (active) setChanges(previous => new Set([...previous, ...ids]));
    }).catch(() => { /* Ordinary chats do not depend on the change catalog. */ });
    return () => { active = false; };
  }, []);
  const run = useCallback((job: Pending) => {
    if (running.current.has(job.id)) return;
    running.current.add(job.id);
    setAnnouncement({ request: job.request, phase: "starting" });
    setPending(previous => previous.map(item => item.id === job.id ? { ...item, error: "" } : item));
    void api<{ thread: Thread; error?: string }>("/improvements", { request: job.request, target: job.target })
      .then(result => {
        if (!result.thread?.id) throw Error("The change chat was not returned.");
        setChanges(previous => new Set(previous).add(result.thread.id));
        onCreated(result.thread);
        const error = result.error;
        setAnnouncement({ request: job.request, phase: error ? "failed" : "started" });
        setPending(previous => error
          ? previous.map(item => item.id === job.id ? { ...item, error, threadId: result.thread.id } : item)
          : previous.filter(item => item.id !== job.id));
      })
      .catch(cause => {
        setAnnouncement({ request: job.request, phase: "failed" });
        setPending(previous => previous.map(item => item.id === job.id
          ? { ...item, error: errorText(cause, "The change could not be started.") }
          : item));
      })
      .finally(() => running.current.delete(job.id));
  }, [onCreated]);
  const start = useCallback((request: Request) => {
    const job = { ...request, id: crypto.randomUUID() };
    setPending(previous => [job, ...previous]);
    run(job);
  }, [run]);
  return <ActivityContext.Provider value={{
    start, pending, announcement, retry: run,
    dismiss: id => setPending(previous => previous.filter(job => job.id !== id)),
    isChange: id => changes.has(id),
  }}>{children}</ActivityContext.Provider>;
}

export function useImprovementActivity() {
  const activity = useContext(ActivityContext);
  if (!activity) throw Error("Change activity needs the workspace provider.");
  return activity;
}

export function ImprovementMark({ threadId }: { threadId: string }) {
  const activity = useContext(ActivityContext);
  return activity?.isChange(threadId)
    ? <span role="img" aria-label="Elpis change" title="Elpis change" className="shrink-0"><Hammer size={14} aria-hidden="true" /></span>
    : null;
}

function ChangeErrorNotice({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <p role="alert" className="thread-row px-2 text-xs text-destructive" title={message}>
    <span className="truncate">{message}</span>
  </p> : null;
}

export function PendingImprovements() {
  const { pending, retry, dismiss } = useImprovementActivity();
  if (!pending.length) return null;
  return <section aria-label="Starting changes">
    {pending.map(job => {
      const errorMessage = job.error && `${job.error} ${job.threadId ? "Open the change chat to inspect it." : "Check the chat list before retrying; the start may have completed."}`;
      return <div key={job.id}>
        <div className="thread-row" data-slot="pending-improvement">
          <span className="conversation-state-slot" aria-hidden="true">
            {job.error ? <span className="thread-dot" data-state="error" /> : <WorkingMark animatedEdges={false} />}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-sm" role="status" title={errorMessage || job.request}
            aria-label={errorMessage ? `${job.request}. ${errorMessage}` : undefined}>
            <Hammer size={14} aria-hidden="true" className="shrink-0" />
            <span className="thread-title">{job.request}</span>
          </div>
          {job.error && !job.threadId && <Button variant="ghost" size="icon-xs" aria-label="Retry starting change"
            title="Check the chat list for this change before retrying" onClick={() => retry(job)}><RotateCw size={14} /></Button>}
          {job.error && <Button variant="ghost" size="icon-xs" aria-label="Dismiss change error"
            title="Dismiss" onClick={() => dismiss(job.id)}><X size={14} /></Button>}
        </div>
        {errorMessage && <ChangeErrorNotice message={errorMessage} />}
      </div>;
    })}
  </section>;
}
