# RTK Output Fidelity: First Local Experiment

Question: do the installed RTK rewrites omit information needed for actual repository
inspection, relative to direct subprocess output? This is not a pruning ON/OFF study.

Run `node docs/evals/rtk-output-fidelity/run.mjs --self-test`, then
`node docs/evals/rtk-output-fidelity/run.mjs` from the repository root.
No model calls, dependency installs, or changes to product settings are required.

Three useful tasks: inspect the execution checkpoint before editing it; review the
full experiment protocol; audit its pruning/cache references. Commands use matched
raw and RTK paths. Predeclared critical-line checks come from raw output, never from
filtered output. Intact/deleted/empty controls run first. Each source and both child
outputs are archived before the outer tool response can be summarized by Elpis.

Each run creates a new evidence directory; existing outputs are never overwritten.
The harness does not resume interrupted commands. Completed individual captures
survive interruption, but only a complete results.json represents a completed run.
This small offline check is not the parallel live-model harness.

Report exact-line omissions separately from failed critical checks: formatting changes
alone do not prove semantic loss. If a critical check fails, perform and record one
real raw fallback read. That counts as a scripted recovery, not evidence that a human
or LLM necessarily would have made the same extra call. Bytes are not model tokens.

Limitations: three selected commands and one RTK version; no generalized productivity,
latency, cache, or model-quality claim. Downstream Elpis admission and outer tool token
limits are not measured here. Evidence contains workspace text and is local/private;
no publication or upload is authorized.
