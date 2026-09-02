# Admission-Time Context Optimization for Cache-Stable Tool-Using Agents

## The Elpis Smart Prune design

Masih Moafi<br>
Technical preprint · evidence snapshot: 2026-09-02

> **Status.** The implementation and its cache-stability invariant are tested. One live
> Smart Prune session observed high provider cache reuse at two admission boundaries.
> Comparative cost, latency, and task quality remain open because no matched OFF/ON study
> has been completed.

## Abstract

Tool-using agents repeatedly carry large command results, file reads, searches, and logs
through later model requests. Retrospective context pruning can reduce that burden, but it
rewrites history the model may already have received. Prefix-based prompt caches can then
reuse only the unchanged part before the first rewrite.

Elpis introduces **admission-time tool-result optimization**. After a client-side tool and
its policy hooks finish—but before the result enters the main conversation—an isolated
optimizer may replace only the textual body with a smaller, evidence-linked body. The tool
event, call identity, ordering, and result envelope remain intact. Once admitted, the item
is immutable to Smart Prune, so later main requests append to the same logical prefix.

Mock-provider integration tests establish first-exposure placement, exact later-prefix
stability, stable main cache-key construction, bounded failure, and byte-exact fail-open
behavior. A live observational session reported 2,862,592 cached tokens out of 2,986,458
main input tokens (95.85%); the first responses linked to two applied admissions reported
98.96% and 98.89% cached input. These results support the mechanism, not a causal cost or
quality advantage.

## 1. Problem

An agent request is not only the latest user message. It can include stable instructions,
tool definitions, the conversation, tool calls, and tool results. OpenAI documents that
cache reuse requires the rendered prefix to match and recommends appending new messages
instead of rewriting earlier turns. Summarization, compaction, or truncation can reduce
reuse after the first changed token [1].

The original Elpis Ace path acted retrospectively. It selected completed tool results from
history, asked a maintenance model to compress them, and replaced those older bodies. This
did reduce current context. It also created a cache cliff each time a changed result sat
inside an otherwise reusable prefix. A historical trace recorded 42 applied passes over
103 requests; that result motivated a different placement for automatic optimization.

The key observation is temporal:

> A client-executed tool result does not enter the main model's history at the moment the
> model emits the tool call. The client still has an admission boundary before the next
> main-model request.

The provider produced the call; Elpis executed the tool locally. Elpis can therefore choose
the canonical result body that the main conversation sees first. This does **not** hide the
raw result from every remote service: the current semantic optimizer is itself a separate
model request and receives the source. The claim is cache stability for the main agent
history, not local-only processing or privacy reduction.

## 2. Design

```mermaid
sequenceDiagram
    participant M as Main model
    participant E as Elpis scheduler
    participant T as Client-side tool
    participant O as Isolated optimizer

    M->>E: Tool call with call_id
    E->>T: Execute tool
    T-->>E: Raw result
    E->>E: Apply truncation and PostToolUse policy
    alt Smart Prune off or result ineligible
        E->>E: Admit canonical result unchanged
    else Eligible textual result
        E->>O: Bounded source batch on separate cache key
        O-->>E: Complete decision manifest
        E->>E: Validate savings and publish audit
        E->>E: Admit compact body or exact original
    end
    E->>M: Next request contains first admitted form
    Note over E,M: Later requests append; Smart Prune never revisits admitted history
```

### 2.1 Canonical source

The canonical source is the model-visible result after tool execution, deterministic output
limits, and `PostToolUse` policy. Smart Prune does not bypass a hook, rewrite hook feedback,
or operate on a secret pre-policy value.

### 2.2 Eligibility and savings

The current implementation uses a deliberately conservative policy:

- only client-executed textual `FunctionCallOutput` and `CustomToolCallOutput` bodies;
- at least 1,024 approximate source tokens;
- at most 24,000 approximate source tokens in one optimizer batch;
- at least 256 approximate tokens and 20% saved after the evidence marker is included.

Short, unsupported, over-cap, or unprofitable results pass through unchanged. Smart Prune
does not automatically delete a tool call or its output event.

### 2.3 Validation and failure

