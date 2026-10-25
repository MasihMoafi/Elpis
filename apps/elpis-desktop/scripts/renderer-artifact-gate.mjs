// Tests the exported renderer and saved workspace against the installed desktop checkpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInventory, discoverTests } from './test-gate.mjs';

// The retained UI regressions: the 21 October integration of every approved desktop fix. Move it only in a commit that
// names the request (Masih's words) that changes a retained behaviour; never to make a failing gate pass.
// 21 Oct (A121): moved from 21343157b, whose copies of 35 UI tests never passed (undefined helpers, stale fixtures),
// to the commit that repairs them case for case. Masih: "You don't need to ask me that; I'm result-oriented."
// Round 2 (f96171ccb): the merged repairs (gatefix) keep every case; the earlier baseline still had the pre-merge copies.
// Round 3 (988aad0e7): combofix scoped the dropdown helper (c23e326c8) and wf1b aimed three Workflows tests at the current UI; every case kept.
export const baselineCommit = '988aad0e78bd264c00e435be07598e79f08941e8';
// GATE10/GATE11/GATE12: only these audited copies need updated expectations or fixtures. Each pin names
// the request and exact replacement bytes; all other retained tests keep their original bytes.
// Blob pins also cover the small fixture repairs in this change, without advancing the checkpoint.
const pageRemovalApproval = {
  "approval": "da53b1661b8a8fd5de09925b7ec86fd4ce0bb747",
  "reason": "OBSRM, Masih 21 Oct 22:45: \"remove it; remove the observability page - keep its logo icon as it looks good. the rest, remove.\" Preserve the remaining navigation checks."
};
export const retainedUpdates = {
  "988aad0e78bd264c00e435be07598e79f08941e8": {
    "tests/browser-panel.test.cjs": {
      "blob": "3272ad4cadc3dc05d26728f8553f89907463e0e0",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/terminal.test.cjs": {
      "blob": "96f3319406a764eaf54f55128faf4f74eda06a84",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/slash-commands.test.cjs": {
      "blob": "9d55c9df95dc2073d115471a1cce481a5647dce9",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label."
    },
    "tests/config-navigation.test.cjs": {
      "blob": "9fec23177956a4ec8f8b20b32eedc3410a5cab69",
      "approval": "b7d6485b31c68bb87b1421423327e761b58a2a4b",
      "reason": "S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks."
    },
    "tests/workflow-polish.test.cjs": {
      "blob": "8f0b26e59e598694bbb71a3522cb05720f6942fc",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "SPEC O2 project creation uses known folder/chooser first; open Advanced: custom folder before typing. Deferred transcript bodies are opened and awaited before reading, preserving all activity/copy assertions."
    },
    "tests/sidebar-groups.test.cjs": {
      "blob": "1be6db6a14ffb2819e6501e3450b93010ff05277",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Masih 24 Oct: all chats must already be collapsed every time. Open the parent branch before using its children; retain collapse/keyboard, exact attachments, failed sends, observation and no-write checks."
    },
    "tests/workflow-observer.test.cjs": {
      "blob": "ce9413f242253cf0c57d89cb9a3ec5d7532270c4",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Masih 24 Oct: all chats must already be collapsed every time. Open the parent branch before using its children; retain collapse/keyboard, exact attachments, failed sends, observation and no-write checks."
    },
    "tests/chat-edits.test.cjs": {
      "blob": "6a103a535903e9c2acfe88c8798a6d8829fabc97",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "TESTING.md: wait for observable states. Await opened lazy transcript bodies and prune rows before counting them; retain exact content, ordering and failure assertions."
    },
    "tests/smart-prune.test.cjs": {
      "blob": "d307653982b4267388401f44378f449b197c9918",
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
    "tests/customize-description-fit.test.cjs": {
      "blob": "c362d6ee69d60ef7bd388b698a29fd7faa36dceb",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/github-connector.test.cjs": {
      "blob": "93524667970c3a5ffa4e49ee15b44b6392d75894",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/hud-language.test.cjs": {
      "blob": "ca3d5b6617be4a5123a08c5e2f4afdcf39db3dc5",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/ledger-page.test.cjs": {
      "blob": "3f08e4309e6681b9b8b861bc234fa259486a97bb",
      "approval": "e65e0f06f4235f85318c2cb3ce29ef844a720a65",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/page-column-app.cjs": {
      "blob": "e9ddbc3d5d0f6cb916b4d862151c54d39bd4a2a5",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/page-column.test.cjs": {
      "blob": "2531b596a69db78f6181c8a70c60474375d8d0f3",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/view-boundaries.test.cjs": {
      "blob": "345650a3abb3d055ae51e1c5acbbd1d3f047434b",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "CUSTOMIZE, Masih 22 Oct: \"The name of Ledger is incorrect for this, however. What do you think it should be called? ... Claude calls it customize\", then \"Yes please\". The page is Customize; this test follows its label (the chat's Context Ledger button keeps its name)."
    },
    "tests/parity-fixture.cjs": {
      "blob": "6d85357f059f385a73fc55a30dcc1cf5d2c0979f",
      "approval": "dc7256e1672e6b15164fa01e39a48fb13d9cd03e",
      "reason": "LOVEVOICE, Masih 24 Oct: feed a recorded WAV as the microphone; measure first audio actually played; tests headless. Allow explicit Chromium capture arguments for real media tests while preserving every existing fixture default and assertion."
    },
    "tests/windows-split.test.cjs": {
      "blob": "f371968667c8d9a764f9a91471ffc955f75b2419",
      "approval": "e848a1dca89c80945da8b7abcf4d3d8cd2060a53",
      "reason": "SPLIT, Masih 22 Oct (R44): Ctrl+[ and Ctrl+] move the open chat in its list, so split-view focus is Ctrl+Alt+[ and Ctrl+Alt+]."
    },
    "tests/sidebar-focus.test.cjs": {
      "blob": "9c637b66d2fa18fe710fcd05ae395074a7ba3055",
      "approval": "d855d3ccd5400a484a1897f903f4876e67798331",
      "reason": "SIDEBAR, Masih 22 Oct: \"the session manager I don't want to see it chat with us, it doesn't any good.\" Its row is a switch, not a chat, so the focus-ring check skips it. Masih, 23 Oct: the Session Manager \"is non-functional ... either fix it; if you can\'t, delete it.\" It is deleted: its switch row and its hidden chat checks go; the remaining sidebar checks are unchanged."
    },
    "tests/startup-splash.test.cjs": {
      "blob": "2d301700cb300d3fe104b69d70f6329c4d104db6",
      "approval": "1de4129f742172ae62f0f63f5c3bd5d0a46374fe",
      "reason": "BOOT, Masih 24 Oct: \"the splash must never wait on slow or failed data; show the app and fill lists as they arrive\" and \"Fix so the window always opens within ~2 s\". Preserve the approved gyroscope and both themes; replace the former conversation-wait and eight-second expectations with startup-responsive.test.cjs, which fails on the installed renderer. Mouse clicks still pass through the fade. Masih 24 Oct: a dark opening before a light app is wrong; the opening follows the app theme. Preserve every animation, timing and click-through assertion."
    },
    "tests/controls.cjs": {
      "blob": "ac87649f1f3084bd04af99ed3db59b053b1a97fd",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Read the fallback input or catalog select atomically as the catalog loads; keep A87's logo-colour guards. Footer, Masih 22 Oct: \"theme should be next to settings\". The helpers open Settings with the gear and switch the theme with its button (c88df8e6d). A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/input-hints.test.cjs": {
      "blob": "8709043fe7d186dde635579ca33e30fe481ba62f",
      "approval": "81bb605d3b191da40fe95d499505acd12234f8b5",
      "reason": "S1/R34, Masih 22 Oct: \"This enter ID or the model name is unacceptable. There should always be the dropdown menu.\" The RAG models are menus; the long-hint check reads their typed fields behind Advanced: custom model."
    },
    "tests/sidebar-order.test.cjs": {
      "blob": "b67ceb9a7c0dd52adc5f9ebf6fe0d6e486b5664b",
      "approval": "d855d3ccd5400a484a1897f903f4876e67798331",
      "reason": "The Session Manager is a switch, not a chat; running chats sit above the others. Masih 22 Oct: \"the session manager I don't want to see it chat with us, it doesn't any good. I already told you the orange marked ones (the sessions that are running) must be on top\". The A100 manager tests now check the switch, the hidden chat and the saved choice; the A102 waiting test expects running chats after waiting ones; every other order assertion is unchanged. Masih, 23 Oct: the Session Manager \"is non-functional ... either fix it; if you can\'t, delete it.\" It is deleted: its switch row and its hidden chat checks go; the remaining sidebar checks are unchanged."
    },
    "tests/sidebar.test.cjs": {
      "blob": "cfd20637d8dbd17302619ebe577e5a3d7a7766ff",
      "approval": "d855d3ccd5400a484a1897f903f4876e67798331",
      "reason": "The Session Manager is a switch, not a chat. Masih 22 Oct: \"people should be able to turn on and off the session manager right there ... I don't want to see it chat with us\". The sidebar test checks the switch above the list and that it never creates a chat; the rest is unchanged. Chat menu, Masih 22 Oct: \"it shouldn't have this show agents when there are no agents!\" The row menu of a chat with no agents offers none (c88df8e6d). Arrow keys, Masih 22 Oct: \"Please make it change just by the stroke of the keyboards.\" An arrow now opens the chat it reaches, so the test no longer presses Enter (7d3c12984). Masih, 23 Oct: the Session Manager \"is non-functional ... either fix it; if you can't, delete it.\" It is deleted: its switch row and its hidden chat checks go; the remaining sidebar checks are unchanged. A248: Bookmark belongs beside Pin and Archive; retain every deletion, selection, keyboard and hover assertion."
    },
    "tests/desktop-small-fixes.test.cjs": {
      "blob": "f02b388191828cac085bcbd12a80f994762ef192",
      "approval": "d855d3ccd5400a484a1897f903f4876e67798331",
      "reason": "The Session Manager row is a switch. Masih 22 Oct: \"people should be able to turn on and off the session manager right there\". The arrow-key walk still stops on the row, now a switch; every other step is unchanged. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows. Masih, 23 Oct: the Session Manager \"is non-functional ... either fix it; if you can\'t, delete it.\" It is deleted: its switch row and its hidden chat checks go; the remaining sidebar checks are unchanged."
    },
    "tests/chat-groups.test.mjs": {
      "blob": "2df494abc42feb2c83e34ea9259c25050ebfad6b",
      "approval": "767050d573b68387feea4bf67f90df69f7ec96d8",
      "reason": "Running chats come after waiting ones and before unseen replies. Masih 22 Oct: \"I already told you the orange marked ones (the sessions that are running) must be on top\". Only the priority-order assertions changed."
    },
    "tests/composer-corner.test.cjs": {
      "blob": "d77e771f90a41d538ad3deee2a22ac52f62cc7de",
      "approval": "3b472fffa5c8b9158766709a6367f08a5f350b94",
      "reason": "A136/R32, Masih 22 Oct: the composer's cut corners are \"a different width ... ugly\"; they are now the border's own bevel, so the test asserts one border width and colour and no separate corner lines instead of the retired ::before and ::after lines."
    },
    "tests/elpis-features.test.cjs": {
      "blob": "4ea61facc7acc9044ebaf5bce4ad52f900b8a98d",
      "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
      "reason": "A87/R28: feature controls keep their one-click checks with the approved logo accent"
    },
    "tests/page-column.cjs": {
      "blob": "e4e6b692bcfe74810bc0f0629dd5cd16393d956f",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "A126: shared column measurements cover the centred page shells Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows."
    },
    "tests/provider-usage.test.cjs": {
      "blob": "a831c7540406a39077766eb3e531bbe998140484",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Initial SSE connection refreshes accounts; retain exact request deltas for every subsequent action A233/A251: one Default permissions setting defaults to Full access and respects managed constraints. Retain all provider usage persistence, sign-out, queue and settings-write checks; A125 initial connection reconciliation remains required."
    },
    "tests/claude-chat.test.cjs": {
      "blob": "58b0d904f76474ec33ee76f5079ea0be6c6de8a0",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "A121, Masih: \"You don't need to ask me that; I'm result-oriented.\" Await native scroll delivery alongside the mocked clock, keeping the last-prompt assertion and adding a no-pullback check. Keep the already approved OBSRM navigation update. Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label."
    },
    "tests/command-menu.test.cjs": {
      "blob": "335dcdab0114fafb0e45c3af362501bc7c8f13d2",
      ...pageRemovalApproval
    },
    "tests/composer-files.test.cjs": {
      "blob": "9cfb1e0156430f9236d847c4ea22d4366f758a14",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Masih 24 Oct: all chats must already be collapsed every time. Open the parent branch before using its children; retain collapse/keyboard, exact attachments, failed sends, observation and no-write checks."
    },
    "tests/desktop-polish.test.cjs": {
      "blob": "ee2822dc5aa8fd77901ada2ca610a2b1f513650d",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/desktop-sweep.test.cjs": {
      "blob": "ab7b9ecdd8cae06cc0d13681d7e51786e57b548a",
      "approval": "eb6da27de8b27d7b8aaf461cc9078d0ba7444081",
      "reason": "SETTINGS2, Masih's GATE12 handoff (approved 21 Oct 22:45): \"Personalization file editors, sizes and corners, sleep prevention, shortcut search, a new About page\" The approved About page joins the exact page order and every fit check; keep the approved OBSRM navigation checks. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows. 23 Oct, Masih: \"we should add the import chats options like cloudroom does. add it.\" Settings gains the page Import chats, so this test lists it (and answers its route)."
    },
    "tests/love-spot-pages.test.cjs": {
      "blob": "5e6bb4c0b87a64d9cf1d7217e2c583fbab199a2b",
      "approval": "e3db232c95e08534da9d7cc5e599fcad7fcf259c",
      "reason": "Masih, handwritten Love Spot board, 23 October 2026: “The Delete must be aligned with its icon” horizontally; asks to close the properties panel in the other Excalidraw view too. Keep page creation, deletion, recovery and storage checks; add the shared Style and horizontal icon-label journey in both themes. Masih, 23 Oct: the palette \"should be somewhere in this\" style panel, and the opacity number was \"visually wrong\": the toggle sits in the panel, and the opacity value stays under its slider after the panel reopens."
    },
    "tests/love-spot-live.test.cjs": {
      "blob": "c7604087c6f6b2dcc22a3c31afeb98d1b332d98f",
      "approval": "31f17b33e067ff531c9c68263c893b7795e52fcd",
      "reason": "Love Spot, Masih 23 Oct: \"I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda. Her face must show next to her replies.\" Her reply and face now land on the board after he draws, so this test counts what he drew, not her love-* elements."
    },
    "tests/navigation-drafts.test.cjs": {
      "blob": "ad6820b974ced60ccec52acf2fdf60f3481f42d3",
      ...pageRemovalApproval
    },
    "tests/settings-pages.test.cjs": {
      "blob": "c1e87b74514f41be314472b659a9dd432e2ba187",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "SETTINGS2, Masih's GATE12 handoff (approved 21 Oct 22:45): \"Personalization file editors, sizes and corners, sleep prevention, shortcut search, a new About page\" Include the approved About page and shortcut search; assert About identity, release link and no writes; retain every control-write, reload, page-order and narrow-layout assertion. S5/R37, Masih 22 Oct: \"it's the same as the enable memories yet one is off and the other is on\": Memories is one master switch and its options appear only when it is on. 23 Oct, Masih: \"we should add the import chats options like cloudroom does. add it.\" Settings gains the page Import chats, so this test lists it (and answers its route). 23 Oct, Masih: add the voice picker in Settings exactly like the ChatGPT app screenshot. Open Advanced: transcription before the existing fallback and model writes; every assertion is retained. A233/A251: one Default permissions setting defaults to Full access and respects managed constraints. Retain all provider usage persistence, sign-out, queue and settings-write checks; A125 initial connection reconciliation remains required."
    },
    "tests/settings-write.test.cjs": {
      "blob": "09f90ee692006240e183eb49d99051431d05de7b",
      "approval": "279499d6bed5a579413834c6e7bc3e4d35006bfd",
      "reason": "S5/R37, Masih 22 Oct: \"it's the same as the enable memories yet one is off and the other is on\": the memory options show only while Memories is on, so the saved-settings fixture has Memories on; every version-chained save assertion is unchanged."
    },
    "tests/context-menu.test.cjs": {
      "blob": "b4bba2d7126b7bb0192503a80646c083ab292c45",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "F2 rename, Masih's request: \"F2 rename\" (docs/USER_REQUESTS.md, 21 October integration). GATE12: \"never weaken or delete an assertion that still describes wanted behaviour\". Await actual menu focus before sending F2, and its removal before Escape; keep every save, cancel, modifier and typing assertion. Chat menu, Masih 22 Oct: \"it shouldn't have this show agents when there are no agents!\" Show agents leaves the menu of a chat without agents (c88df8e6d). Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label."
    },
    "tests/preferences.test.cjs": {
      "blob": "2a27c24660a0a2d14da383b02f7ad95ab2e6529f",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "OBSRM page removal (see pageRemovalApproval) plus SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Two shortcut tests added; no existing assertion removed. Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" (efb597b8b) The send-hint assertion goes with sendHint, which nothing calls."
    },
    "tests/renderer.test.cjs": {
      "blob": "5b8c4296ccdba31be41bd93cefc000570f23b4bd",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "SPEC O2 project creation uses known folder/chooser first; open Advanced: custom folder before typing. Deferred transcript bodies are opened and awaited before reading, preserving all activity/copy assertions."
    },
    "tests/sidebar-attention.test.cjs": {
      "blob": "c889f4da05279b38c5308c0ab1f0dd03037b0809",
      ...pageRemovalApproval
    },
    "tests/sidebar-nav-icons.test.cjs": {
      "blob": "f80177d99236af40b5204bd71c0f6ec83ade884b",
      ...pageRemovalApproval
    },
    "tests/usability.test.cjs": {
      "blob": "e5cb1ba443f4983879427b0a4ff10b9cdb8d28a5",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "SETTINGS, Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Both models now have custom editors: target Background choices, verify the Main editor stays closed and enter an exact custom draft; preserve the approved OBSRM navigation checks. Read aloud supports each chat; its private warm-up request sends no message and saves no account settings. Exclude that one operation from the mutation counter while preserving all no-send/no-settings checks."
    },
    "tests/workflow-approvals.test.cjs": {
      "blob": "1f182af9780ec77af10a8eedfe40813dddc889a9",
      ...pageRemovalApproval
    },
    "tests/changes-panel.test.cjs": {
      "blob": "93f85266a3af15a37194b1bedfbb04e737587ba4",
      "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
      "reason": "A87, Masih: \"this logo color is the color I like to have all-across for both themes.\" The negative colour probe must use the former, now unapproved Send orange; every diff assertion stays."
    },
    "tests/config-defaults.test.cjs": {
      "blob": "4baf2d4ce89b8f0e36cc55a3b1c43249fc359993",
      "approval": "b7d6485b31c68bb87b1421423327e761b58a2a4b",
      "reason": "SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" The default is now an inline editor; assert the exact unset and externally saved values and zero writes. S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks."
    },
    "tests/customize.test.cjs": {
      "blob": "e7478d146149e0be40694c1b2c7a125f4a15b7c8",
      "approval": "fbe94e91f9d438cd87bcf582c03ce7f058e14a96",
      "reason": "LEDGER, Masih's approved request in GATE11: \"MCP and plugin switches, Add plugins\". Supply writable versions and check both switch states, metadata and exact save requests; keep skill and navigation checks. 22 Oct, Masih (relayed): the skills switch \"reacts slowly. He wants the UI to flip immediately while the backend catches up\"; the switch flips at once and goes back if refused. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows."
    },
    "tests/night-themes.test.cjs": {
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
      "blob": "d1bfe4e596428f295143ab377869e4573bb22cac",
      "approval": "b7d6485b31c68bb87b1421423327e761b58a2a4b",
      "reason": "SETTINGS and SETTINGS2 (adds the About page), Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Audit the entire multiline model editor, excluding closed disclosure contents; preserve single-line heights, control sizes, alignment and clipping checks. S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks."
    },
    "tests/settings-rows.test.cjs": {
      "blob": "dc9760e9d4454c1e78e4b4536a63ba1a8443ba19",
      "approval": "b7d6485b31c68bb87b1421423327e761b58a2a4b",
      "reason": "SETTINGS, Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Retain every page and existing drift mutation; add closed/open model disclosures and independent compound alignment, size and clipping mutations. S33, Masih 25 Oct: remove useless misleading Settings category destinations. Categories are plain labels; legacy aliases resolve real pages. S4/S33: linked instruction editors show accurate local loading/error/save states and text-only previews; retain controls, drafts, search, navigation, persistence and narrow layout checks."
    },
    "tests/sidebar-indent.test.cjs": {
      "blob": "5bb88e37e24230393592abe93c2e3d46ef669805",
      "approval": "ef56904fcd8b39725632b4c24ca574cf8ab63d1e",
      "reason": "V1, Masih's approved request in GATE11: \"every chat row uses the project-chat layout, all chevrons in one column\". Retain exact circle/title coordinates, hover, expansion, selection and reload checks in both themes."
    },
    "tests/tabs.test.cjs": {
      "blob": "f975865ef14cac12eb7907ad69222be3756d571f",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" Removes the screenshot probe, whose first line returns when no screenshot folder is set and which asserts nothing. Requested menu entries now include Read aloud, Bookmark, Put under, New project from these, Context and /goal. S32/S35, Masih 25 Oct: Fast applies within the current turn and has a lightning toggle. Preserve no-send, on/off, refusal and command coverage; compaction uses one shared label."
    },
    "tests/sidebar-parity.test.cjs": {
      "blob": "02943d2f19811a05e53e63a20c0417d777bdfe1a",
      "approval": "c88df8e6d0fa9bce03ddad94250d290679948d64",
      "reason": "Footer, Masih 22 Oct: \"theme should be next to settings; and the name of the user shouldn't be clickable.\" The account-row test follows: the name only shows, and the theme button sits beside Settings."
    },
    "tests/reading-options.test.cjs": {
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
      "blob": "5676e038dd8293b9a0bcfb8ad516707e67437d71",
      "approval": "b356030ddf001d5f993765c72b6fee3a79131d42",
      "reason": "Loose ends, Masih 22 Oct: \"Fix those loose-ends. delete them if we don't need them.\" The PDF test needed a full Chromium (absent here) to check the browser's own PDF viewer, which is not Elpis's code; it now checks the document frame, that no raw bytes open in an editor, and that the file is served as application/pdf. Every other test in the file is unchanged. A217: panel starts at sidebar width and closing its last tab closes it. S35, Masih 25 Oct: close beside the Elpis brand, top application menus and aligned composer controls; retain draft, clipping, keyboard, drawing and panel checks."
    },
    "tests/love-spot.test.cjs": {
      "blob": "27421d4d36879c01db55e30317bce034a2f10cd7",
      "approval": "6c55175a10129526a7b1fcb3f92c55b529fcea14",
      "reason": "Love Spot, Masih 22 Oct: \"I said remove the agents section in love spot; it's still there.\" The agents section is gone, so its steps leave this test (a3b057c0f). 23 Oct, Masih: \"remove the talk and matilda buttons.\" The toolbar has no Talk button, so the layout check no longer measures one; every other control is still measured. S35/R6: voice information stays compact and its unavailable reason remains keyboard accessible; retain wide/narrow and light/dark layout assertions."
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
    "tests/view-errors.test.cjs": {
      "blob": "3aa697bf47386452b99868dae38662643f8d08fe",
      "approval": "eb6da27de8b27d7b8aaf461cc9078d0ba7444081",
      "reason": "A121/GATE11, Masih: \"never weaken or delete an assertion that still describes wanted behaviour\". dd2ca3576 gave navigation rows accessible names: scope every bad-reply assertion to the Ledger page instead of its same-named shortcut; all error and survival checks remain. Then, Masih 22 Oct, \"Yes please\" to the page being called Customize; the label follows. 23 Oct, Masih: \"we should add the import chats options like cloudroom does. add it.\" Settings gains the page Import chats, so this test lists it (and answers its route)."
    }
  }
};
// OBSRM: the pageRemovalApproval request also retires these page-only checks.
// Love Spot agents section removed (Masih, 22 Oct: "I said remove the agents section in love spot; it's still there.", a3b057c0f): its two test files go.
// The standalone Love Spot sync (Masih, 22 Oct: "Fix those loose-ends. delete them if we don't need them."): Love Spot lives inside Elpis, the sync tool and its test failed since before that day, so both go.
// These page-only regressions and their fixture are retired; all other baseline tests remain mandatory.
// The Talk panel (Masih, 23 Oct: "remove the talk and matilda buttons. I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda."): its test file is
// split into tests/love-spot-board.test.cjs (what reaches her, where her reply lands, the microphone, navigating away, the toolbar fit); the
// Talk-only checks (the panel, its model picker and hover buttons, quoting a note, its fit) go with the panel.
export const retiredPaths = {
  '988aad0e78bd264c00e435be07598e79f08941e8': ['tests/settings-reorder.test.cjs', 'tests/observability.test.cjs', 'tests/temp-root-ui.test.cjs', 'tests/love-agents.test.cjs', 'tests/love-agents-v2.test.cjs', 'tests/love-spot-standalone.test.cjs', 'tests/love-spot-talk.test.cjs'],
};
export const receiptName = '.elpis-ui-receipt.json';
const stateTest = 'desktop/state.test.cjs';
const appPrefix = 'apps/elpis-desktop/';
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const trackedFiles = (root, commit, paths) => new Map(git(root, ['ls-tree', '-r', '--full-tree', commit, '--', ...paths]).trim().split('\n').filter(Boolean).map(line => {
  const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/);
  assert(match, `Unexpected tracked source entry: ${line}`);
  return [match[2].slice(appPrefix.length), match[1]];
}));

export function assertSourceCommit(root, commit) {
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), commit, 'Source HEAD changed during installation');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during installation');
}

