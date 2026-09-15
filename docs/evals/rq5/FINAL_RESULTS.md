# RQ5: Forensic Reconstruction Audit of Elpis Context-Pruning Evidence

## 1. RQ5 Question

**To what extent can an evaluator reconstruct an applied Elpis context-pruning transformation from the artifacts Elpis preserves?**

---

## 2. Method: Artifact-Based Reconstruction Audit

This evaluation performs a file-based forensic audit of actual, existing local pruning artifacts produced by Elpis during runtime execution. Rather than relying on implementation source code (which confirms schema definitions) or design documentation (which states intended policy), this audit inspects saved runtime evidence under `~/.elpis/logs/pruning/` and `~/.elpis/sessions/`. 

The empirical scope of this audit is grounded in observed local pass directories (including pass `019fe543-afd9-7941-bd5d-637978c5e9ef`), per-item artifact records (`items/*.json`), Ace interaction logs (`ace.json`), attempt journals (`attempts.jsonl`), and session rollout logs (`rollout-*.jsonl`).

---

## 3. Audit Results Table (9 Evaluated Properties)

| Property | Status | Inspected Artifact Path | Observed JSON Field(s) | Reconstructible State | Unreconstructible / Omitted State |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **1. Trigger & Timestamp** | **YES** | `passes/<pass_id>/manifest.json`<br>`attempts.jsonl` | `timestamp`, `trigger` (`"pressure"` / `"steady"`), `pass_id` | Exact UTC timestamp and trigger classification governing pass invocation. | Instantaneous internal token counter value at trigger evaluation, unless matched to rollout telemetry. |
| **2. Material Reviewed** | **YES** | `passes/<pass_id>/items/<idx>-<call_id>.json`<br>`passes/<pass_id>/ace.json` | `items[].model_visible_before`<br>`ace.json` -> `input` | Exact tool calls, arguments, and string outputs submitted to Ace for review. | Unreviewed session context (system prompts, user instructions outside candidate tool batch). |
| **3. Keep/Delete Decision** | **YES** | `passes/<pass_id>/manifest.json`<br>`passes/<pass_id>/items/<idx>-<call_id>.json` | `items[].decision` (`"kept"` / `"deleted"`), `items[].conclusion` | Per-tool-call binary decision and replacement summary text for kept items. | Internal chain-of-thought steps of Ace beyond `raw_response` and reasoning token counters. |
| **4. Pre-Mutation Representation** | **YES** | `passes/<pass_id>/items/<idx>-<call_id>.json` | `model_visible_before` | Verbatim pre-pruning `ResponseItem` structure (name, call ID, parameters, raw output). | Non-tool-call messages not included in the candidate batch. |
| **5. Post-Mutation Representation** | **YES** | `passes/<pass_id>/items/<idx>-<call_id>.json` | `model_visible_after` | Synthetic tool output string inserted into model context (`[ELPIS CONTEXT UPDATE]...`), or empty array (`[]`) for deleted items. | System-level re-injections (e.g. instruction re-prompts) occurring in outer session loop after pass completion. |
| **6. Pointer to Original Evidence** | **YES** | `passes/<pass_id>/items/<idx>-<call_id>.json` | `source_pointer`, `model_visible_after[1].output` | URI `rollout://tool-call/<call_id>` linking pruned item to session rollout record. | Automated resolution if session rollout files are manually relocated or removed from disk. |
| **7. Ace Model & Usage Provenance** | **YES** | `passes/<pass_id>/ace.json`<br>`attempts.jsonl`<br>`manifest.json` | `model`, `instructions`, `input`, `raw_response`, `usage`, `attempts[]` | Provider model slug (`gpt-5.6-luna`), reasoning effort (`max`), attempt status (`success`), input/output/reasoning token breakdown. | Provider HTTP headers or provider-side internal transaction IDs not recorded in `ace.json`. |
| **8. Reclaimed Context Measurement** | **PARTIAL** | `passes/<pass_id>/manifest.json`<br>`rollout-*.jsonl` | `saved_chars`<br>`last_token_usage.input_tokens` | Exact character reduction (`saved_chars`) in active context; token delta estimated or derived from session rollout telemetry. | Exact pre-vs-post token recount directly within `manifest.json` (records character delta, not exact token delta). |
| **9. Session & Pass Linkage** | **PARTIAL** | `passes/<pass_id>/items/<idx>-<call_id>.json`<br>`rollout-*.jsonl` | `source_pointer`, `call_id` | Indirect linkage reconstructed via item artifact `source_pointer` / `call_id` matching `call_id` in rollout JSONL. | The pruning pass `manifest.json` does not directly record `session_id` or `turn_id`. |

