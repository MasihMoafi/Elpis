"use client";
import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { BranchIcon } from "@/components/elpis-icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

/** The branch a chat works on, beside its folder, as Claude's desktop app shows it: the name, cut short, the whole name
 * on hover, and a menu to copy it. Read when the chat opens and again after each turn, since the agent may switch
 * branches. Nothing shows outside a Git repository or on a detached HEAD. Give it `key={threadId}`. */
export function BranchChip({ threadId, running, onNotice }: { threadId: string; running: boolean; onNotice: (text: string) => void }) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ branch?: string | null }>(`/threads/${encodeURIComponent(threadId)}/git?view=branch`)
      .then(result => { if (live) setBranch(typeof result.branch === "string" && result.branch ? result.branch : null); }, () => { if (live) setBranch(null); });
    return () => { live = false; };
  }, [threadId, running]);
  if (!branch) return null;
  const copy = () => navigator.clipboard.writeText(branch).then(() => onNotice("Branch name copied to clipboard."), () => onNotice("Could not copy: the clipboard is unavailable."));
  return <DropdownMenu>
    <DropdownMenuTrigger className="composer-chip project-chip branch-chip" aria-label={`Branch ${branch}`} title={branch}><BranchIcon size={13} aria-hidden="true" /><span>{branch}</span></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56">
      <DropdownMenuItem onClick={() => void copy()}><Copy aria-hidden="true" />Copy branch name</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