/** A clean working tree alone cannot detect a source mutation copied into a package and then reverted. */
export async function verifyPackagedSources({ root = appRoot, destination, commit }) {
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert(manifest.schemaVersion === 1 && Array.isArray(manifest.files), 'Invalid desktop package manifest');
  const sourceIdentity = JSON.parse(git(root, ['show', `${commit}:${appPrefix}package.json`]));
  const identity = JSON.parse(await fs.readFile(path.join(destination, 'app/package.json'), 'utf8'));
  const expectedIdentity = { name: sourceIdentity.name, productName: sourceIdentity.productName || 'Elpis',
    desktopName: sourceIdentity.desktopName, version: sourceIdentity.version, main: 'desktop/main.cjs', private: true, type: 'module' };
  for (const [key, value] of Object.entries(expectedIdentity)) {
    assert.deepEqual(identity[key], value, `Packaged desktop identity differs from source commit: ${key}`);
  }
  const tracked = trackedFiles(root, commit, [appPrefix]), checked = new Set();
  for (const file of manifest.files) {
    assert(typeof file.path === 'string' && !path.isAbsolute(file.path) && !file.path.split('/').includes('..'), 'Invalid packaged path');
    const source = file.path.startsWith('app/') ? file.path.slice(4) : null;
    // Identity is checked above; package.json dependencies are generated from the bundled packages.
    if (!source || source === 'package.json' || !tracked.has(source)) continue;
    assert(!checked.has(source), `Duplicate packaged source: ${source}`);
    const packaged = path.join(destination, file.path);
    assert((await fs.lstat(packaged)).isFile(), `Packaged source must be a regular file: ${source}`);
    assert.equal(blob(await fs.readFile(packaged)), tracked.get(source), `Packaged production bytes differ from source commit: ${source}`);
    checked.add(source);
  }
  assert(checked.has('desktop/main.cjs'), 'Desktop package manifest omits its tracked entry point');
  assert(checked.has('desktop/state.cjs'), 'Desktop package manifest omits tracked desktop/state.cjs');
}

