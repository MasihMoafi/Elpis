#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Provider, message } = require('../lib/mock-provider.js');

const repo = path.resolve(__dirname, '../..');
const onLabel = '[━━━●] ON';
const offLabel = '[●━━━] OFF';
// Retain the old controls only to demonstrate the baseline failure on an older binary.
const legacyCloseLabels = [' ╳ ', ' ✕ Close '];
const ledgerOpen = text => text.includes('CONTEXT LEDGER');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; });

function options() {
  const args = process.argv.slice(2);
  const smoke = args.at(-1) === '--smoke';
  if (smoke) args.pop();
  assert.equal(args.length, 6, 'Usage: ledger-close-placement.cjs --binary PATH --output EMPTY_DIR --phase baseline|candidate [--smoke]');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--binary', '--output', '--phase'].includes(args[i]) && !values[args[i]], `Unexpected or duplicate option: ${args[i]}`);
    values[args[i]] = args[i + 1];
  }
  assert(['baseline', 'candidate'].includes(values['--phase']), 'Phase must be baseline or candidate');
  const binary = fs.realpathSync(values['--binary']);
  fs.accessSync(binary, fs.constants.X_OK);
  const output = path.resolve(values['--output']);
  fs.mkdirSync(output, { recursive: true });
  assert.equal(fs.readdirSync(output).length, 0, 'Output directory must be empty; existing evidence is never overwritten');
  return { binary, output, phase: values['--phase'], smoke };
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function stopServer(server) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, pause(3000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await Promise.race([exited, pause(3000)]);
    assert(server.exitCode !== null || server.signalCode !== null, 'Private app-server did not stop');
  }
}

