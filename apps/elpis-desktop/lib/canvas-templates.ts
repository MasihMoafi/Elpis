import { agent, wire, graphOf, chain, fan, withMother } from './canvas-graph.ts';
import type { Template } from './canvas-types.ts';
export const ANTHROPIC = "Anthropic, Building effective agents";
/** Anthropic's caution about splitting work by role (claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them). */
export const BY_ROLE = "Split by role: Anthropic finds each handoff loses context, so this often does worse than split by parts.";
export const NOTE = "as a markdown file in your folder";
export const TEMPLATES: [
    Template,
    ...Template[]
] = [
    // The default: split by parts, as Anthropic advises (context isolation and parallelism, not roles).
    { id: "split-parts", name: "Split by parts", group: "Patterns", source: "Anthropic, Building multi-agent systems", description: "Each agent owns one independent part end to end: plans, builds and tests it in its own context. A last agent joins the parts.", build: () => {
            const parts = [1, 2, 3].map(index => agent(`Part ${index}`, `Own part ${index} end to end: plan it, build it and run its tests.`));
            const join = agent("Join the parts", "Make the parts work together: run the whole suite and fix what fails.", { acceptanceCriteria: ["The whole suite passes"] });
            return graphOf("Split by parts", [...parts, join], fan(parts, [join]));
        } },
    { id: "sequential", name: "Sequential (prompt chaining)", group: "Patterns", source: ANTHROPIC, description: "Each agent builds on the last one's work: the base, then the next layer, then the finish.", build: () => {
            const steps = [agent("Step 1: the base", "Build the base the next steps stand on."), agent("Step 2: build on it", "Build the next layer on step 1's work."), agent("Step 3: finish", "Finish and polish: edge cases, errors, docs.")];
            return graphOf("Sequential", steps, chain(...steps));
        } },
    { id: "plan-build", name: "Plan → Build", group: "Patterns", source: ANTHROPIC, caution: BY_ROLE, description: "One agent writes the plan as a file; two agents build its two halves side by side.", build: () => {
            const plan = agent("Write the plan", `Find the code involved and write a numbered plan ${NOTE}: the files to change and the checks that prove it works.`, { acceptanceCriteria: ["The plan names the files and the checks"] });
            const builders = ["first", "second"].map(half => agent(`Build the ${half} half`, `Build the ${half} half of the plan.`));
            return graphOf("Plan → Build", [plan, ...builders], fan([plan], builders));
        } },
    { id: "evaluator-optimizer", name: "Evaluator–optimizer", group: "Patterns", source: ANTHROPIC, description: "Draft it; its check evaluates the draft; a second agent improves it where the check found it short.", build: () => {
            const steps = [agent("Draft it", "Make the change."), agent("Improve it", "Improve the draft wherever its check found it short.")];
            return graphOf("Evaluator–optimizer", steps, chain(...steps));
        } },
    { id: "voting", name: "Voting", group: "Patterns", source: ANTHROPIC, description: "Three agents answer the same question on their own, each in a file; a fourth writes the majority answer.", build: () => {
            const voters = [1, 2, 3].map(index => agent(`Answer ${index}`, `Answer the question on your own, with evidence, ${NOTE}.`, { acceptanceCriteria: ["The answer file exists, with evidence"] }));
            const tally = agent("Tally the answers", `Compare the three answers and write the majority answer, with reasons, ${NOTE}.`, { acceptanceCriteria: ["The result names the majority and why"] });
            return graphOf("Voting", [...voters, tally], fan(voters, [tally]));
        } },
    { id: "hierarchical", name: "Hierarchical (orchestrator and teams)", group: "Patterns", source: "Anthropic's orchestrator-workers; LangGraph's hierarchical teams", description: "A lead writes the split; two team leads write their area's plan; two workers each build; a last agent joins the areas.", build: () => {
            const lead = agent("Lead: split the work", `Split the work into areas A and B ${NOTE}, with a brief for each team lead.`, { acceptanceCriteria: ["Each area has a brief"] });
            const teams = ["A", "B"].map(team => ({ lead: agent(`Team ${team} lead`, `Plan area ${team} for your two workers ${NOTE}.`, { acceptanceCriteria: ["The plan gives each worker a part"] }), workers: [1, 2].map(index => agent(`Team ${team} worker ${index}`, `Build your part of area ${team}.`)) }));
            const join = agent("Join the areas", "Make the two areas work together: run the whole suite and fix what fails.", { acceptanceCriteria: ["The whole suite passes"] });
            return graphOf("Hierarchical", [lead, ...teams.flatMap(team => [team.lead, ...team.workers]), join], [...teams.flatMap(team => [wire(lead, team.lead), ...fan([team.lead], team.workers), ...fan(team.workers, [join])])]);
        } },
    { id: "debate", name: "Debate + judge", group: "Patterns", source: "Multi-agent debate", description: "Two agents each write the strongest case for one design; a judge writes the decision, with reasons.", build: () => {
            const sides = ["A", "B"].map(side => agent(`Case for ${side}`, `Write the strongest case for design ${side} ${NOTE}.`, { acceptanceCriteria: ["The case file exists, with evidence"] }));
            const judge = agent("Judge", `Weigh both cases and write the decision, with reasons, ${NOTE}.`, { acceptanceCriteria: ["The decision picks one design and says why"] });
            return graphOf("Debate + judge", [...sides, judge], fan(sides, [judge]));
        } },
    { id: "research", name: "Multi-agent research", group: "Research", source: "Anthropic, How we built our multi-agent research system", description: "A lead writes the research plan; four agents research in parallel, each writing findings; one writes the report; one checks its citations.", build: () => {
            const lead = agent("Lead researcher", `Split the question into four parts, one per researcher, ${NOTE}.`, { acceptanceCriteria: ["Four parts, each with its question"] });
            const parts = [1, 2, 3, 4].map(index => agent(`Research part ${index}`, `Research part ${index} of the lead's plan and write the findings, citing every source, ${NOTE}.`, { acceptanceCriteria: ["Every finding cites its source"] }));
            const report = agent("Write the report", `Synthesize the four findings into one report ${NOTE}.`, { acceptanceCriteria: ["The report covers all four parts"] });
            const cite = agent("Check the citations", "Check every claim in the report against its cited source and correct the report where they differ.", { acceptanceCriteria: ["Every claim matches its source"] });
            return graphOf("Multi-agent research", [lead, ...parts, report, cite], [...fan([lead], parts), ...fan(parts, [report]), wire(report, cite)]);
        } },
    { id: "deep-research", name: "Deep research", group: "Research", source: "LangGraph, Open Deep Research", description: "Scope a brief, a supervisor splits it, three researchers write findings in parallel, one writes the final report.", build: () => {
            const scope = agent("Scope the brief", `Write the research brief: the question, what is in and out of scope, ${NOTE}.`, { acceptanceCriteria: ["The brief states the question and the scope"] });
            const supervisor = agent("Supervisor", `Split the brief into three research topics ${NOTE}.`, { acceptanceCriteria: ["Three topics, each with its question"] });
            const researchers = [1, 2, 3].map(index => agent(`Researcher ${index}`, `Research topic ${index} and write compressed findings with sources ${NOTE}.`, { acceptanceCriteria: ["Every finding cites its source"] }));
            const report = agent("Final report", `Write the final report from the findings, with sources, ${NOTE}.`, { acceptanceCriteria: ["The report answers the brief, with sources"] });
            return graphOf("Deep research", [scope, supervisor, ...researchers, report], [wire(scope, supervisor), ...fan([supervisor], researchers), ...fan(researchers, [report])]);
        } },
    { id: "blank", name: "Blank playground", group: "Start", source: "", description: "Start empty: add agents with Tab or Ctrl+A and wire them yourself.", build: () => withMother({ name: "Untitled graph", nodes: [], edges: [] }) },
];
/** Pattern commands rewire the current team without replacing its prompts or identities. */
export const PATTERNS = ["Sequential", "Parallel", "Kahn graph waves", "Recursive", "Voting"] as const;
/** The team a pattern number makes on an empty board: the starter of that shape. */
export const PATTERN_TEAMS = ["sequential", "split-parts", "plan-build", "evaluator-optimizer", "voting"] as const;
