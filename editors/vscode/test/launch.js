'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const data = path.join(root, '.test-data', `run-${Date.now()}`);
const fixture = path.join(data, 'project');
fs.mkdirSync(fixture, { recursive: true });
fs.mkdirSync(path.join(data, 'profile', 'User'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
fs.writeFileSync(path.join(fixture, 'sample.ts'), 'export function greet(name: string): string { return name; }\nconst result: number = greet("hello");\nconsole.log(greet("world"));\n');
fs.writeFileSync(path.join(fixture, 'plain.txt'), 'no language provider for this sentinel\n');
fs.writeFileSync(path.join(data, 'profile', 'User', 'settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'typescript.disableAutomaticTypeAcquisition': true, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none' }));
const resultPath = path.join(data, 'result.json');
const args = ['-a', process.execPath, path.join(__dirname, 'electron-launch.js'), process.env.VSCODE_EXECUTABLE || 'code', '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(data, 'profile'), '--extensions-dir', path.join(data, 'extensions'), '--extensionDevelopmentPath=' + (process.env.ELPIS_EDITOR_TEST_EXTENSION || root), '--extensionTestsPath=' + path.join(__dirname, 'editor.test.js'), fixture];
if (process.env.ELPIS_EDITOR_TEST_CDP) args.push('--remote-debugging-port=' + process.env.ELPIS_EDITOR_TEST_CDP);
const child = spawn('xvfb-run', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELPIS_EDITOR_TEST_RESULT: resultPath, ELPIS_EDITOR_TEST_DATA: data } });
const log = fs.createWriteStream(path.join(data, 'vscode.log'));
child.stdout.pipe(log); child.stderr.pipe(log);
const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
child.on('exit', code => {
  clearTimeout(timer);
  if (fs.existsSync(resultPath)) console.log(fs.readFileSync(resultPath, 'utf8'));
  console.log(`Editor test artifacts: ${data}`);
  let passed = false;
  try { passed = !JSON.parse(fs.readFileSync(resultPath, 'utf8')).failure; } catch {}
  process.exitCode = code || (passed ? 0 : 1);
});
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
