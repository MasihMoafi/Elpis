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
    "tests/controls.cjs": {
      "blob": "88c707e2a62524bbd4e6b2ce37d650ed556cba36",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Read the fallback input or catalog select atomically as the catalog loads; keep A87's logo-colour guards. Footer, Masih 22 Oct: \"theme should be next to settings\". The helpers open Settings with the gear and switch the theme with its button (c88df8e6d)."
    },
    "tests/input-hints.test.cjs": {
      "blob": "8709043fe7d186dde635579ca33e30fe481ba62f",
      "approval": "81bb605d3b191da40fe95d499505acd12234f8b5",
      "reason": "S1/R34, Masih 22 Oct: \"This enter ID or the model name is unacceptable. There should always be the dropdown menu.\" The RAG models are menus; the long-hint check reads their typed fields behind Advanced: custom model."
    },
    "tests/sidebar-order.test.cjs": {
      "blob": "d92fe9f449dc5d4014145c5b29f45c885d963666",
      "approval": "767050d573b68387feea4bf67f90df69f7ec96d8",
      "reason": "The Session Manager is a switch, not a chat; running chats sit above the others. Masih 22 Oct: \"the session manager I don't want to see it chat with us, it doesn't any good. I already told you the orange marked ones (the sessions that are running) must be on top\". The A100 manager tests now check the switch, the hidden chat and the saved choice; the A102 waiting test expects running chats after waiting ones; every other order assertion is unchanged."
    },
    "tests/sidebar.test.cjs": {
      "blob": "f6592d9d87eca70ef857a22f709daeb34e06f0f7",
      "approval": "767050d573b68387feea4bf67f90df69f7ec96d8",
      "reason": "The Session Manager is a switch, not a chat. Masih 22 Oct: \"people should be able to turn on and off the session manager right there ... I don't want to see it chat with us\". The sidebar test checks the switch above the list and that it never creates a chat; the rest is unchanged. Chat menu, Masih 22 Oct: \"it shouldn't have this show agents when there are no agents!\" The row menu of a chat with no agents offers none (c88df8e6d)."
    },
    "tests/desktop-small-fixes.test.cjs": {
      "blob": "e0ed82d0eb6cccaed1d06ea42d9f6d6ace180974",
      "approval": "767050d573b68387feea4bf67f90df69f7ec96d8",
      "reason": "The Session Manager row is a switch. Masih 22 Oct: \"people should be able to turn on and off the session manager right there\". The arrow-key walk still stops on the row, now a switch; every other step is unchanged."
    },
    "tests/chat-groups.test.mjs": {
      "blob": "2df494abc42feb2c83e34ea9259c25050ebfad6b",
      "approval": "767050d573b68387feea4bf67f90df69f7ec96d8",
      "reason": "Running chats come after waiting ones and before unseen replies. Masih 22 Oct: \"I already told you the orange marked ones (the sessions that are running) must be on top\". Only the priority-order assertions changed."
    },
    "tests/browser-drawing.test.cjs": {
      "blob": "4282b57ba27181f3ad642d668316c2f9e7e5c61c",
      "approval": "81bb605d3b191da40fe95d499505acd12234f8b5",
      "reason": "S21, Masih 22 Oct: \"when you click on it the browser goes away and a new page opens, can't we use the same draw in the same page with the brower unmoved?\" The drawing fills the browser panel it opened from instead of the whole window; every other drawing assertion is unchanged. Annotation note, Masih 22 Oct: \"when we anotate and send it shows the browser note to the user. it shouldn't .\" The drawing context note is no longer shown as a chip; it is still sent (a3b057c0f)."
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
    "tests/page-column.test.cjs": {
      "blob": "4a45579c8292e33530b15e6c793a6825e7a89b99",
      ...pageRemovalApproval
    },
    "tests/page-column.cjs": {
      "blob": "0b7fed1852f2513490a63ad2d28f3699bfbd54f5",
      "approval": "189f5bd0d80042f037527d5653edf7b0f156c7b9",
      "reason": "A126: shared column measurements cover the centred page shells"
    },
    "tests/view-boundaries.test.cjs": {
      "blob": "b77da2a3d0cb0a6ba70aa2a7fd7f4d66ba6afb1e",
      ...pageRemovalApproval
    },
    "tests/provider-usage.test.cjs": {
      "blob": "f7224436280cca61f9856afdde3b606d8687e5a5",
      "approval": "988aad0e78bd264c00e435be07598e79f08941e8",
      "reason": "Initial SSE connection refreshes accounts; retain exact request deltas for every subsequent action"
    },
    "tests/claude-chat.test.cjs": {
      "blob": "0808f78884331931a6ce04a1e4ab0f47a9af62aa",
      "approval": "dd2ca3576700a0c448c37aed1aea3fd417b9c036",
      "reason": "A121, Masih: \"You don't need to ask me that; I'm result-oriented.\" Await native scroll delivery alongside the mocked clock, keeping the last-prompt assertion and adding a no-pullback check. Keep the already approved OBSRM navigation update."
    },
    "tests/command-menu.test.cjs": {
      "blob": "335dcdab0114fafb0e45c3af362501bc7c8f13d2",
      ...pageRemovalApproval
    },
    "tests/composer-files.test.cjs": {
      "blob": "f1f0bcca23d00215aab2efe36267ba750cbfb7e2",
      ...pageRemovalApproval
    },
    "tests/desktop-polish.test.cjs": {
      "blob": "0ec66f04a4a7dba9158e6add376ff28761c6f871",
      ...pageRemovalApproval
    },
    "tests/desktop-small-fixes.test.cjs": {
      "blob": "e0ed82d0eb6cccaed1d06ea42d9f6d6ace180974",
      ...pageRemovalApproval
    },
    "tests/desktop-sweep.test.cjs": {
      "blob": "d58e3ba4cc69d493c73810be57269eb0f0b71c38",
      "approval": "ac82360bda390fea91268f3a263cd9375b2af175",
      "reason": "SETTINGS2, Masih's GATE12 handoff (approved 21 Oct 22:45): \"Personalization file editors, sizes and corners, sleep prevention, shortcut search, a new About page\" The approved About page joins the exact page order and every fit check; keep the approved OBSRM navigation checks."
    },
    "tests/love-spot-pages.test.cjs": {
      "blob": "e3d0115cac2c58f459fe7e69b4eff4b5706d06c0",
      ...pageRemovalApproval
    },
    "tests/navigation-drafts.test.cjs": {
      "blob": "ad6820b974ced60ccec52acf2fdf60f3481f42d3",
      ...pageRemovalApproval
    },
    "tests/settings-pages.test.cjs": {
      "blob": "45e8e8446314e6dc671e70f085aee69127473537",
      "approval": "279499d6bed5a579413834c6e7bc3e4d35006bfd",
      "reason": "SETTINGS2, Masih's GATE12 handoff (approved 21 Oct 22:45): \"Personalization file editors, sizes and corners, sleep prevention, shortcut search, a new About page\" Include the approved About page and shortcut search; assert About identity, release link and no writes; retain every control-write, reload, page-order and narrow-layout assertion. S5/R37, Masih 22 Oct: \"it's the same as the enable memories yet one is off and the other is on\": Memories is one master switch and its options appear only when it is on."
    },
    "tests/settings-write.test.cjs": {
      "blob": "09f90ee692006240e183eb49d99051431d05de7b",
      "approval": "279499d6bed5a579413834c6e7bc3e4d35006bfd",
      "reason": "S5/R37, Masih 22 Oct: \"it's the same as the enable memories yet one is off and the other is on\": the memory options show only while Memories is on, so the saved-settings fixture has Memories on; every version-chained save assertion is unchanged."
    },
    "tests/context-menu.test.cjs": {
      "blob": "3f99bf0cdc98f059df5187122c504114e0c2e717",
      "approval": "ff010db233ed8c4aea32cdb295b58afbad1c30b0",
      "reason": "F2 rename, Masih's request: \"F2 rename\" (docs/USER_REQUESTS.md, 21 October integration). GATE12: \"never weaken or delete an assertion that still describes wanted behaviour\". Await actual menu focus before sending F2, and its removal before Escape; keep every save, cancel, modifier and typing assertion. Chat menu, Masih 22 Oct: \"it shouldn't have this show agents when there are no agents!\" Show agents leaves the menu of a chat without agents (c88df8e6d)."
    },
    "tests/preferences.test.cjs": {
      "blob": "2a27c24660a0a2d14da383b02f7ad95ab2e6529f",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "OBSRM page removal (see pageRemovalApproval) plus SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Two shortcut tests added; no existing assertion removed. Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" (efb597b8b) The send-hint assertion goes with sendHint, which nothing calls."
    },
    "tests/renderer.test.cjs": {
      "blob": "58cfcc2abc3d705b01819ca73ffa862004881c83",
      ...pageRemovalApproval
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
      "blob": "84bfb13ee065c938ca9006268d585efa9f18580a",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "SETTINGS, Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Both models now have custom editors: target Background choices, verify the Main editor stays closed and enter an exact custom draft; preserve the approved OBSRM navigation checks."
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
      "blob": "3fde4827aa6a0ecc7e8512bbe41fa8eeca8c54a1",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "SETTINGS, Masih 21 Oct 22:45: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" The default is now an inline editor; assert the exact unset and externally saved values and zero writes."
    },
    "tests/customize.test.cjs": {
      "blob": "f5fd374f832bb88d2c97a72763d9793aaf38a61d",
      "approval": "ef1a6199498a80ddafb94d14afcee3eccdc4412e",
      "reason": "LEDGER, Masih's approved request in GATE11: \"MCP and plugin switches, Add plugins\". Supply writable versions and check both switch states, metadata and exact save requests; keep skill and navigation checks."
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
      "blob": "d7d595ebcb1f61fbd05f65a577ac30f9d9608069",
      "approval": "38ecd3dc0cd1d53c1b34b82897beb3f201a5869e",
      "reason": "SETTINGS and SETTINGS2 (adds the About page), Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Audit the entire multiline model editor, excluding closed disclosure contents; preserve single-line heights, control sizes, alignment and clipping checks."
    },
    "tests/settings-rows.test.cjs": {
      "blob": "cb68c8db5ff63c8bbb6dd9d18d94221937ac8797",
      "approval": "843fcac1416a9cc485d141e78a381fb6707546e6",
      "reason": "SETTINGS, Masih: \"in the settings I can't change whatever I want, there are limits. There shouldn't be.\" Retain every page and existing drift mutation; add closed/open model disclosures and independent compound alignment, size and clipping mutations."
    },
    "tests/sidebar-indent.test.cjs": {
      "blob": "5bb88e37e24230393592abe93c2e3d46ef669805",
      "approval": "ef56904fcd8b39725632b4c24ca574cf8ab63d1e",
      "reason": "V1, Masih's approved request in GATE11: \"every chat row uses the project-chat layout, all chevrons in one column\". Retain exact circle/title coordinates, hover, expansion, selection and reload checks in both themes."
    },
    "tests/tabs.test.cjs": {
      "blob": "11efb2427b9ce0dfe3d383fdfdc8b72bc18ad969",
      "approval": "efb597b8b6ce2adf92546a544b3688d39016ee30",
      "reason": "Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" Removes the screenshot probe, whose first line returns when no screenshot folder is set and which asserts nothing."
    },
    "tests/settings-reorder.test.cjs": {
      "blob": "ffe378c097f6eef6a88506a8682deaf5c3b0785f",
      "approval": "efb597b8b6ce2adf92546a544b3688d39016ee30",
      "reason": "Junk tests, Masih 22 Oct: \"it's not a thing you run. it's a skill. You identify and delete the junk tests.\" Removes the sidebar reorder test that tests/desktop-small-fixes.test.cjs repeats with stronger assertions."
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
    "tests/view-errors.test.cjs": {
      "blob": "5dec1ecf6fa40788b16f9aced96f48e962347755",
      "approval": "dd2ca3576700a0c448c37aed1aea3fd417b9c036",
      "reason": "A121/GATE11, Masih: \"never weaken or delete an assertion that still describes wanted behaviour\". dd2ca3576 gave navigation rows accessible names: scope every bad-reply assertion to the Ledger page instead of its same-named shortcut; all error and survival checks remain."
    }
  }
};
// OBSRM: the pageRemovalApproval request also retires these page-only checks.
// Love Spot agents section removed (Masih, 22 Oct: "I said remove the agents section in love spot; it's still there.", a3b057c0f): its two test files go.
// These page-only regressions and their fixture are retired; all other baseline tests remain mandatory.
export const retiredPaths = {
  '988aad0e78bd264c00e435be07598e79f08941e8': ['tests/observability.test.cjs', 'tests/temp-root-ui.test.cjs', 'tests/love-agents.test.cjs', 'tests/love-agents-v2.test.cjs'],
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