async function check({ binary, output, phase, smoke }, width, light) {
  const label = `${width}-${light ? 'light' : 'dark'}`;
  // Keep owned profiles on the evidence directory's mount, where gio trash works.
  const fixtureBase = output;
  assert(Buffer.byteLength(path.join(fixtureBase, 't7-ledger-XXXXXX', 'tmux')) < 100, 'Home-cache path is too long for a private tmux socket');
  fs.mkdirSync(fixtureBase, { recursive: true, mode: 0o700 });
  const fixture = fs.mkdtempSync(path.join(fixtureBase, 't7-ledger-'));
  fs.chmodSync(fixture, 0o700);
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'workspace');
  // This is the entire environment of both the tmux server and native processes.
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, ELPIS_HOME: home,
    CODEX_HOME: home, CODEX_AUTH_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    ELPIS_NO_CLAUDE: '1', ELPIS_NO_AGY: '1',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
  };
  const socket = path.join(fixture, 'tmux');
  const tm = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
    env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = ansi => tm('capture-pane', '-p', '-N', ...(ansi ? ['-e'] : []), '-t', 'check');
  const key = name => tm('send-keys', '-t', 'check', name);
  const literal = text => tm('send-keys', '-t', 'check', '-l', text);
  const click = (x, y) => literal(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
  const save = name => {
    const text = capture(false);
    fs.writeFileSync(path.join(output, `${label}-${name}.txt`), text);
    fs.writeFileSync(path.join(output, `${label}-${name}.ansi`), capture(true));
    return text;
  };
  const deadline = Date.now() + 45_000;
  const active = () => {
    assert(!interrupted, `Interrupted by ${interrupted}`);
    assert(Date.now() < deadline, 'Private terminal case exceeded 45 seconds');
  };
  async function until(predicate) {
    for (;;) {
      active();
      const text = capture(false);
      if (text.includes('Hooks need review')) key('Escape');
      if (predicate(text)) return text;
      await pause(100);
    }
  }
  const provider = new Provider();
  let server, serverError, serverLog = '', tmuxStarted = false;
  const result = { width, light, phase, errors: [] };
  const must = (condition, message) => { if (!condition) result.errors.push(message); };
  try {
    active();
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(cwd, { mode: 0o700 });
    await provider.start();
    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project fixture\nPrivate Ledger pointer check.\n');
    fs.writeFileSync(path.join(home, 'config.toml'), [
      `model_catalog_json=${JSON.stringify(path.join(repo, 'codex-rs/models-manager/models.json'))}`,
      'model="gpt-6-luna"', 'model_provider="fixture"', 'approval_policy="never"', 'sandbox_mode="read-only"',
      '[features]', 'code_mode=false', '[model_providers.fixture]', 'name="Idle terminal fixture"',
      `base_url=${JSON.stringify(provider.url)}`, 'wire_api="responses"', 'requires_openai_auth=false',
      '[tui]', 'alternate_screen="always"', 'fullscreen_transcript=true', 'animations=false',
      'disable_paste_burst=true', 'copy_on_select="never"',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level="trusted"',
    ].join('\n'), { mode: 0o600 });
    server = spawn(binary, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.on('error', error => { serverError = error; });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-131072); });
    while (!/ws:\/\/127\.0\.0\.1:\d+/.test(serverLog)) {
      active();
      assert(!serverError, `Private app-server failed: ${serverError}`);
      assert(server.exitCode === null && server.signalCode === null, 'Private app-server exited before listening');
      await pause(100);
    }
    const address = serverLog.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
    tm('new-session', '-d', '-s', 'check', '-x', String(width), '-y', '40', '/bin/bash --noprofile --norc');
    tmuxStarted = true;
    tm('set-option', '-g', 'status', 'off');
    tm('set-option', '-p', '-t', 'check', 'window-style', light ? 'fg=#111111,bg=#ffffff' : 'fg=#eeeeee,bg=#111111');
    literal(['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), binary, '--remote', address, '-C', cwd].map(quote).join(' '));
    key('Enter');
    await until(ledgerOpen);
    await pause(200);
    // Real native transcript rendering, with a deterministic local inference response.
    // Dense lines expose both covered glyphs and a missing gap; idle screens cannot.
    provider.actions.push(message(Array(80).fill('X'.repeat(600)).join('\n')));
    literal('Render the Ledger clearance fixture'); key('Enter');
    await until(text => text.includes('X'.repeat(20)) && !text.includes('esc to interrupt'));
    await pause(200);
    const text = save('open');
    const lines = text.split('\n');
    const titleY = lines.findIndex(line => line.includes('CONTEXT LEDGER'));
    const controlLabel = lines[titleY].includes(onLabel) ? onLabel
      : legacyCloseLabels.find(label => lines.some(line => line.includes(label)));
    assert(controlLabel, 'Ledger title must include its ON toggle');
    const controlY = lines.findIndex(line => line.includes(controlLabel));
    const left = lines[controlY].indexOf(controlLabel);
    result.geometry = { controlY, titleY, left, buttonWidth: [...controlLabel].length };
    result.layoutPass = controlLabel === onLabel && controlY === 0 && titleY === 0 && !/[╳×✕]/u.test(text);
    result.layoutAssertion = result.layoutPass ? 'PASS' : `FAIL: ${JSON.stringify(controlLabel)} on row ${controlY}; expected title and ON toggle together on row 0, with no Close row`;
    const ledgerLeft = lines[titleY].indexOf('CONTEXT LEDGER') - 2;
    const xExtent = text => Math.max(-1, ...text.split('\n').map(row =>
      row.includes('X'.repeat(8)) ? row.lastIndexOf('X') : -1));
    const openExtent = xExtent(text);
    result.visibleFixtureSourceRows = lines.map(line => line.slice(Math.max(0, ledgerLeft))).filter(line => line.includes('AGENTS.md'));
    result.sourceFilenameWrappingChecked = false;
    must(lines[controlY].slice(left) === controlLabel + ' ', 'Painted toggle label or right margin differs');
    for (const x of [left - 1, width - 1]) {
      click(x, controlY); await pause(120);
      must(ledgerOpen(capture(false)), `Outside cell x=${x} closed Ledger`);
    }
    result.outsideMouseCells = 2;
    click(ledgerLeft + 2, titleY); await pause(120);
    result.titleLabelMiss = ledgerOpen(capture(false));
    must(result.titleLabelMiss, 'The title label acquired the toggle hitbox');
    result.positiveMouseCells = 0;
    for (let x = left; x < width - 1; x++) {
      click(x, controlY); await until(text => !ledgerOpen(text));
      result.positiveMouseCells++;
      key('Tab'); await until(ledgerOpen);
    }
    if (controlLabel === onLabel) {
      key('Tab'); await until(text => !ledgerOpen(text));
      literal('placement probe');
      await until(text => text.includes('› placement probe'));
      // Browse dense rows above completion metadata, including on the shortest viewport.
      for (let wheel = 0; wheel < 8; wheel++) literal('\x1b[<64;3;3M');
      await pause(150);
      result.placements = [];
      for (const height of [...(smoke ? [10] : Array.from({ length: 31 }, (_, i) => i + 10)), 8, 7, 6, 40]) {
        tm('resize-window', '-t', 'check', '-x', String(width), '-y', String(height));
        await pause(200);
        const closed = save(`closed-${height}`);
        const rows = closed.trimEnd().split('\n');
        const composerY = rows.findIndex(row => row.includes('› placement probe'));
        assert(composerY >= 0, `${height} rows: draft disappeared`);
        // One padding row and the composer's gap precede the single-line input.
        const transcriptHeight = Math.max(0, composerY - 2);
        const tabRows = rows.flatMap((row, y) => /╱|╲/u.test(row) || row.includes(offLabel) ? [y] : []);
        const expected = transcriptHeight >= 3 ? 3 : 0;
        const centred = expected === 0 || tabRows[0] === Math.floor((transcriptHeight - 3) / 2);
        const tabX = width - 1 - 12; // dense fixture has a persistent scrollbar
        const clear = expected === 0 || rows.slice(0, transcriptHeight).every(row =>
          (row[tabX - 1] || ' ') === ' ' && !row.slice(tabX, width - 1).includes('X'));
        const reachesEdge = expected === 0 || xExtent(rows.slice(0, transcriptHeight).join('\n')) === tabX - 2;
        const pass = tabRows.length === expected && centred && tabRows.every(y => y < transcriptHeight) && clear && reachesEdge;
        result.placements.push({ height, transcriptHeight, tabRows, clear, reachesEdge, pass });
        must(pass, `${width}x${height}: tab must be centred in ${transcriptHeight} transcript rows, above the gap and bottom pane`);
        must(clear, `${width}x${height}: transcript text occupies the tab gutter or its blank neighbour`);
      }
      result.placementPass = result.placements.every(item => item.pass);
      const closed = capture(false).split('\n');
      const tabY = closed.findIndex(row => row.includes(offLabel));
      assert(tabY >= 0, 'Tall terminal must retain the OFF tab');
      const tabX = closed[tabY].indexOf(offLabel) - 2;
      key('PageUp'); await pause(150);
      const scrolled = save('scrolled').split('\n');
      must(scrolled.findIndex(row => row.includes(offLabel)) === tabY && scrolled[tabY].indexOf(offLabel) - 2 === tabX, 'Scrolling moved the closed tab');
      click(tabX - 1, tabY); await pause(120);
      must(!ledgerOpen(capture(false)), 'A click outside the tab reopened Ledger');
      click(tabX + 2, tabY); await until(ledgerOpen);
      result.tabClickReopens = true;
      const reopened = save('reopened');
      result.openWrappingUnchanged = xExtent(reopened) === openExtent;
      must(result.openWrappingUnchanged, 'The open Ledger acquired a closed-tab gutter');
      key('M-c'); key('Escape'); key('Escape'); await until(text => !ledgerOpen(text));
      key('Tab'); await until(ledgerOpen);
      key('Tab'); await until(text => !ledgerOpen(text));
      result.keyboard = ['Alt+C', 'Escape', 'Tab'];
    } else {
      result.placementPass = false;
      key('Escape'); key('Escape'); await until(text => !ledgerOpen(text));
      key('Tab'); await until(ledgerOpen);
      key('Tab'); await until(text => !ledgerOpen(text));
      result.keyboard = ['Escape', 'Tab'];
    }
  } catch (error) {
    result.errors.push(error.stack);
    try { save('failure'); } catch {}
  } finally {
    try { tm('kill-server'); result.privateTmuxStopped = true; } catch (error) {
      result.privateTmuxStopped = !tmuxStarted;
      if (tmuxStarted) result.errors.push(`Could not stop private tmux: ${error.message}`);
    }
    try { if (provider.server) provider.close(); } catch (error) { result.errors.push(error.stack); }
    try { await stopServer(server); } catch (error) { result.errors.push(error.stack); }
    result.modelRequests = provider.requests.length + provider.titleRequests.length;
    must(provider.requests.length === 1 && provider.titleRequests.length <= 1, 'Expected one fixture response and at most one session title');
    must(!provider.error, `Unexpected mock-provider traffic: ${provider.error?.message}`);
    try {
      execFileSync('gio', ['trash', fixture], { env: { ...process.env, XDG_DATA_HOME: path.join(output, 'trash-data') }, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert(!fs.existsSync(fixture), 'Owned fixture still exists after gio trash');
      result.privateProfileTrashed = true;
    } catch (error) {
      result.errors.push(`Could not trash owned fixture ${fixture}: ${error.message}`);
    }
    fs.writeFileSync(path.join(output, `${label}-server.log`), serverLog);
  }
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ case: label, layout: result.layoutAssertion, positiveMouseCells: result.positiveMouseCells, modelRequests: result.modelRequests, errors: result.errors.length }));
  return result;
}