---

## 4. Worked Reconstruction Example

Below is a complete, trace-verified reconstruction of an actual local pruning pass inspected on disk: **Pass ID `019fe543-afd9-7941-bd5d-637978c5e9ef`**.

### Step 1: Trigger and Timestamp Provenance
* **Artifact**: `~/.elpis/logs/pruning/passes/019fe543-afd9-7941-bd5d-637978c5e9ef/manifest.json`
* **Observed Data**:
```json
{
  "schema_version": 2,
  "pass_id": "019fe543-afd9-7941-bd5d-637978c5e9ef",
  "timestamp": "2026-08-09T06:44:59.413378728+00:00",
  "trigger": "pressure",
  "model": "gpt-5.6-luna",
  "saved_chars": 79851
}
```
* **Reconstruction**: The pass was executed at `2026-08-09T06:44:59.413378728+00:00` under a `"pressure"` trigger.

### Step 2: Material Reviewed & Pre-Mutation State
* **Artifact**: `~/.elpis/logs/pruning/passes/019fe543-afd9-7941-bd5d-637978c5e9ef/items/000-call_TbHce21wNbChXVsEd7pN9JED.json`
* **Observed Data (`model_visible_before`)**:
```json
{
  "schema_version": 2,
  "call_id": "call_TbHce21wNbChXVsEd7pN9JED",
  "decision": "kept",
  "source_pointer": "rollout://tool-call/call_TbHce21wNbChXVsEd7pN9JED",
  "model_visible_before": [
    {
      "type": "custom_tool_call",
      "call_id": "call_TbHce21wNbChXVsEd7pN9JED",
      "name": "exec",
      "input": "const r = await tools.update_plan(...); const a = await tools.exec_command({cmd:\"pwd && rg --files ... && git status --short --branch\"}); text(a.output);"
    },
    {
      "type": "custom_tool_call_output",
      "call_id": "call_TbHce21wNbChXVsEd7pN9JED",
      "output": "Script completed\nWall time 0.2 seconds\nOutput:\n~/Desktop/p/elpis-dash-bench-elpis\n## HEAD (no branch)\n M docs/evals/dashboard/benchmark_dashboard.html\n..."
    }
  ]
}
```
* **Reconstruction**: The evaluator observes the exact pre-mutation tool call parameters and 7,313 characters of command output before pruning.

### Step 3: Decisions & Post-Mutation Replacement State
* **Kept Item (`call_TbHce21wNbChXVsEd7pN9JED`)**:
  * **Observed `model_visible_after`**:
```json
"output": "[ELPIS CONTEXT UPDATE]\nkept=Repository is `~/Desktop/p/elpis-dash-bench-elpis`; worktree is `HEAD (no branch)` with `M docs/evals/dashboard/benchmark_dashboard.html` — `git status --short --branch` — establishes the inspection baseline and existing modification.\nevidence=rollout://tool-call/call_TbHce21wNbChXVsEd7pN9JED\noriginal_chars=7313"
```
* **Deleted Item (`call_C5wIa0aKMeJ5JFRhpbaWQ6dQ`)**:
  * **Artifact**: `items/001-call_C5wIa0aKMeJ5JFRhpbaWQ6dQ.json`
  * **Observed `decision`**: `"deleted"`
  * **Observed `model_visible_after`**: `[]` (completely removed from active context).