The optimizer must return exactly one valid decision for every eligible call ID. Missing,
duplicate, unknown, or malformed decisions invalidate the batch. Timeouts, transport
errors, incomplete streams, audit-publication errors, and cancellation all preserve the
canonical source. After the first non-cancellation optimizer failure in a user turn, later
eligible batches in that turn bypass the optimizer; the next user turn may try again.

This fail-open rule protects task execution. It does not make the optimizer free: its
requests, reported tokens, and wait time are accounted separately.

### 2.4 Evidence before mutation

An applied admission is atomically published under:

```text
~/.elpis/logs/smart-prune/admissions/<admission-id>/
```

The initial record includes the exact source and admitted envelopes, source hashes,
decisions, optimizer request and response, and reported usage. If publishing that bundle
fails, the compact proposal is discarded. Linkage to the first main request and response
is appended later on a best-effort basis; a linkage-write failure warns but cannot roll
back an already admitted result. These local files are inspectable but not tamper-proof.

## 3. Cache-stability invariant

Let `H_t` be the logical item sequence previously sent by the main agent, `O_t` a newly
completed canonical tool-output batch, and `A(O_t)` the validated admission result. Smart
Prune constructs:

```text
H_(t+1) = H_t || A(O_t)
```

It never later applies another transformation to `A(O_t)`. Therefore, for changes caused
by Smart Prune alone:

```text
H_t is an exact prefix of H_(t+1)
```

The optimizer uses an isolated client session and a `:smart-prune` cache namespace. The
main request keeps its existing cache key. On incremental transport, Elpis checks the same
logical-prefix relation before using `previous_response_id`.

This is a narrow guarantee. A provider can still miss its cache because of expiry, model or
tool-schema changes, different request settings, explicit compaction, transport behavior,
or provider policy. The claim is that Smart Prune introduces no retroactive main-history
rewrite; it cannot guarantee a billed cache hit.

## 4. Retrospective `/prune` remains useful

`/prune` and `/force-prune` remain explicit recovery tools. They can reclaim tool-result
history the main model has already seen, which means they may reduce downstream prompt-cache
reuse from the first changed item onward. Elpis marks frozen epochs and can place a cache
breakpoint at a surviving boundary, but no marker can make a changed suffix byte-identical.

This is an intentional trade:

| Path | Acts on | Main-history cache effect | Use |
| --- | --- | --- | --- |
| Smart Prune | Fresh eligible tool results | Append-only after first exposure | Automatic when enabled |
| `/prune` | Already-admitted tool-result history | May invalidate the changed suffix | Explicit recovery |
| Native compaction | A broader older span | Replaces earlier context | Context-limit backstop |

## 5. Evaluation

### 5.1 Mechanism tests

On 2026-09-02, the focused mock-provider suite completed **13/13** Smart Prune integration
tests. It covers:

- compact admission before first main-model exposure;
- exact admitted-history prefix across later tool cycles;
- stable main cache key and isolated optimizer key;
- OFF-mode exact passthrough with no optimizer request;
- malformed or incomplete optimizer output failing open;
- insufficient savings and mixed eligible/ineligible batches;
- cancellation and per-turn failure bounding;
- audit-publication failure preserving the source;
- request retry and response-linkage correctness;
- absent versus reported-zero cache-write telemetry.

The reproducible command is:

```bash
cd codex-rs
CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 \
  cargo test -p codex-core --test all -- suite::smart_prune --nocapture
```

These are encoded-request tests against a mock provider. They establish the tested client
construction and failure behavior; they do not simulate a provider's internal cache.

### 5.2 Live observational pilot

One normal-work Smart Prune-ON session produced the following provider-reported main-agent
aggregate [2]:

| Main input | Cached input | Cache hit | Cache writes | Output | Total |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2,986,458 | 2,862,592 | 95.8524% | 0 | 42,342 | 3,028,800 |

Two admissions reduced 2,770 approximate source tokens to 1,006, an estimated 1,764-token
reduction in later main context. Their linked first main responses reported 98.96% and
98.89% cached input.

