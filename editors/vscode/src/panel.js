'use strict';
const crypto = require('node:crypto');
const wordmark = require('./brand');
function panelHtml(vscode, webview, extensionUri) {
  const nonce = crypto.randomBytes(24).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/style.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/chat.js'));
  const markdown = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/markdown-it.min.js'));
  const rendering = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/messages.js'));
  const followups = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/followups.js'));
  const slash = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/slash.js'));
  const ledger = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets/ledger.js'));
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>Elpis</title></head>
<body><main class="relative h-screen flex flex-col max-w-3xl mx-auto px-4">
<header class="flex items-center gap-2 py-3 shrink-0"><h1 class="font-semibold text-base flex-1">Elpis</h1>
<button id="ledger-open" class="btn btn-sm btn-ghost" type="button" aria-controls="context-ledger" aria-expanded="false">Context</button>
<button id="history" class="btn btn-sm btn-ghost" type="button" title="Search previous editor chats">History</button>
<button id="reconnect" class="btn btn-sm btn-ghost btn-square" type="button" aria-label="New chat" title="Start a new conversation and reconnect">＋</button>
<button id="more" class="btn btn-sm btn-ghost btn-square" type="button" aria-label="Chat settings" aria-expanded="false" aria-controls="settings">⋯</button></header>
<section id="context-ledger" class="hidden shrink-0 max-h-[40vh] overflow-y-auto border border-base-300 rounded-box p-3 mb-2" aria-label="Context Ledger">
<div class="flex items-center gap-2"><h2 class="font-semibold flex-1">Context Ledger</h2><button id="ledger-close" type="button" class="btn btn-xs btn-ghost" aria-label="Close Context Ledger">Close</button></div>
<p id="ledger-context" class="text-sm py-2">Context usage not yet reported.</p>
<div class="flex items-center gap-2"><span id="smart-pruning-state" class="text-sm flex-1">Smart Pruning: waiting for runtime</span><button id="smart-pruning-toggle" class="btn btn-xs" type="button" disabled>Enable</button></div>
<p class="text-xs opacity-70 py-2">Experimental · fresh output compression · existing prefix preserved. Optimizer usage costs extra; — means not reported.</p>
<dl id="ledger-pruning" class="text-xs space-y-1"></dl><p id="ledger-attempt" class="text-xs py-2"></p>
<details class="collapse collapse-arrow bg-base-200"><summary class="collapse-title text-sm min-h-0 py-2">Context sources · estimated tokens</summary><div class="collapse-content text-xs"><dl id="ledger-attribution" class="space-y-1">Not yet reported.</dl></div></details>
<details class="collapse collapse-arrow mt-2"><summary class="collapse-title text-sm min-h-0 py-2">Goal</summary><div class="collapse-content"><p id="ledger-goal" class="text-xs whitespace-pre-wrap py-2">No goal loaded.</p><label class="text-xs">Objective<textarea id="goal-objective" class="textarea textarea-sm w-full" rows="2"></textarea></label><button id="goal-save" class="btn btn-xs mt-2" type="button">Set goal</button><button id="goal-clear" class="btn btn-xs btn-ghost mt-2" type="button">Clear goal</button></div></details>
<p id="ledger-status" class="text-xs py-1" role="status"></p></section>
<section id="history-panel" class="hidden absolute inset-x-0 top-14 bottom-0 z-30 bg-base-100 p-3 overflow-y-auto" aria-label="Chat history">
<div class="flex items-center mb-3"><h2 class="font-semibold flex-1">Editor chats</h2><button id="history-close" class="btn btn-sm btn-ghost" type="button">Close</button></div>
<button id="history-archived" class="btn btn-xs btn-ghost mb-2" type="button" aria-pressed="false">Show archived</button>
<input id="history-search" class="input input-sm w-full" aria-label="Search recent chats" placeholder="Search this project's chats…">
<p id="history-status" class="text-xs opacity-70 py-3" role="status"></p><ul id="history-list" class="menu menu-sm w-full"></ul><button id="history-more" class="btn btn-sm btn-ghost hidden" type="button">Load more</button>
</section>
<div id="settings" class="hidden flex-wrap gap-1 pb-3 shrink-0"><button id="provider" class="btn btn-xs btn-ghost" type="button">Provider</button><button id="key" class="btn btn-xs btn-ghost" type="button">API key</button><button id="runtime" class="btn btn-xs btn-ghost" type="button">Runtime</button><button id="prune" class="btn btn-xs btn-ghost" type="button">Enable Smart Pruning</button><button id="open-settings" class="btn btn-xs btn-ghost" type="button">Settings</button><button id="open-config" class="btn btn-xs btn-ghost" type="button">Open config.toml</button></div>
<section id="conversation" class="flex-1 min-h-0 overflow-y-auto py-4" aria-label="Conversation">
<div id="welcome" class="h-full flex flex-col items-center justify-center text-center gap-3 pb-10">${wordmark}<h2 class="text-xl font-semibold">What are we building?</h2><p class="text-sm opacity-70 max-w-xs">Ask about your code, work through a problem, or make a change together.</p></div>
<div id="messages" role="log" aria-live="polite"></div></section>
<footer class="shrink-0 pb-3 pt-2"><div id="status" class="text-xs opacity-70 pb-2 min-h-6 break-all" role="status" aria-live="polite">Ready</div>
<section id="queued-panel" class="hidden mb-2 text-xs" aria-label="Queued follow-ups"><div class="flex items-center justify-between"><span id="queue-status"></span><button id="resume-queue" class="btn btn-xs btn-ghost hidden" type="button">Resume queue</button></div><ul id="queued-list" class="max-h-32 overflow-auto"></ul></section>
<form id="composer" class="relative rounded-2xl border border-base-300 bg-base-200 p-2"><label for="prompt" class="sr-only">Message Elpis</label><textarea id="prompt" class="textarea textarea-ghost w-full border-0 bg-transparent resize-none focus:outline-none text-sm min-h-20" rows="3" placeholder="Ask Elpis anything about this project…" required></textarea>
<div class="flex items-center gap-1 pt-1">
<ul id="slash-menu" class="hidden menu menu-sm absolute bottom-full left-0 right-0 mb-2 z-30 max-h-[min(18rem,calc(100vh-14rem))] overflow-y-auto flex-nowrap rounded-2xl border border-base-300 bg-base-100 shadow-lg p-2" role="listbox" aria-label="Slash commands"></ul>
<details id="permissions-picker" class="dropdown dropdown-top static! shrink-0">
<summary id="approval-mode" class="btn btn-sm btn-ghost btn-square" aria-label="Permissions: Ask" title="Permissions: Ask"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/></svg></summary>
<div class="dropdown-content z-20 mb-2 left-0 w-72 max-w-full rounded-2xl bg-base-100 border border-base-300 shadow-lg p-2" aria-label="Permissions">
${[['ask','Ask for approval','Review edits before applying them.'],['auto','Approve for me','Allow workspace edits; review other requests automatically.'],['full','Full access','Allow commands and edits outside this project.']].map(([id,label,description])=>`<button type="button" data-permission="${id}" class="btn btn-ghost h-auto min-h-10 w-full justify-start text-left py-2"><span><span class="block">${label}</span><span class="block text-xs font-normal opacity-70 whitespace-normal">${description}</span></span></button>`).join('')}
</div></details>
<details id="thinking-picker" class="dropdown dropdown-top static! shrink-0">
<summary id="thinking" class="btn btn-sm btn-ghost btn-square" aria-label="Thinking: Default" title="Thinking: Default"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 18V5a3 3 0 0 0-5.8-1A4 4 0 0 0 3 10a4 4 0 0 0 1 7.5A4 4 0 0 0 12 18Zm0-13a3 3 0 0 1 5.8-1A4 4 0 0 1 21 10a4 4 0 0 1-1 7.5A4 4 0 0 1 12 18M7 8c0 2-1 3-3 3m13-3c0 2 1 3 3 3M7 16c2 0 3-1 3-3m7 3c-2 0-3-1-3-3"/></svg></summary>
<div class="dropdown-content z-20 mb-2 left-0 w-64 max-w-full rounded-2xl bg-base-100 border border-base-300 shadow-lg p-3"><div id="thinking-status" class="text-xs opacity-70">Loading thinking levels…</div><label id="effort-label" class="hidden text-xs">Thinking level<select id="effort" class="select select-sm w-full mt-1" aria-label="Reasoning effort"></select></label></div></details>
<div class="flex-1"></div>
<details id="model-picker" class="dropdown dropdown-top dropdown-end static! min-w-0 max-w-[65%]">
<summary id="model" class="btn btn-sm btn-ghost min-w-0 max-w-full truncate" title="Choose model and reasoning effort">Choose model ▾</summary>
<div id="model-menu" class="dropdown-content z-20 mb-2 right-0 w-72 max-w-full max-h-[calc(100vh-14rem)] overflow-y-auto rounded-2xl bg-base-100 border border-base-300 shadow-lg p-2">
<p class="text-xs opacity-60 px-2 py-1">Select model</p><input id="model-search" class="input input-sm input-ghost w-full" aria-label="Search models" placeholder="Search models…">
<p id="model-status" class="text-xs opacity-70 px-2 py-1" role="status"></p><ul id="model-options" class="menu menu-sm w-full max-h-60 overflow-y-auto flex-nowrap"></ul>
<ul class="menu menu-sm w-full"><li><button id="custom-model" type="button">Custom model ID…</button></li><li><button id="menu-provider" type="button">Change provider…</button></li></ul>
</div></details>
<button id="send" class="btn btn-sm btn-circle shrink-0 bg-base-content text-base-100 border-0 shadow-none hover:opacity-80" type="submit" aria-label="Send message" title="Send message"><svg id="send-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg><svg id="send-stop" class="hidden" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button></div></form>
<div id="context-usage" class="hidden text-xs opacity-70 pt-2" role="status"></div>
<div class="flex items-start justify-between gap-2 pt-2 text-xs opacity-60"><span id="identity" class="truncate">Your project, in context</span><span id="review-policy" class="shrink-0" title="Editor-buffer edits are never auto-saved">Review before edits</span></div>
</footer></main><script nonce="${nonce}" src="${markdown}"></script><script nonce="${nonce}" src="${rendering}"></script><script nonce="${nonce}" src="${followups}"></script><script nonce="${nonce}" src="${js}"></script><script nonce="${nonce}" src="${slash}"></script><script nonce="${nonce}" src="${ledger}"></script></body></html>`;
}
module.exports = { panelHtml };
