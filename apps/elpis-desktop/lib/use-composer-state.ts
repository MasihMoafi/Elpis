import { useCallback, useRef, useState } from "react";
import type { Mention } from "@/lib/mentions";

export function useComposerState() {
  const [text, setTextState] = useState("");
  const [shellMode, setShellMode] = useState(false);
  const shellCreated = useRef<string | null>(null);
  const textRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  // A message carries the picked mentions whose @name is still in its text.
  const pickedMentions = useRef(new Map<string, Mention>());
  const filePickerRef = useRef<HTMLInputElement>(null);
  const [dictating, setDictating] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const setText = useCallback((value: string) => { textRef.current = value; setTextState(value); }, []);
  return { text, setText, shellMode, setShellMode, shellCreated, textRef, composerRef, caret, setCaret, pickedMentions, filePickerRef, dictating, setDictating, voiceBusy, setVoiceBusy };
}
