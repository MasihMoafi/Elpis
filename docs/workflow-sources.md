# Workflow sources

Reviewed 2026-10-18. Primary abstracts and results were read. Published findings are evidence for related methods; every Elpis starter remains unproven until measured locally.

Generated from `apps/elpis-desktop/lib/workflow-sources.json`, also imported by the app. Edit that file, then run `node scripts/workflow-sources.mjs`; `--check` detects drift. Years identify the first paper version; venue notes identify later publication. The source links on Canvas starters describe implementation inspiration, not efficacy.

## Split by parts

**No direct evidence.** What is proven: Structured multi-agent software workflows have measured benchmark results.

What is not: No direct evidence found for this exact three independent writers plus join graph. MetaGPT uses roles and shared SOPs, not this split; Elpis speed, quality and token benefit are unproven.

Starter inspiration: [When to use multi-agent systems (and when not to)](https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them) (implementation guidance, not paper evidence).

- [MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352) — Sirui Hong; Mingchen Zhuge; Jiaqi Chen; Xiawu Zheng; Yuheng Cheng; Ceyao Zhang; Jinlin Wang; Zili Wang; Steven Ka Shing Yau; Zijuan Lin; Liyang Zhou; Chenyu Ran; Lingfeng Xiao; Chenglin Wu; Jürgen Schmidhuber. 2023; arXiv 2023; ICLR 2024. GPT-4 MetaGPT reports HumanEval pass@1 85.9% and MBPP 87.7% (Section 4.1); this is a bundled system result, not a topology ablation. [Results read](https://arxiv.org/html/2308.00352v6#S4).

## Sequential (prompt chaining)

**Related evidence.** What is proven: Sequential subproblem solving improves SCAN in the cited model and prompting setup.

What is not: Three separate writing agents with file handoffs are not validated by this single-model prompting study; its gains do not transfer automatically.

Starter inspiration: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (implementation guidance, not paper evidence).

- [Least-to-Most Prompting Enables Complex Reasoning in Large Language Models](https://arxiv.org/abs/2205.10625) — Denny Zhou; Nathanael Schärli; Le Hou; Jason Wei; Nathan Scales; Xuezhi Wang; Dale Schuurmans; Claire Cui; Olivier Bousquet; Quoc Le; Ed Chi. 2022; arXiv 2022; ICLR 2023. SCAN length-split accuracy: code-davinci-002, 16.2% chain-of-thought → 99.7% least-to-most (Table 8). [Results read](https://arxiv.org/html/2205.10625v3#S3.SS2).

## Plan → Build

**Related evidence.** What is proven: Planning before solving improves the cited arithmetic accuracy.

What is not: A planner followed by two parallel builders is not validated by Plan-and-Solve; it tests a prompt strategy, not separate coding agents.

Starter inspiration: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (implementation guidance, not paper evidence).

- [Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models](https://aclanthology.org/2023.acl-long.147/) — Lei Wang; Wanyu Xu; Yihuai Lan; Zhiqiang Hu; Yunshi Lan; Roy Ka-Wei Lee; Ee-Peng Lim. 2023; ACL 2023. GSM8K accuracy with text-davinci-003: 56.4% zero-shot CoT → 59.3% PS+ (Table 2). [Results read](https://aclanthology.org/2023.acl-long.147.pdf#page=6).

## Evaluator–optimizer

**Related evidence.** What is proven: Feedback followed by revision can improve code optimization; the paper also reports negligible math gains.

What is not: Elpis’s draft/check/improve graph is not validated by this paper. Its checks and one revision differ from iterative Self-Refine; model feedback is not ground truth.

Starter inspiration: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (implementation guidance, not paper evidence).

- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651) — Aman Madaan; Niket Tandon; Prakhar Gupta; Skyler Hallinan; Luyu Gao; Sarah Wiegreffe; Uri Alon; Nouha Dziri; Shrimai Prabhumoye; Yiming Yang; Shashank Gupta; Bodhisattwa Prasad Majumder; Katherine Hermann; Sean Welleck; Amir Yazdanbakhsh; Peter Clark. 2023; NeurIPS 2023. GPT-4 code optimization: programs optimized, 27.3% → 36.0%; math solve rate barely changes, 92.9% → 93.1% (Table 1). [Results read](https://arxiv.org/html/2303.17651v2#S3).

## Voting

**Related evidence.** What is proven: Sampling diverse answers and aggregating improves the cited GSM8K benchmark.

What is not: Three file-writing voters plus a model tally are not validated here; the paper marginalizes 40 sampled paths. Correlated errors, ties and a mistaken tally remain possible.

Starter inspiration: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (implementation guidance, not paper evidence).

- [Self-Consistency Improves Chain of Thought Reasoning in Language Models](https://arxiv.org/abs/2203.11171) — Xuezhi Wang; Jason Wei; Dale Schuurmans; Quoc Le; Ed H. Chi; Sharan Narang; Aakanksha Chowdhery; Denny Zhou. 2022; arXiv 2022; ICLR 2023. PaLM-540B GSM8K accuracy: 56.5% greedy CoT → 74.4% self-consistency with 40 sampled paths (Table 2). [Results read](https://arxiv.org/html/2203.11171v4#S3.SS2).

## Hierarchical (orchestrator and teams)

**No direct evidence.** What is proven: MetaGPT measures a complete structured multi-agent coding system.

What is not: No direct evidence found for this fixed lead/two team leads/four workers/join tree. The reported result does not isolate hierarchy or establish Elpis gains.

Starter inspiration: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (implementation guidance, not paper evidence).

- [MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352) — Sirui Hong; Mingchen Zhuge; Jiaqi Chen; Xiawu Zheng; Yuheng Cheng; Ceyao Zhang; Jinlin Wang; Zili Wang; Steven Ka Shing Yau; Zijuan Lin; Liyang Zhou; Chenyu Ran; Lingfeng Xiao; Chenglin Wu; Jürgen Schmidhuber. 2023; arXiv 2023; ICLR 2024. GPT-4 MetaGPT reports HumanEval pass@1 85.9% and MBPP 87.7% (Section 4.1); this is a bundled system result, not a topology ablation. [Results read](https://arxiv.org/html/2308.00352v6#S4).

## Debate + judge

**Related evidence.** What is proven: Multiple rounds of critique improve GSM8K in the cited small sample.

What is not: Two independent cases plus a judge are not validated by this paper: Elpis has no rebuttal rounds, and the study uses three debating agents.

- [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325) — Yilun Du; Shuang Li; Antonio Torralba; Joshua B. Tenenbaum; Igor Mordatch. 2023; arXiv 2023; ICML 2024. ChatGPT GSM8K accuracy on 100 problems: single agent 77.0 ± 4.2% → debate 85.0 ± 3.5%, using 3 agents and 2 rounds (Table 1). [Results read](https://arxiv.org/html/2305.14325v1#S3).

## Multi-agent research

**Related evidence.** What is proven: A planner and parallel searchers improve the cited closed-set QA aggregate.

What is not: This fixed four-researcher/report/citation-check graph is not validated. MindSearch dynamically expands its graph; Anthropic’s vendor research result is not an independent paper validating this starter.

Starter inspiration: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (implementation guidance, not paper evidence).

- [MindSearch: Mimicking Human Minds Elicits Deep AI Searcher](https://arxiv.org/abs/2407.20183) — Zehui Chen; Kuikun Liu; Qiuchen Wang; Jiangning Liu; Wenwei Zhang; Kai Chen; Feng Zhao. 2024; arXiv 2024. GPT-4o closed-set QA average score: ReAct Search 55.1 → MindSearch 59.8 (Table 1). Open-set analysis says factuality did not improve (Section 3.1.2). [Results read](https://arxiv.org/html/2407.20183v1#S3).

## Deep research

**No direct evidence.** What is proven: Planner/searcher decomposition has related measured QA evidence.

What is not: No direct evidence found for this exact scope/supervisor/three researchers/report graph. LangGraph’s Open Deep Research is an implementation source, not proof of this Elpis starter.

Starter inspiration: [Open Deep Research implementation](https://github.com/langchain-ai/open_deep_research) (implementation guidance, not paper evidence).

- [MindSearch: Mimicking Human Minds Elicits Deep AI Searcher](https://arxiv.org/abs/2407.20183) — Zehui Chen; Kuikun Liu; Qiuchen Wang; Jiangning Liu; Wenwei Zhang; Kai Chen; Feng Zhao. 2024; arXiv 2024. GPT-4o closed-set QA average score: ReAct Search 55.1 → MindSearch 59.8 (Table 1). Open-set analysis says factuality did not improve (Section 3.1.2). [Results read](https://arxiv.org/html/2407.20183v1#S3).

## Blank playground

**No direct evidence.** What is proven: No efficacy claim: this is an empty editor.

What is not: No direct evidence exists for an unspecified user graph; every custom topology needs its own comparison.

No paper or measured efficacy result applies to an empty editor.