### Step 4: Source Evidence Pointer Resolution & Session Linkage
* **Artifact**: `items/000-call_TbHce21wNbChXVsEd7pN9JED.json` -> `source_pointer`: `"rollout://tool-call/call_TbHce21wNbChXVsEd7pN9JED"`
* **Session Linkage Reconstruction**: Because `manifest.json` does not directly record `session_id` or `turn_id`, session linkage is reconstructed indirectly by taking the item artifact's `source_pointer` / `call_id` and matching it to the corresponding `call_id` record in `~/.elpis/sessions/2026/08/09/rollout-2026-08-09T10-12-56-019fe542-a096-7630-b807-d1d83e082916.jsonl`.

### Step 5: Ace Usage & Reclaimed Context Provenance
* **Artifact**: `~/.elpis/logs/pruning/passes/019fe543-afd9-7941-bd5d-637978c5e9ef/ace.json`
* **Observed Usage**:
  * Model: `"gpt-5.6-luna"`
  * Reasoning Effort: `"max"`
  * Input Tokens: `20,476`
  * Output Tokens: `2,836`
  * Reasoning Output Tokens: `2,588`
  * Total Tokens: `23,312`
* **Reclaimed Context**: `manifest.json` reports `saved_chars: 79851` (a net reduction of 79,851 characters across the 4 reviewed items in this pass).

---

## 5. Aggregate Conclusion

Based on empirical inspection of preserved local runtime artifacts across the 9 evaluated properties, the reconstruction capability is **7 YES, 2 PARTIAL, 0 NO**:

1. **Deterministic Reconstruction (7 YES)**: Evaluators can fully reconstruct when a pass ran and its trigger classification, what tool material was reviewed, per-item keep/delete decisions, verbatim pre-mutation representations, post-mutation replacement strings, source evidence URIs (`source_pointer`), and Ace model usage provenance.
2. **Partial Reconstruction (2 PARTIAL)**:
   * **Reclaimed Context Measurement**: `manifest.json` records character reduction (`saved_chars`), not exact token count deltas. Token deltas must be inferred from main-model input token telemetry in session rollout logs.
   * **Session & Pass Linkage**: `manifest.json` does not directly record `session_id` or `turn_id`. Session linkage is reconstructed indirectly via `pass -> item artifact -> source_pointer/call_id -> matching call_id in rollout JSONL`.

---

## 6. Limitations

1. **Scope of Claim**: This evaluation is strictly scoped to the pruning pass artifacts inspected on local disk (`~/.elpis/logs/pruning/`). It does not assert universal completeness across uninspected runs or hypothetical future configurations.
2. **Artifact Dependency**: Pointer resolution and session linkage (`rollout://tool-call/<call_id>`) require that session rollout files remain accessible at their recorded filesystem paths.
3. **Token Accounting**: Pass manifests record character savings (`saved_chars`). Exact token-level impact relies on provider token-usage telemetry recorded in session rollouts.

---

## 7. Exact Artifact Index

* **Inspected Pass Directory**: `~/.elpis/logs/pruning/passes/019fe543-afd9-7941-bd5d-637978c5e9ef/`
  * `manifest.json`
  * `ace.json`
  * `items/000-call_TbHce21wNbChXVsEd7pN9JED.json`
  * `items/001-call_C5wIa0aKMeJ5JFRhpbaWQ6dQ.json`
  * `items/002-call_PbBaLR1VhxP4uXpzk5MI1osW.json`
  * `items/003-call_HuJxrFpKgEIww1WWhxFQDwh3.json`
* **Attempt Journal File**: `~/.elpis/logs/pruning/attempts.jsonl`
* **Inspected Session Rollout File**: `~/.elpis/sessions/2026/08/09/rollout-2026-08-09T10-12-56-019fe542-a096-7630-b807-d1d83e082916.jsonl`
