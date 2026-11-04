'use strict';

const { ItemView, Plugin, Notice, addIcon } = require('obsidian');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VIEW_TYPE_WORKFLOWS = 'elpis-workflows-view';
const WORKFLOWS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.544 1.544 236.971 236.971"><path fill-rule="evenodd" fill="currentColor" d="M 106.2 34.3 L 91.9 42.5 92.2 58.4 L 92.5 74.4 103.2 80.7 L 114 87.1 114 100.9 L 114 114.8 103.2 124.9 L 92.5 134.9 72 135.1 C 60.7 135.3, 50.1 135.4, 48.5 135.4 L 45.5 135.6 45.2 155.8 L 44.9 176 37.1 176 C 30.2 176, 29.0 176.2, 27.1 178.3 C 25.1 180.4, 25 181.6, 25 194.7 L 25 208.8 28.0 211.4 L 31.1 214 51.8 214 L 72.6 214 75.2 211.2 C 77.8 208.5, 77.8 208.4, 77.4 194.1 C 76.8 176.4, 76.6 176.0, 64.7 176.0 L 56.9 176 57.2 161.7 L 57.5 147.5 74.9 147.2 L 92.4 146.9 106.1 160.6 L 119.8 174.3 134.1 160.6 L 148.5 147.0 165.7 147.0 L 183 147 183 161.5 L 183 176 175.6 176 C 169.6 176, 167.7 176.4, 165.6 178.0 C 163.0 180.1, 163 180.1, 163 194.3 L 163 208.5 166.4 211.2 L 169.8 214 189.8 214 C 216.4 214, 215.0 215.0, 215.1 194.6 C 215.2 175.9, 215.2 176, 203.3 176 L 195.0 176 194.7 155.7 L 194.5 135.5 171.1 135.2 L 147.7 134.9 136.8 124.8 L 126 114.6 126 100.9 L 126 87.1 137.2 80.7 L 148.5 74.2 148.5 58.4 L 148.5 42.6 138.5 36.7 C 133 33.4, 126.6 29.7, 124.4 28.4 L 120.4 26.0 106.2 34.3"/></svg>`;

function findDesktopRoot() {
  const candidates = [
    '/opt/elpis-desktop/app',
    path.join(os.homedir(), '.local/bin/elpis-app'),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const appDir = resolved.endsWith('/launch') ? path.join(path.dirname(resolved), 'app') : resolved;
      if (fs.existsSync(path.join(appDir, 'bridge/server.mjs'))) return appDir;
    } catch {}
  }
  return null;
}

class WorkflowsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE_WORKFLOWS; }
  getDisplayText() { return 'Elpis Workflows'; }
  getIcon() { return 'elpis-workflows'; }
  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('elpis-workflows-obsidian-container');
    try {
      const baseUrl = await this.plugin.ensureServer();
      const target = new URL(baseUrl);
      target.pathname = '/';
      target.searchParams.set('workspace', 'canvas');
      target.searchParams.set('pane', '1');
      const frame = container.createEl('iframe', {
        cls: 'elpis-workflows-obsidian-frame',
        attr: { src: target.href, allow: 'microphone; clipboard-read; clipboard-write' },
      });
      this.frame = frame;
    } catch (error) {
      const box = container.createDiv({ cls: 'elpis-workflows-obsidian-empty' });
      box.createEl('h3', { text: 'Elpis Workflows requires the local Elpis runtime' });
      box.createEl('p', { text: error.message || String(error) });
      const btn = box.createEl('button', { text: 'Open standalone Workflows window' });
      btn.addEventListener('click', () => this.plugin.openStandalone());
    }
  }
  async onClose() {
    this.frame = null;
  }
}

module.exports = class ElpisWorkflowsPlugin extends Plugin {
  async onload() {
    addIcon('elpis-workflows', WORKFLOWS_SVG);
    this.registerView(VIEW_TYPE_WORKFLOWS, leaf => new WorkflowsView(leaf, this));
    this.addRibbonIcon('elpis-workflows', 'Open Elpis Workflows', () => this.activateView());
    this.addCommand({ id: 'open-elpis-workflows', name: 'Open Multiagent Control Center (Workflows)', callback: () => this.activateView() });
    this.addCommand({ id: 'open-elpis-workflows-window', name: 'Open Multiagent Control Center in standalone window', callback: () => this.openStandalone() });
  }
  async onunload() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }
  openStandalone() {
    const bin = fs.existsSync('/usr/bin/elpis-workflows') ? '/usr/bin/elpis-workflows' : path.join(os.homedir(), '.local/bin/elpis-app');
    const args = bin.endsWith('elpis-workflows') ? [] : ['--workflows-app'];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    new Notice('Opening Elpis Workflows…');
  }
  async ensureServer() {
    if (this.serverUrl) return this.serverUrl;
    const appDir = findDesktopRoot();
    if (!appDir) throw new Error('Install elpis-desktop on this computer to run the local Multiagent Control Center.');
    const nodeBin = fs.existsSync('/opt/elpis-desktop/bin/node') ? '/opt/elpis-desktop/bin/node' : 'node';
    return await new Promise((resolve, reject) => {
      const child = spawn(nodeBin, [path.join(appDir, 'bridge/server.mjs')], {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.serverProcess = child;
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        const line = stdout.split('\n')[0]?.trim();
        if (line && line.startsWith('http://127.0.0.1:')) {
          this.serverUrl = line;
          resolve(line);
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('exit', code => {
        this.serverProcess = null;
        this.serverUrl = null;
        if (!this.serverUrl) reject(new Error(stderr.trim() || `Bridge exited with status ${code}`));
      });
    });
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_WORKFLOWS)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_WORKFLOWS, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
