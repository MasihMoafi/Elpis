"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { api } from "@/lib/api";
import { appStorage } from "@/lib/projects";

export type CodebaseProject = { root: string; name: string; usedAt: number; committedAt?: number };
type Listing = { projects: CodebaseProject[]; current: string | null };
const REMEMBERED = "elpis-codebase-project-v1";

const remembered = () => {
  try {
    return appStorage().getItem(REMEMBERED);
  } catch {
    return null;
  }
};

/**
 * The project the Codebase page reads (docs/specs/codebase-dashboard.md, D9). 13 Nov, Masih: "it says no git and I
 * couldn't find any git projects which is odd!": most of his chats run in a folder of repositories or in the router's
 * folders, which have no Git of their own. The page opens on the project he chose last (kept across restarts), else
 * on the chat's own project, else on the one with the most recent commit.
 */
export function useCodebaseProject(threadId: string | undefined, active: boolean) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    api<Listing>(`/codebase/projects${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`).then(
      value => {
        if (live) setListing({ projects: Array.isArray(value?.projects) ? value.projects : [], current: value?.current ?? null });
      },
      () => {
        if (live) setListing({ projects: [], current: null });
      },
    );
    return () => {
      live = false;
    };
  }, [threadId, active]);
  const projects = listing?.projects ?? [];
  const listed = (root: string | null | undefined) => (root && projects.some(project => project.root === root) ? root : null);
  // The newest commit, not the first by name (14 Nov: it opened on artface-demo).
  const newest = projects.reduce<CodebaseProject | null>(
    (best, project) => (!best || (project.committedAt ?? 0) > (best.committedAt ?? 0) ? project : best),
    null,
  );
  const root = listing
    ? (listed(choice) ?? listed(remembered()) ?? listed(listing.current) ?? newest?.root ?? null)
    : null;
  const choose = (next: string) => {
    setChoice(next);
    try {
      appStorage().setItem(REMEMBERED, next);
    } catch {
      // Not remembered on this device; the choice still holds while the page is open.
    }
  };
  return { loading: !listing, projects, root, choose };
}

export function CodebaseProjectPicker({
  projects,
  root,
  onChoose,
}: {
  projects: CodebaseProject[];
  root: string | null;
  onChoose: (root: string) => void;
}) {
  const [query, setQuery] = useState("");
  const current = projects.find(project => project.root === root) ?? null;
  return (
    <Combobox
      items={projects}
      value={current}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(project: CodebaseProject) => project.name}
      itemToStringValue={(project: CodebaseProject) => project.root}
      onValueChange={project => {
        if (project) {
          onChoose(project.root);
          setQuery("");
        }
      }}
    >
      <ComboboxTrigger
        role="combobox"
        aria-label="Project"
        className="observability-chat"
        disabled={!projects.length}
        title={current?.root}
      >
        <span className="truncate">{current ? current.name : projects.length ? "Choose a project" : "No Git projects"}</span>
        <ChevronDown size={16} />
      </ComboboxTrigger>
      <ComboboxContent className="observability-chat-menu">
        <SearchField variant="bare">
          <ComboboxInput aria-label="Search projects" placeholder="Search projects…" autoFocus />
        </SearchField>
        <ComboboxEmpty>No project matches.</ComboboxEmpty>
        <ComboboxList>
          {(project: CodebaseProject) => (
            <ComboboxItem key={project.root} value={project} data-project-root={project.root}>
              <span className="observability-project">
                <span className="truncate">{project.name}</span>
                <span className="observability-project-path truncate">{project.root}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
