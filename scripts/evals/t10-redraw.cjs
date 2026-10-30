#!/usr/bin/env node
'use strict';

// Exercise the real TUI in a private tmux server. The provider is a local,
// deterministic Responses fixture; no account or external service is used.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const binary = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
assert(process.argv.length === 4 && fs.existsSync(binary), 'usage: t10-redraw.cjs BINARY EMPTY_OUTPUT_DIR');
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.readdirSync(output).length, 0, 'output directory must be empty');
const repo = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const rows = Array.from({ length: 8 }, (_, i) =>
  `T10_ROW_${String(i).padStart(2, '0')} Alpha bravo charlie delta echo foxtrot golf hotel 界 india juliet kilo lima.`);

function verify(screen, expected) {
  let previous = -1;
  for (const row of expected) {
    const marker = row.slice(0, 10);
    assert.equal(screen.split(marker).length - 1, 1, `${marker} must appear once`);
    assert(screen.includes(row), `${marker} text was split or altered`);
    const position = screen.indexOf(marker);
    assert(position > previous, `${marker} appeared out of order`);
    previous = position;
  }
}

async function runCase(mode, light) {
  const label = `${mode}-${light ? 'light' : 'dark'}`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-t10-'));
  const home = path.join(fixture, 'home');
  const cwd = path.join(fixture, 'project');
  const socket = path.join(fixture, 'tmux');
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, ELPIS_HOME: home,
    CODEX_HOME: home, CODEX_AUTH_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    ELPIS_NO_CLAUDE: '1', ELPIS_NO_AGY: '1',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
  };
  const tm = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
    env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (ansi, history = false) => tm('capture-pane', '-p', '-N',
    ...(history ? ['-S', '-2000', '-J'] : []), ...(ansi ? ['-e'] : []), '-t', 'check');
  const key = value => tm('send-keys', '-t', 'check', value);
  const literal = value => tm('send-keys', '-t', 'check', '-l', value);
  const save = (name, history = false) => {
    const screen = capture(false, history);
    fs.writeFileSync(path.join(output, `${label}-${name}.txt`), screen);
    fs.writeFileSync(path.join(output, `${label}-${name}.ansi`), capture(true, history));
    return screen;
  };
  const deadline = Date.now() + 90_000;
  const until = async (condition, what) => {
    while (!condition()) {
      assert(Date.now() < deadline, `${label}: timed out waiting for ${what}`);
      await pause(50);
    }
  };
  const errors = [];
  const requests = [];
  let releaseStream;
  let streamStarted = false;
  let streamDone = false;
  let providerError;
  const gate = new Promise(resolve => { releaseStream = resolve; });
  const provider = http.createServer(async (req, res) => {
    try {
      const body = [];
      for await (const part of req) body.push(part);
      const request = JSON.parse(Buffer.concat(body).toString('utf8'));
      const title = request.text?.format?.schema?.required?.includes('title');
      if (!title) requests.push(request);
      if (!title && requests.length === 1) {
        const item = { type: 'function_call', call_id: 't10-tool', name: 'exec_command', arguments: JSON.stringify({ cmd: "printf 'T10_TOOL_OUTPUT\\n'" }) };
        const events = [
          { type: 'response.created', response: { id: 't10-tool-response' } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 't10-tool-response', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      const text = title ? JSON.stringify({ title: 'T10 fixture' }) : rows.join('\n\n');
      const id = title ? 't10-title' : 't10-answer';
      const item = { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] };
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ type: 'response.created', response: { id: `${id}-response` } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
      if (title) {
        send({ type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: text });
      } else {
        assert.equal(requests.length, 2, 'unexpected extra model request');
        for (let i = 0; i < rows.length; i++) {
          send({ type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: `${i ? '\n\n' : ''}${rows[i]}` });
          if (i === 1) { streamStarted = true; await gate; }
          await pause(100);
        }
      }
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: { id: `${id}-response`, usage: { input_tokens: 500, output_tokens: 40, total_tokens: 540 } } });
      res.end();
      if (!title) streamDone = true;
    } catch (error) {
      providerError = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  let native;
  let tmuxStarted = false;
  let serverLog = '';
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const url = `http://127.0.0.1:${provider.address().port}/v1`;
    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# T10 fixture\n');
    const config = [
      `model_catalog_json = ${JSON.stringify(path.join(repo, 'codex-rs/models-manager/models.json'))}`,
      'model = "gpt-6-luna"', 'model_provider = "fixture"', 'approval_policy = "never"',
      'sandbox_mode = "read-only"', '[features]', 'code_mode = false',
      '[model_providers.fixture]', 'name = "T10 local fixture"', `base_url = "${url}"`,
      'wire_api = "responses"', 'requires_openai_auth = false', '[tui]',
      'alternate_screen = "always"', 'fullscreen_transcript = true', 'animations = false',
      'disable_paste_burst = true', 'copy_on_select = "never"',
      `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', '',
    ].join('\n');
    fs.writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 });
    native = spawn(binary, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    native.stdout.on('data', data => { serverLog = (serverLog + data).slice(-131072); });
    native.stderr.on('data', data => { serverLog = (serverLog + data).slice(-131072); });
    await until(() => /ws:\/\/127\.0\.0\.1:\d+/.test(serverLog), 'native app-server');
    const address = serverLog.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
    tm('new-session', '-d', '-s', 'check', '-x', '170', '-y', '42', '/bin/bash', '--noprofile', '--norc');
    tmuxStarted = true;
    tm('set-option', '-t', 'check', 'status', 'off');
    tm('set-option', '-w', '-t', 'check', 'window-style', light ? 'fg=#111111,bg=#ffffff' : 'fg=#eeeeee,bg=#111111');
    const variables = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
    const args = mode === 'inline' ? '--no-alt-screen ' : '';
    literal(`env -i ${variables} ${quote(binary)} ${args}--remote ${quote(address)} -C ${quote(cwd)}`);
    key('Enter');
    await until(() => capture(false).includes('CONTEXT LEDGER'), 'initial Ledger');
    save('initial');
    literal('Render the T10 repaint fixture');
    key('Enter');
    await until(() => streamStarted && capture(false).includes('T10_ROW_01'), 'first streamed rows');
    save('stream-before');
    key('Tab');
    await pause(250);
    // The first Tab may focus an already-visible Ledger; the next one closes it.
    if (capture(false).includes('CONTEXT LEDGER')) key('Tab');
    await until(() => !capture(false).includes('CONTEXT LEDGER'), 'Ledger close');
    save('ledger-hidden');
    tm('resize-window', '-t', 'check', '-x', '125', '-y', '38');
    await pause(250);
    key('Tab');
    await until(() => capture(false).includes('CONTEXT LEDGER'), 'Ledger reopen');
    save('narrow-reopened');
    tm('resize-window', '-t', 'check', '-x', '170', '-y', '42');
    await pause(250);
    releaseStream();
    await until(() => streamDone && capture(false).includes('T10_ROW_07') && !capture(false).includes('esc to interrupt'), 'completed transcript');
    await pause(300);
    const final = save('final');
    const transcript = mode === 'inline' ? save('history', true) : final;
    verify(transcript, rows);
    if (mode === 'inline') verify(final, rows.slice(4));
    assert(final.includes('CONTEXT LEDGER'), `${label}: Ledger did not reopen`);
    assert.throws(() => verify(transcript.replace(rows[3], rows[3].replace('bravo', 'brXavo')), rows), 'oracle must reject altered text');
    assert.throws(() => verify(`${transcript}\n${rows[3]}`, rows), 'oracle must reject duplicate text');
    assert.equal(requests.length, 2, `${label}: expected a tool call and final reply`);
    assert.ifError(providerError);
    console.log(`PASS ${label}: streamed rows, resize, Ledger reopen, and corruption controls`);
  } catch (error) {
    errors.push(error.stack || String(error));
    try { save('failure'); } catch {}
  } finally {
    releaseStream();
    if (tmuxStarted) { try { tm('kill-server'); } catch (error) { errors.push(String(error)); } }
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
    if (native && native.exitCode === null && native.signalCode === null) {
      native.kill('SIGTERM');
      await Promise.race([once(native, 'exit'), pause(3000)]);
      if (native.exitCode === null && native.signalCode === null) {
        native.kill('SIGKILL');
        await once(native, 'exit');
      }
    }
    fs.writeFileSync(path.join(output, `${label}-server.log`), serverLog);
    try {
      execFileSync('gio', ['trash', fixture], { env: { ...process.env, XDG_DATA_HOME: path.join(output, 'trash-data') }, timeout: 10000 });
    } catch (error) { errors.push(`fixture cleanup: ${error.message}`); }
  }
  return { mode, light, requests: requests.length, errors };
}

(async () => {
  const before = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const cases = [];
  for (const mode of ['owned', 'inline']) for (const light of [true, false]) cases.push(await runCase(mode, light));
  const after = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const result = { binarySha256: before, binaryUnchanged: before === after, cases };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (before !== after || cases.some(test => test.errors.length)) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
