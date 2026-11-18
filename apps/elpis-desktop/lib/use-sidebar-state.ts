import { useCallback, useEffect, useRef, useState } from "react";
import { applyAttention, readAttention, subscribeAttention, type Attention } from "@/lib/attention";
import type { Op } from "./attention-state.cts";
import { readPins, savePins } from "@/lib/pins";
import { readBookmarks, saveBookmarks } from "@/lib/bookmarks";
import { appStorage } from "@/lib/projects";
import { defaultFolds, readFolds, writeFolds, type SidebarFolds } from "@/lib/sidebar-folds";
import { GROUPS_KEY, emptyGroups, readGroups, writeGroups, type ChatGroups } from "@/lib/chat-groups";

/** Which chats have an answer not yet read and which wait on a plan, kept on this computer. A plan the person has answered stops waiting.
 * `planTurns` remembers each chat's latest plan turn while the window is open. */
export function useChatAttention(planAnswered: Record<string, string>, onError: (message: string) => void) {
  const [attention, setAttention] = useState<Attention>({ unread: [], plans: {}, pending: {} });
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  const planTurns = useRef(new Map<string, string>());
  useEffect(() => {
    const refresh = () => setAttention(readAttention());
    const off = subscribeAttention(refresh);
    refresh();
    return off;
  }, []);
  const attentionOp = useCallback((op: Op) => {
    void applyAttention(op).catch(() => onError("Could not save chat attention on this device."));
  }, [onError]);
  const markRead = useCallback(
    (id: string) => attentionOp({ kind: "read", id, manual: true }), [attentionOp],
  );
  const autoRead = useCallback((id: string, turn?: string) => attentionOp({ kind: "read", id, manual: false, ...(turn ? { turn } : {}) }), [attentionOp]);
  useEffect(() => {
    for (const [id, turn] of Object.entries(attention.plans))
      if (turn === planAnswered[id]) attentionOp({ kind: "clearPlan", id, turn });
  }, [planAnswered, attention.plans, attentionOp]);
  return { attention, attentionRef, attentionOp, planTurns, markRead, autoRead };
}

function useChatMarks(read: () => string[], save: (ids: string[]) => void) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    setIds(read());
  }, [read]);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [id, ...ids];
    setIds(next);
    save(next);
  };
  return [ids, toggle] as const;
}

/** The chats pinned to the top of the sidebar, newest pin first, kept on this computer. */
export function usePins() {
  const [pins, togglePinned] = useChatMarks(readPins, savePins);
  return { pins, togglePinned };
}

/** Bookmarks mark chats without changing their sidebar section or order. */
export function useBookmarks() {
  const [bookmarks, toggleBookmarked] = useChatMarks(readBookmarks, saveBookmarks);
  return { bookmarks, toggleBookmarked };
}

/** Folded sections and projects stay as the person leaves them, across restarts (lib/sidebar-folds.ts). */
export function useSidebarFolds() {
  const [folds, setFolds] = useState<SidebarFolds>(defaultFolds);
  const foldsRef = useRef(folds);
  useEffect(() => {
    foldsRef.current = readFolds(appStorage());
    setFolds(foldsRef.current);
  }, []);
  const changeFolds = (change: (folds: SidebarFolds) => SidebarFolds) => {
    const next = change(foldsRef.current);
    foldsRef.current = next;
    setFolds(next);
    writeFolds(next, appStorage());
  };
  const setCollapsedProjects = (change: (projects: Record<string, boolean>) => Record<string, boolean>) =>
    changeFolds(value => ({ ...value, projects: change(value.projects) }));
  return { folds, foldsRef, changeFolds, setCollapsedProjects };
}

/** Groups the person made, and how the sidebar lists chats (lib/chat-groups.ts); kept on this computer, read once.
 * `releaseOrder` lets the sidebar re-sort once the groups change; `commitGroups` sets groups already saved. */
export function useChatGroups(onError: (message: string) => void, releaseOrder: () => void) {
  const [chatGroups, setChatGroups] = useState<ChatGroups>(emptyGroups);
  const chatGroupsRef = useRef(chatGroups);
  chatGroupsRef.current = chatGroups;
  useEffect(() => {
    const reload = () => {
      const groups = readGroups(appStorage());
      chatGroupsRef.current = groups;
      setChatGroups(groups);
    };
    reload();
    return window.elpisDesktop?.storage?.onChange?.(key => {
      if (key === GROUPS_KEY) reload();
    });
  }, []);
  const commitGroups = (next: ChatGroups) => {
    releaseOrder();
    chatGroupsRef.current = next;
    setChatGroups(next);
  };
  function updateGroups(change: (state: ChatGroups) => ChatGroups) {
    const next = change(chatGroupsRef.current);
    if (!writeGroups(next, appStorage())) {
      onError("Could not save chat groups on this device.");
      return false;
    }
    commitGroups(next);
    return true;
  }
  return { chatGroups, chatGroupsRef, updateGroups, commitGroups };
}
