'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

(async () => {
  const extension = path.resolve(__dirname, '..');
  const runtime = process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(extension, 'bin/elpis-app-server');
  if (!fs.existsSync(runtime)) throw new Error('Set ELPIS_EDITOR_TEST_RUNTIME to an Elpis app-server binary.');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-ide-startup-'));
  for (const mode of ['empty', 'file', 'folder']) {
    const data = path.join(base, mode);
    fs.mkdirSync(path.join(data, 'project'), { recursive: true });
    fs.writeFileSync(path.join(data, 'project/example.js'), 'const example = true;\n');
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const args = ['-a', 'node', path.join(__dirname, 'electron-launch.js'), process.env.CODEX_VSCODE || 'code',
      '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir=' + path.join(data, 'profile'), '--extensions-dir=' + path.join(data, 'extensions'),
      '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + path.join(__dirname, 'startup-host.js'), '--remote-debugging-port=' + port];
    if (mode !== 'empty') args.push(path.join(data, 'project', ...(mode === 'file' ? ['example.js'] : [])));
    const log = fs.openSync(path.join(data, 'vscode.log'), 'w');
    const child = spawn('xvfb-run', args, { stdio: ['ignore', log, log], env: { ...process.env,
      ELPIS_IDE_STARTUP_DATA: data, ELPIS_IDE_STARTUP_CASE: mode, ELPIS_EDITOR_TEST_CDP: String(port), ELPIS_EDITOR_TEST_RUNTIME: runtime } });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timer); fs.closeSync(log);
    const result = JSON.parse(fs.readFileSync(path.join(data, 'result.json'), 'utf8'));
    console.log(JSON.stringify({ data, code, ...result }));
    if (code !== 0 || !result.passed) throw new Error(mode + ' startup failed; see ' + data);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