(async () => {
  if (process.argv[2] === '--snapshot-only') {
    const file = path.join(repo, 'codex-rs/tui/src/app/snapshots/codex_tui__app__composer_hints__tests__composer_usage_notice.snap');
    const text = fs.readFileSync(file, 'utf8').split('---\n').slice(2).join('---\n');
    const first = text.split('\n').slice(1, 5);
    const content = first.map(row => row.slice(0, 67).trim()).filter(Boolean).join(' ');
    assert(content.includes('Run /usage for a breakdown.'), 'A105: usage notice glyphs are covered by or touching the tab');
    console.log('PASS A105: complete usage notice survives wrapping beside the closed tab');
    return;
  }
  const config = options();
  const binarySha256 = await sha256(config.binary);
  const checks = [];
  for (const width of config.smoke ? [80] : [80, 120, 200]) for (const light of config.smoke ? [false] : [false, true]) {
    if (!interrupted) checks.push(await check(config, width, light));
  }
  const result = {
    ...config, binarySha256, binaryUnchanged: binarySha256 === await sha256(config.binary), interrupted: interrupted || null,
    sourceFixture: path.relative(repo, __filename), harnessSha256: await sha256(__filename), checks,
    allPositiveControlsPass: checks.length === (config.smoke ? 1 : 6) && checks.every(check => check.positiveMouseCells === check.geometry?.buttonWidth && check.privateProfileTrashed),
    layoutPasses: checks.filter(check => check.layoutPass === true).length,
    layoutFailures: checks.filter(check => check.layoutPass === false).length,
  };
  result.pass = !interrupted && result.binaryUnchanged && result.allPositiveControlsPass && (config.phase === 'baseline'
    ? checks.every(check => (!check.layoutPass || !check.placementPass) && check.errors.every(error =>
      /^\d+x\d+: (tab must be centred|transcript text occupies)/u.test(error)))
    : result.layoutPasses === checks.length && checks.every(check => !check.errors.length && check.placementPass && check.tabClickReopens && check.openWrappingUnchanged));
  fs.writeFileSync(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  if (!result.pass) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
