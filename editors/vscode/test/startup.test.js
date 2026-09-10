'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

async function open({ folder = false, file = false, trusted = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-startup-'));
  const uri = value => ({ scheme: 'file', fsPath: value, toString: () => 'file://' + value });
  const root = uri(directory);
  const sessions = [], updates = [], warnings = [], subscriptions = [];
  let provider, handler;
  class Session extends EventEmitter {
    constructor(cwd, bridge, options) { super(); this.cwd = cwd; this.options = options; this.queued = []; sessions.push(this); }
    async send(text) { this.sent = text; }
    emitQueue() {}
    dispose() {}
  }
  const configuration = { get: (key, fallback) => fallback, update: async (...args) => updates.push(args) };
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => ({ ...uri(path.join(base.fsPath, ...parts)), scheme: base.scheme }) },
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
    workspace: {
      isTrusted: trusted, workspaceFolders: folder ? [{ name: 'project', uri: root }] : [],
      getConfiguration: () => configuration,
      getWorkspaceFolder: () => folder ? { uri: root } : undefined,
      onDidChangeWorkspaceFolders: () => ({}), onDidChangeConfiguration: () => ({}),
      fs: { createDirectory: async location => fs.mkdirSync(location.fsPath, { recursive: true }) },
    },
    window: {
      activeTextEditor: file ? { document: { uri: uri(path.join(directory, 'example.js')) } } : undefined,
      showWarningMessage: text => warnings.push(text),
      registerWebviewViewProvider: (id, value) => { provider = value; return {}; },
    },
    commands: { registerCommand: () => ({}) },
  };
  const context = { subscriptions, extensionUri: uri(path.resolve(__dirname, '..')),
    globalStorageUri: { ...uri(path.join(directory, 'storage')), scheme: 'vscode-userdata' },
    workspaceState: { get: (key, fallback) => fallback }, secrets: { get: async () => undefined } };
  const filename = path.resolve(__dirname, '../src/extension.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(name => {
    if (name === 'vscode') return vscode;
    if (name === './session') return { Session };
    if (name === './ide-context') return { startContextService: async () => ({ dispose() {} }) };
    return localRequire(name);
  }, module, module.exports);
  module.exports.activate(context);
  const panel = { onDidDispose: () => ({}), webview: {
    cspSource: 'test:', asWebviewUri: value => value.toString(), postMessage: async () => true,
    onDidReceiveMessage: value => { handler = value; return {}; }, html: '',
  } };
  try {
    await provider.resolveWebviewView(panel);
    return { directory, sessions, updates, warnings, panel, handler,
      cleanup: () => { subscriptions.forEach(value => value.dispose?.()); fs.rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

for (const [name, options] of [['fresh project', { folder: true }], ['file-only window', { file: true }], ['empty window', {}]]) {
  test(`${name} opens a composer and accepts the first message without a previous session`, async () => {
    const result = await open(options);
    try {
      assert.match(result.panel.webview.html, /id="prompt"/);
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].options.resumeThreadId, undefined);
      assert(fs.statSync(result.sessions[0].cwd).isDirectory());
      if (options.folder || options.file) assert.equal(result.sessions[0].cwd, result.directory);
      else assert(result.sessions[0].cwd.startsWith(path.join(result.directory, 'storage') + path.sep));
      await result.handler({ type: 'send', text: 'First chat without history' });
      assert.equal(result.sessions[0].sent, 'First chat without history');
      await result.handler({ type: 'access' });
      assert.equal(result.updates.at(-1)[2], options.folder ? 3 : 1);
    } finally { result.cleanup(); }
  });
}

test('an untrusted window cannot create a runtime session', async () => {
  const result = await open({ file: true, trusted: false });
  try { assert.equal(result.sessions.length, 0); assert.match(result.warnings[0], /Trust/); }
  finally { result.cleanup(); }
});
