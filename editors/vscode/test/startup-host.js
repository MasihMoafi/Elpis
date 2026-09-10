'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { Provider, message } = require('./runtime-eval');
const { WebviewDOM } = require('./webview-cdp');

async function eventually(fn, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}

async function run() {
  const data = process.env.ELPIS_IDE_STARTUP_DATA;
  const home = path.join(data, 'elpis-home');
  const provider = new Provider();
  const result = { case: process.env.ELPIS_IDE_STARTUP_CASE, passed: false };
  let dom;
  try {
    assert.equal((vscode.workspace.workspaceFolders || []).length, result.case === 'folder' ? 1 : 0);
    if (result.case === 'file') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(data, 'project', 'example.js')));
    await fs.mkdir(home, { recursive: true });
    await provider.start();
    const inference = provider.server.listeners('request')[0];
    provider.server.removeListener('request', inference);
    provider.server.on('request', (request, response) => {
      if (request.method === 'GET' && new URL(request.url, provider.url).pathname.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
      } else inference(request, response);
    });
    await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "startup_eval"\n[model_providers.startup_eval]\nname = "Controlled startup provider"\nbase_url = ${JSON.stringify(provider.url)}\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    const config = vscode.workspace.getConfiguration('elpis');
    for (const [key, value] of Object.entries({ home, executable: process.env.ELPIS_EDITOR_TEST_RUNTIME, accountSource: 'elpis' })) await config.update(key, value, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('elpis-local.elpis-editor').activate();
    const x11 = { ...process.env, DISPLAY: process.env.ELPIS_EDITOR_TEST_DISPLAY, XAUTHORITY: process.env.ELPIS_EDITOR_TEST_XAUTHORITY };
    const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'code'], { env: x11, encoding: 'utf8' }).trim().split('\n');
    execFileSync('xdotool', ['windowfocus', '--sync', windows.at(-1)], { env: x11 });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('elpis.chat');
    await eventually(async () => { dom ||= await WebviewDOM.connect(process.env.ELPIS_EDITOR_TEST_CDP); return !!dom; }, 'composer in actual VS Code');
    for (let turn = 1; turn <= 2; turn++) {
      if (turn === 2) {
        await dom.locator('#reconnect').click();
        await eventually(async () => !await dom.evaluate('d.getElementById("welcome").classList.contains("hidden")'), 'new conversation reset');
      }
      const sentinel = `STARTUP_${result.case}_${turn}_OK`;
      provider.actions.push(message(sentinel));
      await dom.locator('#prompt').fill('Reply to this new chat.');
      await eventually(async () => !await dom.evaluate('d.getElementById("send").disabled'), 'enabled send button');
      await dom.locator('#send').click();
      await eventually(async () => (await dom.evaluate('d.body.textContent') || '').includes(sentinel), 'real runtime response ' + turn);
      await eventually(async () => (await dom.evaluate('d.getElementById("send").getAttribute("aria-label")')) === 'Send message', 'turn completion');
    }
    assert.equal(provider.requests.length, 2);
    assert.ifError(provider.error);
    result.passed = true;
    result.responses = provider.requests.length;
  } catch (error) {
    result.error = error.stack;
    result.body = dom && await dom.evaluate('d.body.textContent');
    result.requests = provider.requests.length;
    result.targets = await (await fetch(`http://127.0.0.1:${process.env.ELPIS_EDITOR_TEST_CDP}/json`)).json();
    throw error;
  }
  finally {
    dom?.close();
    if (provider.server) provider.close();
    await fs.writeFile(path.join(data, 'result.json'), JSON.stringify(result, null, 2));
  }
}
module.exports = { run };