This was not a clean performance experiment. There was no matched OFF arm, one native
compaction confounded the later trace, and no private full-request capture was enabled. The
pilot also exposed an operational defect: 18 of 20 optimizer attempts reached the 45-second
deadline, accumulating 860.732 seconds of optimizer wait. The current same-turn failure
guard is integration-tested but has not yet been revalidated in a comparable live run.

### 5.3 Verdict

| Question | Verdict |
| --- | --- |
| Does Smart Prune act before first main-model exposure? | Established on the tested path |
| Does admitted main history remain append-only afterward? | Established on the tested path |
| Did the live provider reuse cache at observed admission boundaries? | Yes, observationally |
| Did Smart Prune cause the 95.85% session cache rate? | Unknown; no OFF control |
| Does Smart Prune lower total provider cost or latency? | Not established |
| Does Smart Prune preserve or improve task quality? | Not established |

The RQ4 result is therefore precise: **the cache-preserving construction is supported, and
live cache reuse was observed; comparative economics remain open.**

## 6. Relation to other approaches

Headroom describes a cache-mode pipeline that compresses only the newest delta and forwards
older turns byte-faithfully [3]. Its proxy/SDK performs type-aware compression and can store
originals in a Compress-Cache-Retrieve system. Elpis uses the same fundamental live-zone
principle at a different integration point: inside the agent scheduler, after local tool
policy and before conversation admission. Its current compressor is a separate model call,
and its evidence marker does not give the main model a retrieval tool. These systems should
not be treated as feature-equivalent.

Deterministic pre-tool wrappers such as RTK operate earlier still: they can rewrite a
supported shell command so less output is produced. That can coexist with Smart Prune, but
it changes the canonical source Smart Prune receives. The quality and cost of stacking both
have not been evaluated here.

Retrospective selective pruning solves a different problem. It can recover an already-full
working set, but any changed old item necessarily creates a new prefix after that point.
Admission-time and retrospective paths are therefore complementary, not interchangeable.

## 7. Limitations and next experiment

The implementation currently excludes provider-executed tools, images, audio, encrypted
content, user messages, assistant messages, reasoning, and explicit hook feedback. Token
counts used for admission are estimates. Local audits are not tamper-proof. A remote
optimizer receives eligible raw sources. Smart Prune can remove evidence the main model
would have used, so fail-open mechanics alone do not establish semantic quality.

The next decisive experiment is a matched Smart Prune OFF/ON workload with the same task,
model, settings, tools, source revision, cache conditions, and verifier. It must separately
report:

1. main-agent uncached, cached, and cache-write input tokens;
2. optimizer tokens and latency, including failed requests;
3. end-to-end wall time and realized provider cost;
4. admitted source and retained sizes;
5. task correctness and evidence recall;
6. full logical-prefix comparison at each admission boundary.

Until that study exists, fewer admitted tokens are a mechanism measurement—not proof of a
cheaper or better completed task.

## 8. Reproduction and evidence

- [Smart Prune design specification](../docs/superpowers/specs/2026-08-31-smart-prune-admission-design.md)
- [Cache validation protocol](../docs/evals/tasks/smart_prune_cache_validation/README.md)
- [2026-09-02 mechanism verification](../docs/evals/tasks/smart_prune_cache_validation/2026-09-02-mechanism-tests.md)
- [2026-09-01 live pilot](../docs/evals/tasks/smart_prune_cache_validation/2026-09-01-live-pilot.md)
- [Evaluation verdicts](../docs/evals/RESULTS.md)
- [Context and pruning behavior](../docs/context.md)
- [Prompt-cache lifecycle](../docs/prompt-caching.md)

## References

1. OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
   especially prefix matching, append-only conversation guidance, and compaction caveats.
2. Elpis, [Smart Prune live pilot](../docs/evals/tasks/smart_prune_cache_validation/2026-09-01-live-pilot.md),
   2026-09-01.
3. Headroom, [Architecture](https://github.com/headroomlabs-ai/headroom/blob/main/docs/content/docs/architecture.mdx)
   and [Context Management](https://headroom-docs.vercel.app/docs/context-management),
   accessed 2026-09-02.
