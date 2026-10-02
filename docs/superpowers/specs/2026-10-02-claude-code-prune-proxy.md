# SPEC: Smart Prune for Claude Code on the subscription (`elpis claude`)

Status: draft, 2026-10-02. Masih did not approve this spec yet. This spec replaces the
Aug 31 decision that read "Headroom" as a Codex setting
(`plans/2026-08-31-elpis-runtime-parity.md:18`).

## Goal
The command `elpis claude` starts Claude Code on Masih's own subscription. A local Elpis
proxy runs Smart Prune on each request before the request goes to Anthropic. The
dashboard shows each change that the proxy makes.

## Method
1. `elpis claude` starts a loopback proxy.
2. `elpis claude` starts `claude` as a child process, with `ANTHROPIC_BASE_URL` set to the
   proxy address. `headroom wrap claude` uses the same method.
3. The proxy forwards each `POST /v1/messages` request to Anthropic. The proxy keeps all
   headers, including the `sk-ant-oat` login token.
4. The proxy sends the response stream back to Claude Code without changes.
5. The proxy changes only the newest `tool_result` blocks in a request. The Smart Prune
   optimizer and admission rules select the admitted form of each block.
6. The proxy stores the admitted form under the `tool_use_id` of the block. In each later
   request, the proxy sends that same stored form.
7. The proxy never changes older content. Thus the cached prefix stays the same. Elpis
   uses this first-exposure rule now. Headroom uses the same rule for subscription
   traffic.
8. Move the optimizer logic from `core/src/session/smart_prune.rs` into one shared
   function. Do not make a copy of it.

## Acceptance tests
Each test has a positive case and a negative case. Show that each test can fail before
you trust it.

1. **Pass-through:** Turn pruning off. The proxy must forward a body that is
   byte-identical to the body from Claude Code. A real subscription session must complete
   a task that uses many tools.
2. **Pruning:** Put one needle fact in a tool output of 20k tokens. The proxy must
   forward a smaller block. The answer must contain the needle. The proxy must write an
   audit record. With pruning off, the block size must not change.
3. **Cache safety:** Each pruned `tool_use_id` must be byte-identical in all later
   requests. In a live run, cache reads on turn n+1 must be 90% or more of the turn n
   prompt. Remove the stored forms: this test must then fail.
4. **Fail-open:** Make the optimizer time out, or make it send a bad reply. The proxy must
   forward the original block. The turn must complete.
5. **Login safety:** After a run, `grep -r sk-ant-oat ~/.elpis` must find nothing. Logs
   and audits must not contain headers.
6. **Measured value:** Run the same fixed task 3 times with pruning off and 3 times with
   pruning on. Report tokens, cache reads, and the 5-hour quota used. Make no other cost
   claims.
7. **Dashboard:** The dashboard shows the pruned blocks, the removed tokens, and the audit
   links for each session.

## Non-goals
- Changes to older history.
- Codex clients or Gemini clients.
- Changes to the outbound path of the gateway.
- A release, a push, or this mode for other users.

## Rollback
Run plain `claude`. The proxy does not change the Claude Code configuration. Do the work
in a new worktree, `Elpis-wt/claude-proxy`, from `next@28ae2ce3`. To revert, remove that
one branch.

## Decisions for Masih
- **Optimizer model:** Use the current Elpis `/pruner-model` setting (recommended). This
  option needs no new key. The other option is a Claude model through the same login.
- **Terms risk:** I found no Anthropic statement that permits subscription traffic through
  a proxy that changes requests. Headroom does this, but that is not permission. Use this
  mode only for personal work.
- **GUIDE R11:** R11 says that Elpis does not support a Claude subscription runtime.
  Change R11 only after Masih accepts this feature.
