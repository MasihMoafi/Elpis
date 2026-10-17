"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AgentsGuideLink } from "@/components/agents-guide";

/** Mount the entry in Canvas help; settings replace that section when a node opens or closes. */
export function CanvasGuideHelp({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState<Element | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const find = () => setHelp(element.querySelector('.canvas-guide'));
    find();
    const observer = new MutationObserver(find);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <div ref={root} className="contents">{children}{help && createPortal(<AgentsGuideLink onOpen={onOpen} />, help)}</div>;
}
