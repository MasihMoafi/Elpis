/** Owns locally saved chat groups and their list settings. */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { emptyGroups, readGroups, writeGroups, type ChatGroups } from "@/lib/chat-groups";
import { appStorage } from "@/lib/projects";

export function useChatGroups(setError: Dispatch<SetStateAction<string>>) {
  // Groups the person made, and how the sidebar lists chats (lib/chat-groups.ts); kept on this computer, read once.
  const [chatGroups, setChatGroups] = useState<ChatGroups>(emptyGroups);
  const chatGroupsRef = useRef(chatGroups); chatGroupsRef.current = chatGroups;
  const [newGroupFor, setNewGroupFor] = useState<string[] | null>(null);
  useEffect(() => { setChatGroups(readGroups(appStorage())); }, []);
  function updateGroups(change: (state: ChatGroups) => ChatGroups) {
    const next = change(chatGroupsRef.current);
    chatGroupsRef.current = next; setChatGroups(next);
    if (!writeGroups(next, appStorage())) setError("Could not save chat groups on this device.");
  }
  return { chatGroups, newGroupFor, setNewGroupFor, updateGroups };
}
