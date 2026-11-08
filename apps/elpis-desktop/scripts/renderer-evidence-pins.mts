export { pageRemovalApproval, retainedUpdates } from "./renderer-evidence-retained.mts";
export type Pin = {
    blob: string;
    approval: string;
    reason: string;
};
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
// OBSRM: the pageRemovalApproval request also retires these page-only checks.
// Love Spot agents section removed (Masih, 22 Oct: "I said remove the agents section in love spot; it's still there.", a3b057c0f): its two test files go.
// The standalone Love Spot sync (Masih, 22 Oct: "Fix those loose-ends. delete them if we don't need them."): Love Spot lives inside Elpis, the sync tool and its test failed since before that day, so both go.
// These page-only regressions and their fixture are retired; all other baseline tests remain mandatory.
// The Talk panel (Masih, 23 Oct: "remove the talk and matilda buttons. I want to type in the draw board, or draw something. and I EXPECT a reply from Matilda."): its test file is
// split into tests/love-spot-board.test.cjs (what reaches her, where her reply lands, the microphone, navigating away, the toolbar fit); the
// Talk-only checks (the panel, its model picker and hover buttons, quoting a note, its fit) go with the panel.
// Workflow artwork picker was removed in installed source 141be35a2; night-workflows retains pattern, prompt, keyboard and colour proof.
export const retiredPaths: Record<string, string[]> = {
    '988aad0e78bd264c00e435be07598e79f08941e8': ['tests/settings-reorder.test.cjs', 'tests/observability.test.cts', 'tests/temp-root-ui.test.cjs', 'tests/love-agents.test.cjs', 'tests/love-agents-v2.test.cjs', 'tests/love-spot-standalone.test.cjs', 'tests/love-spot-talk.test.cjs', 'tests/workflow-characters.test.cjs'],
};
