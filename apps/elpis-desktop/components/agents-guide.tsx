"use client";

import { useState } from "react";
import { ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

const effective = { title: "Building effective agents", href: "https://www.anthropic.com/engineering/building-effective-agents" };
const research = { title: "How we built our multi-agent research system", href: "https://www.anthropic.com/engineering/multi-agent-research-system" };
// Claim-by-claim source map: docs/evals/agents-guide.md. These describe the Workflows implementation, not a live-run guarantee.
const topics = [
  { title: "One agent or many", intro: "Start with one chat for a small change, a question, or work that needs the same context throughout.", points: [
    "Use several agents when each can own an independent part with a clear result and a way to check it. Give each part its own files; agree on shared interfaces first.",
    "In Workflows, Split by parts is the default: each writer plans, builds and tests its part; a final writer joins the parts. Keep tightly connected work together.",
    "Choose a project before running. In the Mother’s settings, Max agents limits the team; At once limits how many tasks can run together.",
  ], links: [effective, research] },
  { title: "Mother and Father", intro: "The Mother is the run’s chat. Click her to set the shared brief and her model, and to read the run’s feed.", points: [
    "Every writer receives her brief. She starts the agents that have no prerequisites and receives their reports. A wire tells an agent what it must wait for.",
    "With more than 10 writers, the first 10 in run order belong to the Mother. The remaining writers belong to the Father, who gets his own chat.",
    "The Father starts only after the Mother’s part succeeds, then reports to her. If her part fails, his part does not start. Raising Max agents makes room for a larger team.",
  ], links: [research] },
  { title: "Writers and checks", intro: "Every board agent writes files; reading and planning happen inside that writer.", points: [
    "Give each writer a prompt, folders it may change (or the whole project), and a “Done when” check. Elpis fills missing prompts or folders. Each agent writes its report in agents/<its name>.",
    "Elpis adds a check after every writer; its report goes in agents/<name>/check. Downstream writers wait for both. A failed prerequisite blocks the writers that depend on it.",
    "With several writers in Git, Workflows requests one worktree per writer, shared with its check. Successful results merge; conflicts stop the merge and keep the work.",
    "Without Git, Workflows skips worktrees. Keep concurrent writers in separate folders.",
  ], links: [effective] },
  { title: "Choose a pattern", intro: "Choose by how the work divides. Edit each template’s prompts and folders for your task.", patterns: [
    ["Split by parts", "Independent parts: each writer owns one; a final writer joins them."],
    ["Voting", "One question: three independent answers, then a majority with reasons."],
    ["Debate + judge", "A design choice: two opposing cases, then a judge’s decision."],
    ["Hierarchical", "Several areas: a lead splits, teams plan and build, one joins."],
    ["Research", "Broad question: four research parts, a report, then a citation check."],
  ], points: ["Every wired branch runs. Workflows cannot choose just one branch."], links: [effective, research] },
  { title: "Read a run", intro: "Read the work and its check together. “Task done” means the writer finished; “Check passed” means its separate check succeeded.", points: [
    "Waves show run order: the first wave has no prerequisites; later waves wait for earlier work and its checks. At once can limit how many tasks actually run together.",
    "Click a writer for its inputs, status, check and chat. The Mother’s panel shows the feed. States include waiting, running, done, failed, blocked and cancelled.",
    "If a check fails or an input is blocked, open the chat and failure reason. Merge conflicts name the files and kept work. A finished task may still have unmerged changes.",
    "Review the result and evidence before accepting it. Checks do not replace your acceptance.",
  ], links: [effective] },
];

export function AgentsGuideLink({ onOpen }: { onOpen: () => void }) {
  return <Button variant="ghost" size="sm" onClick={onOpen}><BookOpen size={14} />Guide to managing agents</Button>;
}

export function AgentsGuide({ onBack }: { onBack: () => void }) {
  const [index, setIndex] = useState(0);
  const topic = topics[index];
  return <section aria-label="Guide to managing agents" className="mx-auto max-w-3xl space-y-5">
    <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={14} />Back to Workflows</Button>
    <nav aria-label="Guide topics" className="flex flex-wrap gap-2">
      {topics.map((item, at) => <Button key={item.title} variant={at === index ? "secondary" : "ghost"} size="sm" aria-current={at === index ? "page" : undefined} onClick={() => setIndex(at)}>{item.title}</Button>)}
    </nav>
    <article className="space-y-3 text-sm leading-relaxed">
      <h2 className="text-xl font-semibold">{topic.title}</h2>
      <p>{topic.intro}</p>
      {topic.patterns && <dl className="space-y-2">{topic.patterns.map(([name, detail]) => <div key={name} className="grid gap-1 sm:grid-cols-[140px_1fr]"><dt className="font-medium">{name}</dt><dd>{detail}</dd></div>)}</dl>}
      {topic.points.map(point => <p key={point}>{point}</p>)}
    </article>
    <footer className="space-y-2 border-t border-border pt-4 text-sm">
      <p className="text-muted-foreground">From Anthropic</p>
      {topic.links.map(link => <a key={link.href} className="block w-fit underline underline-offset-4" href={link.href} target="_blank" rel="noreferrer">{link.title}</a>)}
    </footer>
  </section>;
}