async function treeFiles(root, relative = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(root, name));
    else { assert(entry.isFile(), `Unexpected renderer/test symlink: ${name}`); files.push(name); }
  }
  return files;
}

export async function rendererHash(out) {
  const hash = createHash('sha256');
  for (const name of await treeFiles(out)) {
    if (name === receiptName) continue;
    const bytes = await fs.readFile(path.join(out, name));
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

/** Resolve an immutable replacement, including a not-yet-staged repair with exactly the pinned bytes. */
async function retainedUpdate(root, name, pin) {
  assert(/^tests\/[^\0]+$/.test(name) && !name.split('/').includes('..'), `Invalid retained path: ${name}`);
  assert(/^[a-f0-9]{40}$/.test(pin.blob) && /^[a-f0-9]{40}$/.test(pin.approval) && pin.reason, `Invalid retained pin: ${name}`);
  let bytes;
  try { bytes = git(root, ['cat-file', 'blob', pin.blob], { encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { bytes = await fs.readFile(path.join(root, name)); }
  assert.equal(blob(bytes), pin.blob, `Changed pinned retained regression: ${name}`);
  return bytes;
}

/** The immutable baseline owns retained tests; candidate source owns implementations. */
export async function planSuite(root = appRoot, baseline = baselineCommit, updates = retainedUpdates[baseline] ?? {}) {
  const retained = JSON.parse(git(root, ['show', `${baseline}:${appPrefix}test-inventory.json`]));
  const inventory = JSON.parse(await fs.readFile(path.join(root, 'test-inventory.json'), 'utf8'));
  checkInventory(inventory, await discoverTests(root));
  const oldFiles = trackedFiles(root, baseline, [`${appPrefix}tests/`, `${appPrefix}${stateTest}`]);
  for (const [name, pin] of Object.entries(updates)) oldFiles.set(name, blob(await retainedUpdate(root, name, pin)));
  for (const name of retiredPaths[baseline] ?? []) oldFiles.delete(name);
  const currentFiles = new Map(await Promise.all((await treeFiles(path.join(root, 'tests'))).map(async name => [`tests/${name}`, blob(await fs.readFile(path.join(root, 'tests', name)))])));
  try { currentFiles.set(stateTest, blob(await fs.readFile(path.join(root, stateTest)))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const testNames = new Set([...Object.values(retained).flat(), ...Object.values(inventory).flat()]);
  const supportHash = files => digest(JSON.stringify([...files].filter(([name]) => !testNames.has(name)).sort()));
  const support = { baseline: supportHash(oldFiles), candidate: supportHash(currentFiles) };
  const item = (source, name, files) => {
    assert((name.startsWith('tests/') || name === stateTest) && !name.split('/').includes('..'), `Invalid regression path: ${name}`);
    assert(files.has(name), `Missing ${source} UI regression: ${name}`);
    return { source, name, blob: files.get(name) };
  };
  assert(retained.ui.length > 0 && inventory.ui.length > 0, 'The UI inventory must not be empty');
  assert(retained.desktop.includes(stateTest), 'The checkpoint must retain the saved-workspace regression');
  const retainedNames = [stateTest, ...retained.ui].filter(name => !(retiredPaths[baseline] ?? []).includes(name));
  const files = retainedNames.map(name => item('baseline', name, oldFiles));
  for (const name of [...(inventory.desktop.includes(stateTest) ? [stateTest] : []), ...inventory.ui]) {
    if (support.baseline !== support.candidate || !retainedNames.includes(name) || currentFiles.get(name) !== oldFiles.get(name)) files.push(item('candidate', name, currentFiles));
  }
  return { baseline, support, files };
}

export function passingCounts(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `Missing or duplicate TAP ${key} count`);
    counts[key] = Number(matches[0][1]);
  }
  assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid TAP counts');
  assert(counts.tests > 0 && counts.pass === counts.tests, 'UI tests must have positive passes');
  assert(['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0), 'UI tests failed, skipped, cancelled or pending');
  return counts;
}

/** Keep baseline fixtures beside their tests, but resolve production imports and out/ to the candidate. */
export async function prepareBaseline(root = appRoot, baseline = baselineCommit, updates = retainedUpdates[baseline] ?? {}) {
  // Keep screenshot sockets short, on a filesystem that supports the Trash cleanup.
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'eu-'));
  try {
    const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
    const archive = git(repository, ['archive', baseline, `${appPrefix}tests`, `${appPrefix}${stateTest}`], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const retainedRoot = path.join(scratch, appPrefix);
    for (const [name, pin] of Object.entries(updates)) {
      const bytes = await retainedUpdate(root, name, pin);
      await fs.mkdir(path.dirname(path.join(retainedRoot, name)), { recursive: true });
      await fs.writeFile(path.join(retainedRoot, name), bytes);
    }
    for (const name of retiredPaths[baseline] ?? []) execFileSync('gio', ['trash', path.join(retainedRoot, name)]);
    // /init and /personal compare the renderer with the candidate terminal's canonical resources.
    await fs.symlink(path.join(repository, 'codex-rs'), path.join(scratch, 'codex-rs'));
    for (const entry of await fs.readdir(root)) {
      if (entry === 'desktop') {
        for (const child of await fs.readdir(path.join(root, entry))) if (child !== 'state.test.cjs') {
          await fs.symlink(path.join(root, entry, child), path.join(retainedRoot, entry, child));
        }
      } else if (entry !== 'tests') await fs.symlink(path.join(root, entry), path.join(retainedRoot, entry));
    }
    return { scratch, root: retainedRoot };
  } catch (error) { execFileSync('gio', ['trash', scratch]); throw error; }
}

export async function runUiFile(file, root, evidence, home, env = process.env) {
  const childEnv = { ...env, HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'),
    ELPIS_CONFIG_DIR: path.join(home, 'elpis'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), TMPDIR: path.dirname(home),
    EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots') };
  await fs.mkdir(childEnv.TMPDIR, { recursive: true });
  delete childEnv.NODE_TEST_CONTEXT;
  console.log(`RUN ${file.source}: ${file.name}`);
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file.name], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 185000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await fs.writeFile(path.join(evidence, `${file.source}-${file.name.replaceAll('/', '-')}.tap`), output);
  assert.equal(result.status, 0, `${file.source}/${file.name} failed: ${result.error?.message || output.slice(-1800)}`);
  // Node counts an empty file's wrapper as one passing test. Require actual named cases too.
  const cases = [...output.matchAll(/^# Subtest: (.+)\r?$/gm)].map(match => match[1])
    .filter(name => name !== file.name && !name.endsWith(`/${file.name}`));
  assert(cases.length > 0, `${file.name} executed no named test cases`);
  return { ...file, ...passingCounts(output), cases };
}

function checkResults(plan, files) {
  assert.equal(files.length, plan.files.length, 'UI receipt omits regression files');
  for (let i = 0; i < files.length; i++) {
    const { source, name, blob: hash } = files[i];
    assert.deepEqual({ source, name, blob: hash }, plan.files[i], 'UI receipt has stale or changed tests');
    assert(Array.isArray(files[i].cases) && files[i].cases.every(value => typeof value === 'string')
      && files[i].cases.some(value => value !== name && !value.endsWith(`/${name}`)), 'UI receipt has no named test cases');
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, files[i][key]]));
    assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid UI receipt counts');
    passingCounts(Object.entries(counts).map(([key, value]) => `# ${key} ${value}`).join('\n'));
  }
}

/** Exposed for a trusted installer to verify an older candidate without executing that candidate's installer. */
export async function verifyRendererReceipt({ root = appRoot, out = path.join(root, 'out'), commit = git(root, ['rev-parse', 'HEAD']).trim(), baseline = baselineCommit } = {}) {
  const receipt = JSON.parse(await fs.readFile(path.join(out, receiptName), 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Unsupported UI receipt');
  assert.equal(receipt.commit, commit, 'UI receipt belongs to another commit');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer belongs to another commit');
  const plan = await planSuite(root, baseline);
  assert.equal(receipt.planHash, digest(JSON.stringify(plan)), 'UI receipt uses a different regression checkpoint');
  assert.equal(receipt.baseline, baseline, 'UI receipt uses a different baseline');
  checkResults(plan, receipt.files);
  assert.equal(receipt.rendererHash, await rendererHash(out), 'Renderer bytes changed after UI verification');
  return receipt;
}

/** Preserve the plan's order and membership; only its execution is partitioned. */
export function slicePlan(plan, shardIndex, shardCount) {
  assert(Number.isSafeInteger(shardCount) && shardCount > 0, 'Invalid UI shard count');
  assert(Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount, 'Invalid UI shard index');
  return plan.files.filter((_, index) => index % shardCount === shardIndex);
}

async function emptyEvidence(evidence) {
  assert(evidence && path.isAbsolute(evidence), 'An absolute evidence directory is required');
  await fs.mkdir(evidence, { recursive: true });
  assert.equal((await fs.readdir(evidence)).length, 0, 'Evidence directory must be empty');
}

async function gateSnapshot(root, baseline) {
  const out = path.join(root, 'out');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Commit source changes before UI verification');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer commit does not match source');
  const plan = await planSuite(root, baseline);
  return { schemaVersion: 1, commit, baseline, planHash: digest(JSON.stringify(plan)), rendererHash: await rendererHash(out), plan };
}

function checkManifest(snapshot, manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported UI shard plan');
  slicePlan(snapshot.plan, 0, manifest.shardCount);
  for (const key of ['commit', 'baseline', 'planHash', 'rendererHash']) {
    assert.equal(snapshot[key], manifest[key], `Prepared UI ${key} differs from source or renderer`);
  }
  assert.deepEqual(snapshot.plan, manifest.plan, 'Prepared UI plan differs from source');
}

export async function prepareGate({ root = appRoot, evidence, baseline = baselineCommit, shardCount = 6 } = {}) {
  await emptyEvidence(evidence);
  const manifest = { ...await gateSnapshot(root, baseline), shardCount };
  checkManifest(await gateSnapshot(root, baseline), manifest);
  await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function runGate({ root = appRoot, evidence, baseline = baselineCommit, env = process.env, manifest, shardIndex } = {}) {
  await emptyEvidence(evidence);
  const snapshot = await gateSnapshot(root, baseline);
  const { plan, ...identity } = snapshot;
  if (manifest) checkManifest(snapshot, manifest);
  else assert.equal(shardIndex, undefined, 'A UI shard requires its prepared plan');
  const selected = manifest ? slicePlan(plan, shardIndex, manifest.shardCount) : plan.files;
  const retained = await prepareBaseline(root, baseline);
  try {
    const home = path.join(retained.scratch, 'home');
    await fs.mkdir(home);
    const files = [], failures = [], errors = [];
    for (const file of selected) {
      try { files.push(await runUiFile(file, file.source === 'baseline' ? retained.root : root, evidence, home, env)); }
      catch (error) {
        files.push({ ...file, error: error.message });
        failures.push(error);
        console.error(`FAIL ${file.source}: ${file.name}`);
      }
    }
    // Run every integrity check even after a file fails, and retain those diagnostics too.
    for (const check of [
      async () => assert.equal(await rendererHash(path.join(root, 'out')), identity.rendererHash, 'UI tests changed the renderer bytes'),
      () => assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), identity.commit, 'Source commit changed during UI verification'),
      () => assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during UI verification'),
      async () => assert.equal(digest(JSON.stringify(await planSuite(root, baseline))), identity.planHash, 'UI test sources changed during verification'),
    ]) {
      try { await check(); }
      catch (error) { errors.push(error.message); failures.push(error); }
    }
    if (manifest) {
      const result = { ...identity, shardIndex, shardCount: manifest.shardCount, files, errors };
      await fs.writeFile(path.join(evidence, `shard-${shardIndex}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n\n'));
      checkResults({ files: selected }, files);
      console.log(`Verified shard ${shardIndex + 1}/${manifest.shardCount}: ${files.length} regression files against renderer ${identity.rendererHash}.`);
      return result;
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n\n'));
    checkResults(plan, files);
    const receipt = { ...identity, files };
    await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`Verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
    return receipt;
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
}

/** Only a complete set of passing shards can produce the existing installer receipt. */
export async function mergeGate({ root = appRoot, baseline = baselineCommit, manifest, shards } = {}) {
  const snapshot = await gateSnapshot(root, baseline);
  checkManifest(snapshot, manifest);
  const errors = [], seen = new Set(), byFile = new Map();
  const check = fn => { try { fn(); } catch (error) { errors.push(error); } };
  assert(Array.isArray(shards), 'UI shard results must be an array');
  for (const shard of shards) {
    check(() => assert(shard && typeof shard === 'object', 'Invalid UI shard result'));
    if (!shard || typeof shard !== 'object') continue;
    const label = `UI shard ${shard.shardIndex}`;
    check(() => assert(!seen.has(shard.shardIndex), `Duplicate UI shard ${shard.shardIndex}`));
    seen.add(shard.shardIndex);
    check(() => assert.equal(shard.schemaVersion, 1, `${label} has an unsupported schema`));
    for (const [key, description] of [['commit', 'source commit'], ['baseline', 'baseline'], ['planHash', 'plan hash'], ['rendererHash', 'renderer hash'], ['shardCount', 'shard count']]) {
      check(() => assert.equal(shard[key], manifest[key], `${label} tested a different ${description}`));
    }
    check(() => assert(Array.isArray(shard.errors), `${label} omits integrity results`));
    for (const message of Array.isArray(shard.errors) ? shard.errors : []) errors.push(new Error(`${label}: ${message}`));
    check(() => assert(Array.isArray(shard.files), `${label} omits regression results`));
    for (const file of Array.isArray(shard.files) ? shard.files : []) {
      check(() => assert(file && typeof file === 'object', `${label} has an invalid regression result`));
      if (!file || typeof file !== 'object') continue;
      const key = JSON.stringify([file.source, file.name]);
      check(() => assert(!byFile.has(key), `Duplicate UI regression ${file.source}/${file.name}`));
      byFile.set(key, file);
      if (file.error) errors.push(new Error(`${label}: ${file.source}/${file.name}: ${file.error}`));
    }
    check(() => checkResults({ files: slicePlan(manifest.plan, shard.shardIndex, manifest.shardCount) }, shard.files));
  }
  for (let index = 0; index < manifest.shardCount; index++) {
    check(() => assert(seen.has(index), `Missing UI shard ${index}`));
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n\n'));
  const { plan, ...identity } = snapshot;
  const files = plan.files.map(file => byFile.get(JSON.stringify([file.source, file.name])));
  checkResults(plan, files);
  checkManifest(await gateSnapshot(root, baseline), manifest);
  const receipt = { ...identity, files };
  await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(`Merged ${manifest.shardCount} shards: verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
  return receipt;
}

async function main([mode, ...args]) {
  if (mode === '--prepare') return prepareGate({ evidence: args[0], shardCount: Number(args[1]) });
  if (mode === '--shard' || mode === '--merge') {
    const manifest = JSON.parse(await fs.readFile(args[0], 'utf8'));
    if (mode === '--shard') return runGate({ manifest, shardIndex: Number(args[1]), evidence: args[2] });
    const shards = await Promise.all((await fs.readdir(args[1])).filter(name => /^shard-\d+\.json$/.test(name))
      .sort().map(async name => JSON.parse(await fs.readFile(path.join(args[1], name), 'utf8'))));
    return mergeGate({ manifest, shards });
  }
  assert(mode && !mode.startsWith('--') && args.length === 0, 'Use <evidence> or --prepare <evidence> <count>, --shard <plan.json> <index> <evidence>, --merge <plan.json> <results>');
  return runGate({ evidence: mode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
