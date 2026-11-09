import type { Pin } from "./renderer-evidence-pins.mts";

export const pageRemovalApproval = {
    "approval": "da53b1661b8a8fd5de09925b7ec86fd4ce0bb747",
    "reason": "OBSRM, Masih 21 Oct 22:45: \"remove it; remove the observability page - keep its logo icon as it looks good. the rest, remove.\" Preserve the remaining navigation checks."
};

/** The later half of the retained pins for the deployed baseline. */
export const laterRetainedPins: Record<string, Pin> = {
    "tests/config-navigation.test.cts": {
        "blob": "92d665dcbd354456c0a58778e07d4472b0d97891",
        "approval": "d79d50cbe1a12493c903d5a2b3bf3f87ff5c4348",
        "reason": "Masih 27 Oct: Settings is grouped as ChatGPT's (Personal, Integrations, Coding, Archived); the old category names remain /config aliases and still open working pages."
    },
    "tests/workflow-polish.test.cjs": {
        "blob": "b386a441853714121252ae4a4a42356496cba417",
        "approval": "75d7eca37cc07cf92a9a648dcaeb0fbda7607b2e",
        "reason": "Masih 29 Oct: \"those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in my side-bar chats. I want that place to be organized\". S18: Pinned, Projects, Groups and Recents list only his chats; Background runs and the sidebar Workflows section are off by default, so this test turns them on (orphans and broken-lineage chats are reached in Background runs)."
    },
    "tests/sidebar-groups.test.cjs": {
        "blob": "ef2e3c25494e2ceb0c2dc87748e9c7959d369415",
        "approval": "75d7eca37cc07cf92a9a648dcaeb0fbda7607b2e",
        "reason": "Masih 29 Oct: \"those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in my side-bar chats. I want that place to be organized\". S18: Pinned, Projects, Groups and Recents list only his chats; Background runs and the sidebar Workflows section are off by default, so this test turns them on (orphans and broken-lineage chats are reached in Background runs)."
    },
    "tests/workflow-observer.test.cts": {
        "blob": "ce9413f242253cf0c57d89cb9a3ec5d7532270c4",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "Masih 24 Oct: all chats must already be collapsed every time. Open the parent branch before using its children; retain collapse/keyboard, exact attachments, failed sends, observation and no-write checks."
    },
    "tests/chat-edits.test.cts": {
        "blob": "6a103a535903e9c2acfe88c8798a6d8829fabc97",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "TESTING.md: wait for observable states. Await opened lazy transcript bodies and prune rows before counting them; retain exact content, ordering and failure assertions."
    },
    "tests/smart-prune.test.cjs": {
        "blob": "cdf2e920832420bb3e8ddba6f4ce9f8b676f2639",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "TESTING.md: wait for observable states. Await opened lazy transcript bodies and prune rows before counting them; retain exact content, ordering and failure assertions."
    },
    "tests/side-empty.test.cjs": {
        "blob": "24d9a4e52ca626605eba8680b8d376e2ecaf23a2",
        "approval": "846d842e321f25a45259ae8239f3b16a7b7511dc",
        "reason": "GOAL, Masih 24 Oct: \"/goal doesn't exist here btw. it should obviously; along with the ES.md and context files should be visible in the tab right.\" Context is the fifth panel action; retain the existing minimum-width and overflow checks for every button."
    },
    "tests/browser-drawing.test.cjs": {
        "blob": "552619f4f4a3285a0f277e639c9fdead604fba4d",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "Masih, 23 October 2026: “There is no way to close this menu that pops up, and in the draw mode I can't come to the chat here.” “Directly in the chat, next to your message.” Replace obsolete focus confinement with Style and lossless Chat/Resume; retain capture, attach, discard, theme and portrait identity checks. Masih, 23 Oct: the palette \"should be somewhere in this\" style panel, and the opacity number was \"visually wrong\": the toggle sits in the panel, and the opacity value stays under its slider after the panel reopens. A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/love-spot-identity.test.cjs": {
        "blob": "590784520a49677a2d6bb968735797224c5fd17d",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "Masih, 23 October 2026: “There is no way to close this menu that pops up, and in the draw mode I can't come to the chat here.” “Directly in the chat, next to your message.” Replace obsolete focus confinement with Style and lossless Chat/Resume; retain capture, attach, discard, theme and portrait identity checks. Matilda uses her approved circular embedded SVG portrait; retain rendered identity and reject altered portrait/circle geometry."
    },
    "tests/code-opens.test.cjs": {
        "blob": "eeb0761006b96eb06f2032ff8abb4bd7ab54cbaa",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/customize-description-fit.test.cts": {
        "blob": "c362d6ee69d60ef7bd388b698a29fd7faa36dceb",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/github-connector.test.cjs": {
        "blob": "93524667970c3a5ffa4e49ee15b44b6392d75894",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/ledger-page.test.cjs": {
        "blob": "3f08e4309e6681b9b8b861bc234fa259486a97bb",
        "approval": "e65e0f06f4235f85318c2cb3ce29ef844a720a65",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/page-column-app.cts": {
        "blob": "e9ddbc3d5d0f6cb916b4d862151c54d39bd4a2a5",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/page-column.test.cjs": {
        "blob": "2531b596a69db78f6181c8a70c60474375d8d0f3",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/view-boundaries.test.cts": {
        "blob": "ad77f2a2298ae388279ba3a26b20f0b63a1b408d",
        "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
        "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name). S35, Masih 25 Oct screenshot: the close control belongs at the right of the Elpis brand. Measure brand/close bounds in that order, retaining SVG, width and both-theme clipping checks."
    },
    "tests/parity-fixture.cjs": {
        "blob": "44694b5719704e95b1c7fba530c04f1c1b3a4522",
        "approval": "dce66fe44a2b357a4c21050a68bcc824e524a332",
        "reason": "LOVEVOICE, Masih 24 Oct: feed a recorded WAV as the microphone; measure first audio actually played; tests headless. Allow explicit Chromium capture arguments for real media tests while preserving every existing fixture default and assertion. Love Spot, Masih 26 Oct: disable unavailable audio. Emit the actual server protocol's initial empty board scene, and allow a held scene/error event to verify that unknown legacy chat origins cannot warm or launch audio; keep ordinary chat audio proof after resolution and all existing fixture routes. Install the virtual clock before navigation so app timers share one clock; test navigation within one second rather than binding to the implementation's debounce duration. R73, Masih 26 Oct: custom recursive-tree fixtures can name their visible initial root for startup readiness. Existing chat-a default, connection, hydration and all bridge/browser behavior remain unchanged. Close the fixture-owned browser, streams and server when startup fails before returning its cleanup callback; deliberately refused startup now exits naturally. All original defaults and behavior assertions remain."
    },
    "tests/windows-split.test.cts": {
        "blob": "291f98b3f6e1e313587ecd643056c44ad1a39444",
        "approval": "54442dcc73bbc892e6771cf881d43a03141affae",
        "reason": "Masih 27 Oct: restore the automatic orange completion/unread marker to the left; manual colour remains separate. Show observed Mother and recursively spawned live team despite a saved failure, keep recorded model evidence historical, and prevent duplicate recovery. Settings must fit beside navigation, hide unsupported Flex, show whole sidebar rows, and simplify chat actions into Organize/Open in with correct singular/bulk wording. Retain paging, keyboard, storage, action outcomes, isolation and alignment; shared test callers follow the same moved submenu actions. Immutable baseline retained."
    },
    "tests/sidebar-focus.test.cts": {
        "blob": "9c637b66d2fa18fe710fcd05ae395074a7ba3055",
        "approval": "d855d3ccd5400a484a1897f903f4876e67798331",
        "reason": "SIDEBAR, Masih 22 Oct: \"the session manager I don't want to see it chat with us, it doesn't any good.\" Its row is a switch, not a chat, so the focus-ring check skips it. Masih, 23 Oct: the Session Manager \"is non-functional ... either fix it; if you can\'t, delete it.\" It is deleted: its switch row and its hidden chat checks go; the remaining sidebar checks are unchanged."
    },
    "tests/startup-splash.test.cts": {
        "blob": "2d301700cb300d3fe104b69d70f6329c4d104db6",
        "approval": "1de4129f742172ae62f0f63f5c3bd5d0a46374fe",
        "reason": "BOOT, Masih 24 Oct: \"the splash must never wait on slow or failed data; show the app and fill lists as they arrive\" and \"Fix so the window always opens within ~2 s\". Preserve the approved gyroscope and both themes; replace the former conversation-wait and eight-second expectations with startup-responsive.test.cts, which fails on the installed renderer. Mouse clicks still pass through the fade. Masih 24 Oct: a dark opening before a light app is wrong; the opening follows the app theme. Preserve every animation, timing and click-through assertion."
    },
    "tests/sidebar-order.test.cjs": {
        "blob": "ee74fefc4d2b787f3ab2235e66126924458d54c6",
        "approval": "9b3bfffb441e225b6d38cfdffb8f528c402d1c25",
        "reason": "Masih 27 Oct: explicit per-conversation colours replace idle markers while retaining active/unread/error semantics, alignment and keyboard proof; thinking stays visible as secondary controls collapse; GUI /resume visibly chooses and opens saved history. Retain document calculations, selected-text feedback before deliberate navigation fallback, paging and shared editing. Keep behavioral assertions and the immutable baseline."
    },
    "tests/desktop-small-fixes.test.cjs": {
        "blob": "56d95eaf8a0f50e1feab8ebee0054c57a6c83a71",
        "approval": "75d7eca37cc07cf92a9a648dcaeb0fbda7607b2e",
        "reason": "Masih 29 Oct: \"those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in my side-bar chats. I want that place to be organized\". S18: Pinned, Projects, Groups and Recents list only his chats; Background runs and the sidebar Workflows section are off by default, so this test turns them on (orphans and broken-lineage chats are reached in Background runs)."
    },
    "tests/chat-groups.test.mjs": {
        "blob": "001cd63dac038dcd666cce877a4468ea7fe0b45e",
        "approval": "cbaaca06147f92877b5f1843c133cd7fc2b74c17",
        "reason": "Running chats come after waiting ones and before unseen replies. Masih 22 Oct: \"I already told you the orange marked ones (the sessions that are running) must be on top\". Only the priority-order assertions changed. R73, Masih 26 Oct: recursive agent trees replace the old one-level nesting limit. Preserve valid multigeneration saved parents, explicit null root overrides, initially collapsed branches (A177) and malformed-cycle normalization. Keep existing grouping, sort, storage and failure checks; verify native-cycle multi-selection uses the same effective tree as rendering."
    },
    "tests/composer-corner.test.cjs": {
        "blob": "d77e771f90a41d538ad3deee2a22ac52f62cc7de",
        "approval": "3b472fffa5c8b9158766709a6367f08a5f350b94",
        "reason": "A136/R32, Masih 22 Oct: the composer's cut corners are \"a different width ... ugly\"; they are now the border's own bevel, so the test asserts one border width and colour and no separate corner lines instead of the retired ::before and ::after lines."
    },
    "tests/elpis-features.test.cts": {
        "blob": "4ea61facc7acc9044ebaf5bce4ad52f900b8a98d",
        "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
        "reason": "A87/R28: feature controls keep their one-click checks with the approved logo accent"
    },
    "tests/page-column.cts": {
        "blob": "e4e6b692bcfe74810bc0f0629dd5cd16393d956f",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "A126: shared column measurements cover the centred page shells Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows."
    },
    "tests/provider-usage.test.cts": {
        "blob": "a831c7540406a39077766eb3e531bbe998140484",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "Initial SSE connection refreshes accounts; retain exact request deltas for every subsequent action A233/A251: one Default permissions setting defaults to Full access and respects managed constraints. Retain all provider usage persistence, sign-out, queue and settings-write checks; A125 initial connection reconciliation remains required."
    },
    "tests/claude-chat.test.cjs": {
        "blob": "a58d3a0ef03234d874047fed3c680167263378c7",
        "approval": "e0c15cf40197bdb08388bac6f5fbb0d0659db642",
        "reason": "A121, Masih: \"You don't need to ask me that; I'm result-oriented.\" Await native scroll delivery alongside the mocked clock, keeping the last-prompt assertion and adding a no-pullback check. Keep the already approved OBSRM navigation update. Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label. S35 persistent menubar items are separate from popup choices. Wait for the opened menu and preserve exact message/context actions and all reply-edit checks. Masih 27 Oct: long messages need an option to collapse. Append both-theme shared user/reply folding, complete Copy, keyboard, short controls and streamed-growth checks; retain every existing test and assertion. Masih permits hiding unusable read aloud. Remove only unavailable read-aloud menu expectation; retain all action, copy, folding, context and editing assertions. Masih 29 Oct, of \"Rewind to here\" on a reply: \"This option is nonsensical ... rewind what?\". A reply's menu lists Reply, Copy text, Copy as Markdown and Fork; prompts keep Rewind. Every other assertion remains."
    },
    "tests/command-menu.test.cts": {
        "blob": "b5ee4928b92b7c915bc7a78b33fc75c848e8bf06",
        ...pageRemovalApproval,
        "approval": "0a00c2cc125aebb2794e5da274463c5a3f97d57d",
        "reason": pageRemovalApproval.reason + " Wait for the existing animation-frame search focus before checking it; preserve all command, saved-text and focus-return assertions."
    },
    "tests/desktop-polish.test.cts": {
        "blob": "4d1df081303101817e4857fc702768ec8f5d331b",
        "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
        "reason": "A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks. S34 reconnect status stays at the workspace bottom even while a drawer or floating panel hides the chat. Restore the hidden chat before inspecting its preserved draft; keep bottom geometry and reconnection checks."
    },
    "tests/love-spot-pages.test.cjs": {
        "blob": "5e6bb4c0b87a64d9cf1d7217e2c583fbab199a2b",
        "approval": "e3db232c95e08534da9d7cc5e599fcad7fcf259c",
        "reason": "Masih, handwritten Love Spot board, 23 October 2026: “The Delete must be aligned with its icon” horizontally; asks to close the properties panel in the other Excalidraw view too. Keep page creation, deletion, recovery and storage checks; add the shared Style and horizontal icon-label journey in both themes. Masih, 23 Oct: the palette \"should be somewhere in this\" style panel, and the opacity number was \"visually wrong\": the toggle sits in the panel, and the opacity value stays under its slider after the panel reopens."
    },
    "tests/love-spot-live.test.cts": {
        "blob": "c7604087c6f6b2dcc22a3c31afeb98d1b332d98f",
        "approval": "31f17b33e067ff531c9c68263c893b7795e52fcd",
        "reason": "Love Spot, Masih 23 Oct: \"I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda. Her face must show next to her replies.\" Her reply and face now land on the board after he draws, so this test counts what he drew, not her love-* elements."
    },
    "tests/navigation-drafts.test.cjs": {
        "blob": "ad6820b974ced60ccec52acf2fdf60f3481f42d3",
        ...pageRemovalApproval
    },
    "tests/settings-pages.test.cts": {
        "blob": "a3e8fc768228e0fddd8915ff1b1f9c483a92b301",
        "approval": "9cb8eaec7aa2cc587bc2e133c263fd35956c8057",
        "reason": "Masih 27 Oct: Settings pages follow ChatGPT's order (Personal, Integrations, Coding, Archived); each control still writes only its own setting."
    },
    "tests/settings-write.test.cjs": {
        "blob": "09f90ee692006240e183eb49d99051431d05de7b",
        "approval": "279499d6bed5a579413834c6e7bc3e4d35006bfd",
        "reason": "S5/R37, Masih 22 Oct: \"it's the same as the enable memories yet one is off and the other is on\": the memory options show only while Memories is on, so the saved-settings fixture has Memories on; every version-chained save assertion is unchanged."
    },
    "tests/preferences.test.cjs": {
        "blob": "2a27c24660a0a2d14da383b02f7ad95ab2e6529f",
        "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
        "reason": "OBSRM page removal (see pageRemovalApproval) plus SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Two shortcut tests added; no existing assertion removed. Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" (efb597b8b) The send-hint assertion goes with sendHint, which nothing calls."
    },
    "tests/renderer.test.cts": {
        "blob": "e53cbff337db8e2d815405626cf8252097c25f12",
        "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
        "reason": "SPEC O2 project creation uses known folder/chooser first; open Advanced: custom folder before typing. Deferred transcript bodies are opened and awaited before reading, preserving all activity/copy assertions. Masih 24 Oct: all chats start collapsed. Explicitly expand the parent before checking its child; preserve real exported renderer send, steer, interrupt, writable-history, theme and mobile journeys."
    },
    "tests/sidebar-attention.test.cts": {
        "blob": "49489eeeeb40fb2d20ba75821b72040da2d19565",
        "approval": "9b3bfffb441e225b6d38cfdffb8f528c402d1c25",
        "reason": "Masih 27 Oct: explicit per-conversation colours replace idle markers while retaining active/unread/error semantics, alignment and keyboard proof; thinking stays visible as secondary controls collapse; GUI /resume visibly chooses and opens saved history. Retain document calculations, selected-text feedback before deliberate navigation fallback, paging and shared editing. Keep behavioral assertions and the immutable baseline."
    },
    "tests/sidebar-nav-icons.test.cjs": {
        "blob": "9a95e348b34396517804f68a04f1076694a75115",
        "approval": "75d7eca37cc07cf92a9a648dcaeb0fbda7607b2e",
        "reason": "Masih 29 Oct: \"those extra useless chats like the ones saying Task ID ... or chats I didn't start should not show in my side-bar chats. I want that place to be organized\". S18: Pinned, Projects, Groups and Recents list only his chats; Background runs and the sidebar Workflows section are off by default, so this test turns them on (orphans and broken-lineage chats are reached in Background runs)."
    },
    "tests/usability.test.cjs": {
        "blob": "e5cb1ba443f4983879427b0a4ff10b9cdb8d28a5",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "SETTINGS, Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Both models now have custom editors: target Background choices, verify the Main editor stays closed and enter an exact custom draft; preserve the approved OBSRM navigation checks. Read aloud supports each chat; its private warm-up request sends no message and saves no account settings. Exclude that one operation from the mutation counter while preserving all no-send/no-settings checks."
    },
    "tests/workflow-approvals.test.cts": {
        "blob": "1f182af9780ec77af10a8eedfe40813dddc889a9",
        ...pageRemovalApproval
    },
    "tests/changes-panel.test.cjs": {
        "blob": "3fa7c4c1d1ce01f4963d9ec74dde4529f405ae33",
        "approval": "e70ae1a895baf9ab67f87bea6b7ff9986520be02",
        "reason": "Masih 27 Oct: right-panel text follows the supplied ChatGPT reference; extend the retained long/binary owner cases to catch horizontally clipped diff text and filenames in both themes. Pre-fix cases failed at the intended clipping assertion; preserve paging, binary, counts and selection coverage."
    },
    "tests/config-defaults.test.cjs": {
        "blob": "15c56a22a2ad611904762824c314fbef9b2ccd04",
        "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
        "reason": "SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" The default is now an inline editor; assert the exact unset and externally saved values and zero writes. S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks. S33 consolidates the shared Main model in Configuration. Open that actual setting and preserve external-write reload, unset state and no-write-on-open checks."
    },
    "tests/customize.test.cts": {
        "blob": "e7478d146149e0be40694c1b2c7a125f4a15b7c8",
        "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
        "reason": "LEDGER, Masih's approved request in GATE11: \"MCP and plugin switches, Add plugins\". Supply writable versions and check both switch states, metadata and exact save requests; keep skill and navigation checks. 22 Oct, Masih (relayed): the skills switch \"reacts slowly. He wants the UI to flip immediately while the backend catches up\"; the switch flips at once and goes back if refused. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows."
    },
    "tests/night-themes.test.cts": {
        "blob": "5deae3213e50c3df45df91e9fe810f5bbac84c53",
        "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
        "reason": "A87, Masih: \"this logo color is the color I like to have all-across for both themes.\" Use the already updated exact-logo, interaction-state and contrast checks; retain all seven accent choices and font checks."
    },
    "tests/primary-action-colours.cjs": {
        "blob": "98e82896dd34117d785364f8456f26d3c92baa14",
        "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
        "reason": "A87, Masih: \"this logo color is the color I like to have all-across for both themes.\" The retained theme check needs its matching exact-logo state helper, including token equality, old-orange rejection and text contrast."
    },
    "tests/settings-row-audit.cjs": {
        "blob": "b4bcc5a65608af14d3031cf32bddecaa4ba03ab0",
        "approval": "254cad52528fc88bb705b5fd53abca37f9dabd23",
        "reason": "SETTINGS and SETTINGS2 (adds the About page), Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Audit the entire multiline model editor, excluding closed disclosure contents; preserve single-line heights, control sizes, alignment and clipping checks. S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks. Masih requested a separate native Browser settings page. Include it in existing row geometry checks; retain all original pages."
    },
    "tests/sidebar-indent.test.cjs": {
        "blob": "2205d01288c3df27da3fa312802748a244124b45",
        "approval": "54442dcc73bbc892e6771cf881d43a03141affae",
        "reason": "Masih 27 Oct: restore the automatic orange completion/unread marker to the left; manual colour remains separate. Show observed Mother and recursively spawned live team despite a saved failure, keep recorded model evidence historical, and prevent duplicate recovery. Settings must fit beside navigation, hide unsupported Flex, show whole sidebar rows, and simplify chat actions into Organize/Open in with correct singular/bulk wording. Retain paging, keyboard, storage, action outcomes, isolation and alignment; shared test callers follow the same moved submenu actions. Immutable baseline retained."
    },
    "tests/tabs.test.cjs": {
        "blob": "2932bf023d601e4eb1972ee620c2644cf41ddc20",
        "approval": "325dac7f8f719014b25252b0e369bf0e1bee7b2a",
        "reason": "Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" Removes the screenshot probe, whose first line returns when no screenshot folder is set and which asserts nothing. Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label. S35 adds persistent File/Edit/View/Help menubar items. Scope the exact side-panel choice inventory to its open popup; retain all tab, shell, page and panel lifecycle checks. Await that popup's visibility before reading the same exact five choices; run40273131811 exposed the immediate empty snapshot."
    },
    "tests/reading-options.test.cts": {
        "blob": "fb2bcf9aeca29ea0316e6d3ee3f3a9c3e40afe87",
        "approval": "c88df8e6d0fa9bce03ddad94250d290679948d64",
        "reason": "Footer, Masih 22 Oct: \"the name of the user shouldn't be clickable.\" The font check opens a chat menu instead of the account menu, which no longer exists."
    },
    "tests/improve.test.cjs": {
        "blob": "dfdfbb96812e10f40b32134630b1397ea9db54a7",
        "approval": "f6daa10832a22a3957d964cf7a606995fdd61af8",
        "reason": "Improve Elpis, Masih 22 Oct, with a screenshot of the review dialog: \"keep and try it should be deleted.\" The review has Close and Check build & tests only; the steps that clicked or disabled Try it and Keep now check that neither exists, and the reasons they showed as tooltips are read from the dialog text."
    },
    "tests/files-pane.test.cjs": {
        "blob": "502f1df3b15c4d6b0c91bb35545425ac1c067ff6",
        "approval": "9b3bfffb441e225b6d38cfdffb8f528c402d1c25",
        "reason": "Masih 27 Oct: explicit per-conversation colours replace idle markers while retaining active/unread/error semantics, alignment and keyboard proof; thinking stays visible as secondary controls collapse; GUI /resume visibly chooses and opens saved history. Retain document calculations, selected-text feedback before deliberate navigation fallback, paging and shared editing. Keep behavioral assertions and the immutable baseline."
    },
    "tests/love-spot.test.cts": {
        "blob": "f5b82185db895c2a4dbf1414f0a5c0f3c1bd05f7",
        "approval": "8e43b6441294365f45d1193358c47cfb0a68da00",
        "reason": "Love Spot, Masih 22 Oct: \"I said remove the agents section in love spot; it's still there.\" The agents section is gone, so its steps leave this test (a3b057c0f). 23 Oct, Masih: \"remove the talk and matilda buttons.\" The toolbar has no Talk button, so the layout check no longer measures one; every other control is still measured. S35/R6: voice information stays compact and its unavailable reason remains keyboard accessible; retain wide/narrow and light/dark layout assertions. Keyboard focus must actually reach the shared tooltip; use Tab navigation and preserve all keyboard access, light/dark, wide/narrow and toolbar geometry checks. Shared tooltips expose role and an associated description. Preserve real Tab/Escape interaction, accessible unavailable information, all themes and complete toolbar fit checks. Love Spot, Masih 26 Oct: \u201cits audio doesn't work; if you don't know how to do it - disable it\u201d and \u201cforget that functionality for now\u201d. The temporary text-only gate supplies the unavailable reason; preserve all keyboard, tooltip association, layout and theme assertions. Resolve the focused information control's actual aria-describedby association instead of matching two equal tooltip texts. Preserve keyboard Tab/Escape, exact unavailable reason and every toolbar/theme/fit assertion. Masih 27 Oct: remove unavailable board audio controls, retain ordinary dictation plus both-theme sidebar, geometry and responsive fit checks."
    },
    "tests/love-dock.test.cjs": {
        "blob": "66f365c618094de453b2a8d8ef55afbb9b65ab56",
        "approval": "6c55175a10129526a7b1fcb3f92c55b529fcea14",
        "reason": "Love Spot, Masih 23 Oct: \"remove the talk and matilda buttons. I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda.\" The native window has no Talk button or panel: a captured voice note on the board is what Matilda answers, on the board, and the voice control still has to fit the window."
    },
    "tests/startup-archive.test.cjs": {
        "blob": "bd411e5a0e6e7e5bb070f6e87054a7f3b0ed0b52",
        "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
        "reason": "Voice, 23 Oct: the composer asks GET /api/voice for whether a call is possible; this strict fixture reports any unknown request as a failure, so it answers that one (no call here). WI: unique workflow names and colours read workflow history at startup; fixture answers that read with an empty history. Preserve strict unknown-request rejection, archive, restore and deletion checks."
    },
    "tests/prompt-rail.test.cjs": {
        "blob": "5c7cf5c97fc3bb4d6d262385c67c370dfe1befbf",
        "approval": "d7df305f1efcbfb9cbb7227e0ff1d9bb73c552f2",
        "reason": "Masih 31 Oct: \"the chat changes its size when it loads—like a few seconds,2 seconds after it's loaded—is that by design?\". Keep the rail in the existing gutter so the transcript width remains stable; require a 28px target, a clear gap and a negative overlap check. Masih 29 Oct: \"I explicitly told you to create a parity of chatgpt app ... map every style feature of chatgpt app into a clear spec that's reusable and make our design match it\" (specs/chatgpt-chat-style.md). The rail appears from four prompts (Masih 29 Oct earlier: \"When there is only one message we don't want this bar\"), its hovered dash is 26px and its card opens at the rail's edge; tests with fewer prompts gain prompts so every behaviour is still exercised."
    },
    "tests/previous-messages.test.cjs": {
        "blob": "425373266203ddbea262a48cab16a38afcce2c7b",
        "approval": "c3b5cca74144936d9d8c92a55be9ab06516e8a30",
        "reason": "Masih 29 Oct: \"what does this mean? the 6 previous messages part. I think it's wrong.\" An untimed fold says what it holds, counted by kind (\"2 messages, browsed the web, ran a command\")."
    },
    "tests/view-errors.test.cts": {
        "blob": "3aa697bf47386452b99868dae38662643f8d08fe",
        "approval": "eb6da27de8b27d7b8aaf461cc9078d0ba7444081",
        "reason": "A121/GATE11, Masih: \"never weaken or delete an assertion that still describes wanted behaviour\". dd2ca3576 gave navigation rows accessible names: scope every bad-reply assertion to the Ledger page instead of its same-named shortcut; all error and survival checks remain. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows. 23 Oct, Masih: \"we should add the import chats options like cloudroom does. add it.\" Settings gains the page Import chats, so this test lists it (and answers its route)."
    }
};
