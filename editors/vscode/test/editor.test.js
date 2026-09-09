'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');

async function eventually(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(`Timed out: ${label}`);
}
async function replace(document, text) {
  const editor = await vscode.window.showTextDocument(document);
  assert(await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)));
}
async function run() {
  const results = [];
  const evidence = { editor: vscode.version, language: 'VS Code built-in TypeScript language service', results };
  const root = vscode.workspace.workspaceFolders[0].uri;
  const extension = vscode.extensions.getExtension('elpis-local.elpis-editor');
  assert(extension);
  const { EditorBridge, Session } = await extension.activate();
  let enabled = true;
  let approval = async () => true;
  let approvalModeId='ask';
  const bridge = new EditorBridge(vscode, root, { enabled: () => enabled, approve: p => approval(p), approvalMode:()=>approvalModeId });
  const record = (name, data) => results.push({ name, passed: true, ...data });
  try {
    // Xvfb has no window manager. Give the isolated Code window real X11 focus
    // so VS Code routes undo to its editor instead of an unfocused window.
    assert(process.env.ELPIS_EDITOR_TEST_DISPLAY, 'Run through the isolated Xvfb launcher');
    const x11 = { ...process.env, DISPLAY: process.env.ELPIS_EDITOR_TEST_DISPLAY, XAUTHORITY:process.env.ELPIS_EDITOR_TEST_XAUTHORITY };
    const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'code'], { encoding: 'utf8', timeout: 5000, env: x11 }).trim().split('\n');
    execFileSync('xdotool', ['windowfocus', '--sync', windows.at(-1)], { timeout: 5000, env: x11 });
    await eventually(() => vscode.window.state.focused, 'isolated editor window focus');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('elpis.chat');
    assert(!vscode.window.tabGroups.all.flatMap(g=>g.tabs).some(t=>t.input instanceof vscode.TabInputWebview && t.label.startsWith('Elpis')), 'Chat must not occupy an editor tab');
    assert(extension.packageJSON.contributes.views.elpis.some(v=>v.type==='webview' && v.id==='elpis.chatView'));
    record('Chat opens in the secondary sidebar without replacing the code editor');
    record('extension activates and opens actual chat webview');
    const uri = vscode.Uri.joinPath(root, 'sample.ts').toString();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    await vscode.window.showTextDocument(document);
    const original = document.getText();
    const sentinel = 'UNSAVED_' + crypto.randomUUID();
    await replace(document, original + `// ${sentinel}\n`);
    const read = await bridge.execute('editor_read', { uri });
    assert(read.text.includes(sentinel));
    assert(!(await fs.readFile(document.uri.fsPath, 'utf8')).includes(sentinel));
    enabled = false;
    await assert.rejects(bridge.execute('editor_read', { uri }), /disabled/);
    enabled = true;
    record('unsaved positive / disabled and disk negative', { sentinel, version: read.version });
    if (process.env.ELPIS_EDITOR_TEST_UI_ONLY === '1') {
      const { uiEvaluation } = require('./ui-eval');
      await uiEvaluation({ vscode, root, document, sentinel, evidence, eventually });
      return;
    }

    const diagnostics = await eventually(async () => {
      const d = await bridge.execute('editor_diagnostics', { uri });
      return d.diagnostics.some(x => x.code === 2322) && d;
    }, 'real TypeScript diagnostic');
    const definitions = await bridge.execute('editor_definition', { uri, line: 1, character: 24 });
    assert(definitions.results.some(x => x.uri === uri && x.range.start.line === 0));
    const references = await bridge.execute('editor_references', { uri, line: 0, character: 17 });
    assert(references.results.some(x => x.range.start.line === 1));
    assert(references.results.some(x => x.range.start.line === 2));
    const missing = await bridge.execute('editor_definition', { uri: vscode.Uri.joinPath(root, 'plain.txt').toString(), line: 0, character: 0 });
    assert.equal(missing.results.length, 0); assert.match(missing.status, /provider may be missing/);
    record('real diagnostic, definition, references / missing provider negative', { diagnostics, definitions, references, missing });

    const fixed = document.getText().replace('result: number', 'result: string');
    async function propose() { return bridge.execute('editor_propose_edit', { uri, version: document.version, text: fixed, reason: 'The greet function returns a string; result must have string type.' }); }
    const before = document.getText();
    approval = async () => false;
    let proposal = await propose();
    assert.equal((await bridge.execute('editor_apply_edit', proposal)).applied, false);
    assert.equal(document.getText(), before);
    record('rejected edit leaves buffer and disk unchanged');
    approval = async () => { await replace(document, document.getText() + '// newer user edit\n'); return true; };
    proposal = await propose();
    await assert.rejects(bridge.execute('editor_apply_edit', proposal), /Document changed/);
    assert(document.getText().includes('newer user edit'));
    record('newer edit survives stale proposal');
    await replace(document, before);
    approval = async () => true;
    proposal = await propose();
    assert.equal((await bridge.execute('editor_apply_edit', proposal)).applied, true);
    await eventually(async () => !(await bridge.execute('editor_diagnostics', { uri })).diagnostics.some(x => x.code === 2322), 'diagnostic disappears');
    assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), original);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await new Promise(resolve => setTimeout(resolve, 200));
    await vscode.commands.executeCommand('default:undo');
    await eventually(() => document.getText() === before, 'undo document update');
    await eventually(async () => (await bridge.execute('editor_diagnostics', { uri })).diagnostics.some(x => x.code === 2322), 'undo restores diagnostic');
    record('approved edit clears diagnostic, stays unsaved, and undo restores original');
    approvalModeId='auto';approval=async()=>{throw new Error('Auto unexpectedly requested approval');};
    proposal=await propose();
    await replace(document,'// concurrent user edit\n'+document.getText());
    await assert.rejects(bridge.execute('editor_apply_edit',proposal),/Document changed/);
    assert(document.getText().startsWith('// concurrent user edit'));
    await replace(document,before);
    proposal=await propose();bridge.cancel();
    await assert.rejects(bridge.execute('editor_apply_edit',proposal),/expired/);
    assert.equal(document.getText(),before);approvalModeId='ask';
    record('Auto rejects stale and cancelled edits without invoking the approval callback');

    approval = async () => { bridge.cancel(); return true; };
    proposal = await propose();
    await assert.rejects(bridge.execute('editor_apply_edit', proposal), /cancelled/);
    assert.equal(document.getText(), before);
    await assert.rejects(bridge.execute('editor_read', { uri: vscode.Uri.file(path.join(process.env.ELPIS_EDITOR_TEST_DATA, 'profile/User/settings.json')).toString() }), /outside/);
    record('cancelled approval and outside-workspace read rejected');

    // Deterministic model transport; real Elpis subprocess, real editor bridge and providers.
    if (process.env.ELPIS_EDITOR_TEST_RUNTIME) {
      const { runtimeEvaluation } = require('./runtime-eval');
      await runtimeEvaluation({ vscode, root, bridge, document, sentinel, evidence, eventually, EditorBridge, Session });
    } else evidence.runtime = 'Not run: set ELPIS_EDITOR_TEST_RUNTIME to an Elpis-built standalone app-server.';
    if (process.env.ELPIS_EDITOR_TEST_CDP && process.env.ELPIS_EDITOR_TEST_RUNTIME) {
      const { uiEvaluation } = require('./ui-eval');
      await uiEvaluation({ vscode, root, document, sentinel, evidence, eventually });
    }
    if(process.env.ELPIS_EDITOR_TEST_LIVE_ACCOUNT==='1')await require('./live-account').liveAccountEvaluation({vscode,root,evidence,eventually,EditorBridge,Session});
  } catch (error) {
    evidence.failure = error.stack;
    throw error;
  } finally {
    bridge.dispose();
    await fs.writeFile(process.env.ELPIS_EDITOR_TEST_RESULT, JSON.stringify(evidence, null, 2));
  }
}
module.exports = { run };
