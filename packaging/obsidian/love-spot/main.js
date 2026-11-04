'use strict';

const { ItemView, Plugin, Notice, addIcon } = require('obsidian');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VIEW_TYPE_LOVE_SPOT = 'love-spot-view';
const LOVE_SPOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 225 225"><path fill-rule="evenodd" fill="currentColor" d="M 112.5 62.5 L 88 38 L 52 38 L 24 66 L 24 104 L 112.5 192.5 L 201 104 L 201 66 L 173 38 L 137 38 Z M 112.5 88 L 80.5 56 L 59.5 56 L 42 73.5 L 42 96.5 L 112.5 167 L 183 96.5 L 183 73.5 L 165.5 56 L 144.5 56 Z M 112.5 104 L 130.5 122 L 112.5 140 L 94.5 122 Z"/></svg>`;

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

class LoveSpotView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE_LOVE_SPOT; }
  getDisplayText() { return 'Love Spot'; }
  getIcon() { return 'love-spot'; }
  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('love-spot-obsidian-container');
    try {
      const baseUrl = await this.plugin.ensureServer();
      const target = new URL(baseUrl);
      target.pathname = '/love-spot.html';
      target.searchParams.set('pane', '1');
      const frame = container.createEl('iframe', {
        cls: 'love-spot-obsidian-frame',
        attr: { src: target.href, allow: 'microphone; clipboard-read; clipboard-write' },
      });
      this.frame = frame;
    } catch (error) {
      const box = container.createDiv({ cls: 'love-spot-obsidian-empty' });
      box.createEl('h3', { text: 'Love Spot requires the local Elpis runtime' });
      box.createEl('p', { text: error.message || String(error) });
      const btn = box.createEl('button', { text: 'Open standalone Love Spot window' });
      btn.addEventListener('click', () => this.plugin.openStandalone());
    }
  }
  async onClose() {
    this.frame = null;
  }
}

module.exports = class LoveSpotPlugin extends Plugin {
  async onload() {
    addIcon('love-spot', LOVE_SPOT_SVG);
    this.registerView(VIEW_TYPE_LOVE_SPOT, leaf => new LoveSpotView(leaf, this));
    this.addRibbonIcon('love-spot', 'Open Love Spot', () => this.activateView());
    this.addCommand({ id: 'open-love-spot', name: 'Open Love Spot board', callback: () => this.activateView() });
    this.addCommand({ id: 'open-love-spot-window', name: 'Open Love Spot in standalone window', callback: () => this.openStandalone() });
  }
  async onunload() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }
  openStandalone() {
    const bin = fs.existsSync('/usr/bin/love-spot') ? '/usr/bin/love-spot' : path.join(os.homedir(), '.local/bin/elpis-app');
    const args = bin.endsWith('love-spot') ? [] : ['--love-spot-app'];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    new Notice('Opening Love Spot…');
  }
  async ensureServer() {
    if (this.serverUrl) return this.serverUrl;
    const appDir = findDesktopRoot();
    if (!appDir) throw new Error('Install elpis-desktop or love-spot on this computer to run the local board server.');
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
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LOVE_SPOT)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_LOVE_SPOT, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
