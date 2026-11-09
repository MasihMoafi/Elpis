import { laterRetainedPins, pageRemovalApproval } from "./renderer-evidence-retained-later.mts";

export { pageRemovalApproval };
import type { Pin } from "./renderer-evidence-pins.mts";


export const retainedUpdates: Record<string, Record<string, Pin>> = {
    "988aad0e78bd264c00e435be07598e79f08941e8": {
        "tests/controls.cjs": {
            "blob": "078c3475929479318cba0e93192cb3ec6c41418d",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Shared helpers for the deliberate 27 Oct changes: openPatterns (Workflows patterns open from the pattern menu) and rowAction (row Pin/Bookmark/Archive moved into the row's menu, 577d5a5ad, R83). Existing helpers unchanged."
        },
        "tests/sidebar.test.cjs": {
            "blob": "5bc4e7a4f4e0b4029e2b53f0a7ca6e473045bd83",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/sidebar-parity.test.cjs": {
            "blob": "8d0fc28e1983d5b499590637dfdbdff6a7640721",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/settings-rows.test.cts": {
            "blob": "3abeb2f5135a214f1da4d42a24a0116aa2f963cb",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/project-membership.test.cjs": {
            "blob": "0821088899f85ff02c5eec05fdb6dc76b5dde459",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/gray-shadows.test.cjs": {
            "blob": "7c1c7eca3f806305ab2d405009f2fea563ea2fbe",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/context-menu.test.cjs": {
            "blob": "80ebe7fc9abb7062a27fe24d64ab24789354ed21",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/composer-files.test.cjs": {
            "blob": "d9a5f4a3786f411d91210353bca2179e22d86811",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/chat-worktree.test.cts": {
            "blob": "1cc85cebd18d3e584f71b73410f1771c5251205d",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/input-hints.test.cts": {
            "blob": "3629e6b86ba60fc40a64b62bc4922c9eac2aa7b3",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/hud-language.test.cjs": {
            "blob": "fbbecd45443a757f6269312701aa222854300e26",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/desktop-sweep.test.cjs": {
            "blob": "4e764bbd85e785b650ff87c831045f9b6ffd2a76",
            "approval": "4778be07db9e766833b6797f1884f05dd9666cd1",
            "reason": "Masih 27 Oct (takeover list): \"Settings grouped as ChatGPT's (Personal, Integrations, Coding, Archived)\", built in d79d50cbe, with Browser settings added in c5e2a69fc. The sweep visits the pages in that order; its checks are unchanged."
        },
        "tests/history-paging.test.cts": {
            "blob": "1d5a27b96dd6ee101bb2953ba0e4405d14c30a6f",
            "approval": "7f37528ca78fffdfdd84ff7b8ea796d3faea772c",
            "reason": "Masih 27 Oct: Load earlier messages is stuck against the transcript; use the ChatGPT spacing reference. Extend the retained history owner to assert a readable gap while preserving complete pagination, retry, compaction and scroll behavior."
        },
        "tests/session-windows-electron.test.cjs": {
            "blob": "da274747d46f1ba3dd1755710a3830c1ca70f24c",
            "approval": "54442dcc73bbc892e6771cf881d43a03141affae",
            "reason": "Masih 27 Oct: restore the automatic orange completion/unread marker to the left; manual colour remains separate. Show observed Mother and recursively spawned live team despite a saved failure, keep recorded model evidence historical, and prevent duplicate recovery. Settings must fit beside navigation, hide unsupported Flex, show whole sidebar rows, and simplify chat actions into Organize/Open in with correct singular/bulk wording. Retain paging, keyboard, storage, action outcomes, isolation and alignment; shared test callers follow the same moved submenu actions. Immutable baseline retained."
        },
        "tests/chat-files.test.cts": {
            "blob": "585462a3d0f2a987f2a1c49283fce040dd4f94f6",
            "approval": "cfb6ed796d1598377c58dd370b93bfdf06294ef3",
            "reason": "Masih 27 Oct: HTML documents render with project-local computation; large text remains readable without a huge editor; cards and selected passages support explicit review/edit/removal feedback without sending unfinished text; secondary composer options collapse instead of wrapping; Fast feedback follows confirmed state and chat scope. Preserve existing file-save, PDF, image, chat and slash-command contracts; replace obsolete 512KB rejection expectations with bounded preview proof. Retain the original baseline."
        },
        "tests/canvas-father.test.cts": {
            "blob": "78c1053e9cf7bc9fa66af647dbc7a4e254b6030e",
            "approval": "83d8782efe44951a031ad62e860228650d5d070f",
            "reason": "Masih 27 Oct: workflow History dismisses outside/on Escape; new drafts remain available during active runs; sandbox and project selection preserve the board; saved runs show their actual team in chat and both views; remove redundant sidebar colour dots; Ctrl/Cmd+A follows explicit board or editor focus. Retain existing behavior checks, aim node-selection journeys at the focused board, and add focused recovery/identity regressions without advancing the retained baseline."
        },
        "tests/browser-annotate.test.cjs": {
            "blob": "88b44997918eb5dc9be9ab7af5764843e6ec5934",
            "approval": "8e43b6441294365f45d1193358c47cfb0a68da00",
            "reason": "Masih 27 Oct: add real modal/popover annotation without activation or dismissal, and normal interaction after leaving; retain click, drag, text, Space, Escape, marker and inner scrolling checks."
        },
        "tests/matilda.test.cts": {
            "blob": "91b427823fa751477a298c386695d381a9103714",
            "approval": "8e43b6441294365f45d1193358c47cfb0a68da00",
            "reason": "Masih 27 Oct: an open editor is unfinished even after pasting and long pauses. Supersede forced closure by replies; prove complete dispatch after editing ends, focus during late reply and pending-note retention after cancelled queued picture dispatch. Retain drawing, persona and provider-failure checks."
        },
        "tests/love-spot-voice.test.cjs": {
            "blob": "b271d4fcd3712681579216bdd94a94a640069260",
            "approval": "4888c4c4fbd7fcaeb8eb03a2519a97a525c4e7eb",
            "reason": "Masih 27 Oct: hide unavailable board/chat audio instead of disabled controls; retain text, persona, ordinary read-aloud and zero audio-I/O proof. Masih permits hiding unusable read aloud. Ordinary and Love Spot read aloud are unavailable; retain no-audio I/O, text and independent realtime/dictation checks."
        },
        "tests/voice.test.cjs": {
            "blob": "e30ee5d07af1f8cfa5750ade10c67692a54cf4e2",
            "approval": "4888c4c4fbd7fcaeb8eb03a2519a97a525c4e7eb",
            "reason": "Masih 27 Oct: hide unavailable audio during Love Spot and unresolved origin. Preserve ordinary audio positives, positively prove resolved ordinary voice, and retain zero microphone, peer and audio-request boundaries. Masih explicitly permits hiding unusable read aloud and prohibits another API-key service. Assert hidden controls and zero warming/read requests for ordinary and Love Spot chats; retain realtime microphone/Voice and dictation boundaries. No playback success claimed."
        },
        "tests/workflows-wf1.test.cjs": {
            "blob": "2b6c5657424d13bd4cf9be425a7b4852925ba31f",
            "approval": "71e0791d2582c383bf32653d2bd7c984f743f34a",
            "reason": "Masih: reconnect and other errors must not appear at the top. Replace only the superseded A30 header-placement expectations with contained bottom placement and an actual non-empty Run description. Preserve both themes, provider refusal, long permission refusal, actionable guidance, responsive toolbar fit, failed-agent explanation, successful retry and stale-error clearing. The real packaged-app refusal sibling follows the same policy; the immutable baseline is unchanged."
        },
        "tests/canvas-keys.test.cjs": {
            "blob": "d8de165da14a0db6cca9cc79d5a0edbe4f89f4c3",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas.test.cjs": {
            "blob": "06c91ef4caa491773f1100238a243a0d9b6197d4",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas-runlog.test.cts": {
            "blob": "8572492d5017dee8569fbb5898635ee3f1d2fed3",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas-run.test.cts": {
            "blob": "acf1b1e2e9ff45144f2157d71f8d8c0b434ea8ab",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas-fit.test.cjs": {
            "blob": "6ce93aee945babbfb7003b0fa46e84051c2cac87",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas-editing.test.cjs": {
            "blob": "1caab2c6902a3aa2adab4d2c7e81398ec79e8219",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/canvas-basics.test.cjs": {
            "blob": "54b7bb8727bd406a59b202e730e7ece08d441525",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/agents-guide.test.cts": {
            "blob": "687320f691ddbd7befb4544df081ec10f1daad61",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/message-replies.test.cjs": {
            "blob": "ceb18b7e8955deb65424364642e897435e52afa8",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"Please fix them all\". Follow deliberate 27 Oct changes: row hover Pin/Bookmark/Archive moved into the row's menu (577d5a5ad, R83) and Move to project under Organize (54442dcc7); Colour in chat menus (577d5a5ad, R84, SPEC C8); an idle ring is not a status (R8); Settings grouped as ChatGPT's and centred (d79d50cbe); Stop plain in both themes (00996c210, R22); the message fold wrapper (540411af9); agent rows show their mark and model (d832d5067). Assertions are kept or made stricter."
        },
        "tests/browser-sessions-electron.test.cjs": {
            "blob": "00d3acaca69921e0267e1bd84c1eeb5dd4c3120a",
            "approval": "54442dcc73bbc892e6771cf881d43a03141affae",
            "reason": "Masih 27 Oct: restore the automatic orange completion/unread marker to the left; manual colour remains separate. Show observed Mother and recursively spawned live team despite a saved failure, keep recorded model evidence historical, and prevent duplicate recovery. Settings must fit beside navigation, hide unsupported Flex, show whole sidebar rows, and simplify chat actions into Organize/Open in with correct singular/bulk wording. Retain paging, keyboard, storage, action outcomes, isolation and alignment; shared test callers follow the same moved submenu actions. Immutable baseline retained."
        },
        "tests/agent-runs.test.cts": {
            "blob": "8747becd55e0f0c09fa77d9cfd126bab7cbad6a2",
            "approval": "d4e60534ad52abd70aa226157bb81158f40a61eb",
            "reason": "Masih 7 Nov: show the model and effort as a small grey line under each agent's name in the Agents panel and at the top of the subagent's own chat. The earlier agent-runs checks remain."
        },
        "tests/provider-model-pairs.test.cjs": {
            "blob": "7ff79e8b177209d1a98a22bdfae21bfc0c12230d",
            "approval": "96d930ab47a8a36242a04571dbd711d96af69903",
            "reason": "Masih 8 Nov: Anthropic first, OpenAI second, in the model picker's vendor tabs; the default no longer has to be the first tab. Wait for the configured provider default, its actual credits and enabled Send before exercising routing. Do not reselect a model. Preserve every default, provider, model, pointer, keyboard and request assertion; the earlier generic Model-visible check ran before settings and connection finished."
        },
        "tests/love-clarity.test.cjs": {
            "blob": "343243034b042a795b34100d50c595f2783c598d",
            "approval": "8e43b6441294365f45d1193358c47cfb0a68da00",
            "reason": "Masih 26 Oct: visiting Love Spot or its chat acknowledges its badge; ordinary chats do not, and later replies notify again. Unverified audio stays unavailable. Give workflow history its own coordinator so the ordinary chat remains ordinary. History and Workflow history follow recoverable history in 902db1c84; retain progress, palette, no-load-notification and both-theme checks. Masih 27 Oct: hide unavailable Love Spot audio instead of disabled controls; preserve unread acknowledgement, ordinary chat and workflow checks."
        },
        "tests/workflow.test.cjs": {
            "blob": "dc6fe5ff3626c0363b97c62e6972c5a9a08e640e",
            "approval": "7a19cf90b5ce045120324b91b7279fbd89fa5964",
            "reason": "S34, Masih 26 Oct: disconnected Elpis must still allow typing and saved drafts. Supersede the disabled-composer expectation; retain uncertain delivery, stale approvals, authoritative history, bottom notice geometry and all six A125 recovery cases. Exercise the real desktop store through an explicit shared browser context, clear the slash draft before empty-draft shell entry, and assert offline permissions, effort, folder and Stop cannot mutate the runtime. Keep every existing assertion and timeout. Masih overnight stability request, 26 Oct: exercise transient launch-token recovery, exact saved/edited draft ownership and restored Undo. Preserve all six A125 recovery cases and all prior refusal, delivery and offline-mutation assertions."
        },
        "tests/chat-activity.test.cjs": {
            "blob": "66400bde9db7f3b84cd15e2eeb211c8ac89ac1bb",
            "approval": "d7df305f1efcbfb9cbb7227e0ff1d9bb73c552f2",
            "reason": "Wait for opened folded work and its activity body before selecting a tool; scope the long group to that finished turn so a still-loading fold cannot select the live group. Preserve every collapse, focus return, keyboard reopening and reduced-motion assertion. Masih 29 Oct: \"I explicitly told you to create a parity of chatgpt app ... map every style feature of chatgpt app into a clear spec that's reusable and make our design match it\" (specs/chatgpt-chat-style.md). Inline code keeps the reply's ink on a 6% chip; the working rotor is checked at the turn's foot (Masih 29 Oct: \"you can see the working animation changes its place!\"). Every other assertion remains."
        },
        "tests/composer-consistency.test.cts": {
            "blob": "b33d5c98abbd8ac1b34c7023a7e71bf02af10ac6",
            "approval": "9cfbfc1f07861e4b86ec4b3bf36f62dd63914ac3",
            "reason": "Masih 27 Oct: retain one-row narrow controls and visible thinking, and extend the same idle/running owner check to preserve draft height during width-only resize; both negative cases reproduced before the repair. Immutable baseline retained."
        },
        "tests/love-spot-sync.test.cjs": {
            "blob": "48eaf184b0b76f7279186c538310a5e5c0130e4d",
            "approval": "9f5a612d1d2f2a17850a3a457b1f815724d2568e",
            "reason": "Preserve all six real sync cases, deletion/Undo/save assertions and budgets. Prove the held-event key listener fired and report bounded source/element-version diagnostics on failure; no product seam was added. Run40273131811 proved the target deleted while legitimate reply elements arrived: require the target tombstone on disk and absence live, preserve every other saved live element, and retain both Undo assertions."
        },
        "tests/arrow-keys.test.cts": {
            "blob": "ff143709412619c6e98bbe550e354e55666856ef",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/workflow-provenance.test.cjs": {
            "blob": "493f54ef103baef8e7a105c1cdedd4f14a5ab86e",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/step-sentences.test.cts": {
            "blob": "35c9d36d67b257d1e3a40ad72e26c3fc76cbdf81",
            "approval": "dcf3b67c6df4340a3edbe285658f3069be456e83",
            "reason": "Wait for each opened lazy activity body before reading all finished sentences; every sentence and pointer/keyboard disclosure assertion remains. S36/R74, Masih 26 Oct: hide empty Reasoning and missing-summary placeholders. Replace obsolete empty-disclosure pointer/keyboard cases with saved-empty to streamed-summary to recorded-content lifecycle proof; preserve real-summary pointer/keyboard in both themes, working status, disclosure and exact code-copy assertions. Raw history remains unchanged. Masih 29 Oct: \"you can see the working animation changes its place!\". The working mark has one place, the turn's foot; a running row keeps its sentence and ticking timer without a mark. Every other assertion remains."
        },
        "tests/night-workflows.test.cts": {
            "blob": "b7a51ea7c95482c50d29d9c0fd67ee0e360eece7",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "Retain the installed workflow simplification from 141be35a2d4e0ff10691bf670b759eecba52947d: plain agents replace removed character artwork. Preserve all five numbered patterns, editable prompts, Escape/typing, colour and no-portrait checks in both canvas views."
        },
        "tests/side-panel-fit.test.cts": {
            "blob": "4aaab9ec786c3ccc4f66793023e1f6c83c01ef44",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "A217 starts the panel at sidebar width. Expand before testing a full interior retreat so the test is not measuring its 200px minimum clamp; preserve cancellation, retreat, minimum and keyboard checks."
        },
        "tests/mode-cycle.test.cts": {
            "blob": "99d7b5310fd5c4e6a58a82153c0c261ecb62a79a",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "A233/A251 makes Full access the shared initial default. Preserve the complete Shift+Tab Ask, Approve and Plan cycle and composer focus."
        },
        "tests/menus.test.cjs": {
            "blob": "74fe5b7ac62917739dadb7f534cea343a28294e8",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "Approved live effort selection persists immediately through the effort route. Preserve pending model choice, immediate effort write and exact next-message payload, plus all model/menu/no-send assertions."
        },
        "tests/ux-everyday.test.cjs": {
            "blob": "714e4229cca37f06db68667a544ddc3be7e13fde",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "Approved live effort selection persists immediately through the effort route. Preserve queue model, effort and Plan choices and all focus, send and everyday-use assertions."
        },
        "tests/effort-shortcuts.test.cts": {
            "blob": "feb1e6ad351494b73744bb12817951513830f5dc",
            "approval": "83d8782efe44951a031ad62e860228650d5d070f",
            "reason": "Masih 27 Oct: workflow History dismisses outside/on Escape; new drafts remain available during active runs; sandbox and project selection preserve the board; saved runs show their actual team in chat and both views; remove redundant sidebar colour dots; Ctrl/Cmd+A follows explicit board or editor focus. Retain existing behavior checks, aim node-selection journeys at the focused board, and add focused recovery/identity regressions without advancing the retained baseline."
        },
        "tests/composer-keys.test.cjs": {
            "blob": "1523a01cb5fdef7b35d63f309a39b6523890650b",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "Historical turns defer off-screen content. Scroll the actual visible placeholder before requiring its message; keep newest drawn, oldest skipped, navigation and no-send assertions."
        },
        "tests/follow-up-queue.test.cts": {
            "blob": "dc96a06c9ed8415f75b66d86de2f58f47ee18a93",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "S35 persistent menubar items are separate from popup choices. Keep exact send choices and all queue stack, send-now, remove and clear behavior checks."
        },
        "tests/claude-composer.test.cts": {
            "blob": "cd00617e4219835bb46d26180f2af7a230e6aef3",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "S35 persistent menubar items are separate from popup choices. Keep the exact composer actions and all command, plan, keyboard and no-send checks."
        },
        "tests/attachments-ui.test.cjs": {
            "blob": "2ff5c5456372c9a7d9cb912730f8329b7eda7c2e",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "S35 persistent menubar items are separate from popup choices. Scope the exact attachment menu inventory to the open popup, preserving every file, image, cap and send assertion."
        },
        "tests/bypass-permissions.test.cts": {
            "blob": "d7a671a20e6c94a584c931d6fdf69615280ee1ce",
            "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
            "reason": "A233/A251 makes Full access the shared default. Keep Bypass red, distinct and confirmed, Cancel lossless, managed refusals and immediate apply. Scope exact popup choices away from the S35 persistent menubar."
        },
        "tests/canvas-iso.test.cjs": {
            "blob": "af44aed6624b1bb3e9f5a30b877f7f577c383d49",
            "approval": "af885eb4978ee37e98e1df11423d545be9a1c75f",
            "reason": "Masih 27 Oct: \"it's ugly; showing all sorts of things it shouldn't. The workflow particularly.\" then \"Please fix them all\". Workflows drops Kahn's order, the critical path, the reading list, the key strip and wave labels (SPEC.md Workflows, Removed); the minimap starts hidden; the run clock is a small time in the header; patterns open from the pattern menu and the guide sits under the board. Only assertions on removed elements changed; the rest are kept."
        },
        "tests/sidebar-creators.test.cts": {
            "blob": "35ac127fbcbb9dfb093a482bdbe68147a272b88f",
            "approval": "75d7eca37cc07cf92a9a648dcaeb0fbda7607b2e",
            "reason": "Masih 29 Oct: \"those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in my side-bar chats. I want that place to be organized\". S18: Pinned, Projects, Groups and Recents list only his chats; Background runs and the sidebar Workflows section are off by default, so this test turns them on (orphans and broken-lineage chats are reached in Background runs)."
        },
        "tests/browser-panel.test.cjs": {
            "blob": "beb411ca81a0cd2b14cc7b02944b1c9dc023d446",
            "approval": "8e43b6441294365f45d1193358c47cfb0a68da00",
            "reason": "A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks. Masih 27 Oct: add Shift/Ctrl/Cmd selection, grouped icon menu, close selected/other/right, real URL sidebar pins, rename/mute, compact empty pane after full view and preserved resized content. Retain previous panel and annotation checks."
        },
        "tests/terminal.test.cjs": {
            "blob": "14e55e4206d18fce9fe4cb763e3b7a1d79da8480",
            "approval": "54442dcc73bbc892e6771cf881d43a03141affae",
            "reason": "Masih 27 Oct: restore the automatic orange completion/unread marker to the left; manual colour remains separate. Show observed Mother and recursively spawned live team despite a saved failure, keep recorded model evidence historical, and prevent duplicate recovery. Settings must fit beside navigation, hide unsupported Flex, show whole sidebar rows, and simplify chat actions into Organize/Open in with correct singular/bulk wording. Retain paging, keyboard, storage, action outcomes, isolation and alignment; shared test callers follow the same moved submenu actions. Immutable baseline retained."
        },
        "tests/slash-commands.test.cjs": {
            "blob": "b6b486313c74dece38a1043cde7aa98f2c226370",
            "approval": "577d5a5ad4eba08326c323a18b5ca4579a12c53d",
            "reason": "Masih 27 Oct: right-click Colour tints the row, no palette or duplicate inline actions; keep automatic status and hover geometry stable. Avatar opens an independent pet-size chat; music only mutes/unmutes. Keep chat navigation idempotent, workflow columns aligned, and /clear starts fresh context in the same folder without deleting history. Retain persistence, keyboard, drafts, failure and lifecycle assertions. Immutable baseline unchanged."
        },
        ...laterRetainedPins,
    }
};
