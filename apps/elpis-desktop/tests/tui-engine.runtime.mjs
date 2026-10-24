// The terminal (TUI) and its engine, driven through a private tmux server against a local stand-in for the OpenAI
// Responses API, in a throwaway home (no account, no session bus, no daemon of Masih's). 24 Oct 2026:
//  - A225/A260 "the reasoning and compaction miscalculation": the Context Ledger's Reasoning + compaction share must be
//    the share of reasoning in what the model was sent. The stand-in replays his chats' reasoning (real encrypted
//    lengths, real reported tokens; responses-standin.mjs) and charges everything else at four bytes a token.
//  - A224/A255 "enter should force it": /compact typed during a reply waits; an empty Enter stops the reply and compacts.
//  - A chat whose earlier rollout is gone (his rust-obsidian chat, -32600 "missing source rollout") still opens.
// ELPIS_TUI_BIN=/absolute/elpis node --test tests/tui-engine.runtime.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { model } from './responses-standin.mjs';

const bin = process.env.ELPIS_TUI_BIN;
const skip = !bin ? 'set ELPIS_TUI_BIN to the elpis binary under test' : false;

/** A throwaway home and a TUI in a private tmux server. */
async function terminal(t, { args = [], prepare } = {}) {
  const mock = await model();
  const root = fs.mkdtempSync('/tmp/e2e-tui-');
  const home = path.join(root, 'home'), elpis = path.join(home, '.elpis-next'), work = path.join(root, 'work');
  for (const dir of [elpis, work, path.join(root, 'run')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(elpis, 'config.toml'), [
    'model = "mock-model"', 'model_provider = "mock"', 'model_context_window = 475000', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
    '[model_providers.mock]', 'name = "mock"', `base_url = "http://127.0.0.1:${mock.port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    'request_max_retries = 0', 'stream_max_retries = 0', `[projects.${JSON.stringify(work)}]`, 'trust_level = "trusted"', '[tui]', 'screen_reader_detection_done = true', '',
  ].join('\n'));
  await prepare?.({ root, elpis, work });
  const socket = `e2e-tui-${randomUUID().slice(0, 8)}`;
  const tmux = (...rest) => execFileSync('tmux', ['-L', socket, ...rest], { encoding: 'utf8' });
  const env = { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: elpis, XDG_RUNTIME_DIR: path.join(root, 'run'), XDG_CONFIG_HOME: path.join(home, '.config'), TMPDIR: root, TERM: 'xterm-256color' };
  const command = ['env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'nice', '-n', '19', bin, '-C', work, ...args].map(part => `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '220', '-y', '60', `${command} 2>${root}/tui.err`);
  t.after(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    mock.close();
    t.diagnostic(`evidence: ${root}`);
  });
  // A terminal that exited leaves only what it printed on the way out.
  const screen = () => { try { return tmux('capture-pane', '-p', '-t', 't', '-S', '-300'); } catch { return `[the terminal exited]\n${fs.readFileSync(path.join(root, 'tui.err'), 'utf8')}`; } };
  const until = async (check, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await pause(200)) { const value = check(screen()); if (value) return value; }
    assert.fail(`${label}\n${screen().split('\n').filter(line => line.trim()).slice(-40).join('\n')}`);
  };
  // Typed text, then Enter on its own: one burst would be read as a paste.
  const type = async text => { tmux('send-keys', '-t', 't', '-l', text); await pause(700); };
  const key = name => tmux('send-keys', '-t', 't', name);
  await until(text => text.includes('Ask Elpis') || text.includes('›'), 'the terminal starts');
  return { mock, root, elpis, screen, until, type, key };
}

test('A225/A260: the ledger\'s Reasoning + compaction is the share of reasoning the model was sent', { skip, timeout: 120000 }, async t => {
  const tui = await terminal(t);
  await tui.type('work 6 on this'); tui.key('Enter');
  await tui.until(text => /reply \d+/.test(text), 'the reply arrives after six tool steps', 60000);
  // The chat's last request (the title is asked for on the side).
  const turn = tui.mock.state.requests.filter(request => request.asked.startsWith('work')), sent = turn.at(-1);
  assert.equal(sent.reasoningItems, turn.slice(0, -1).reduce((sum, request) => sum + request.produced, 0), 'every step of the turn sends the turn\'s reasoning back');
  const truth = sent.truth;
  const used = truth.input + truth.output, share = truth.reasoning / used;
  await tui.type('/context'); tui.key('Enter');
  const row = await tui.until(text => {
    const match = [...text.matchAll(/Reasoning \+ compaction\s+≈?([\d.]+)(k?)/g)].at(-1);
    return match && Number(match[1]) * (match[2] ? 1000 : 1);
  }, 'the ledger shows Reasoning + compaction');
  const shown = row / used;
  t.diagnostic(`model sent ${truth.reasoning} reasoning tokens of ${used} (${(share * 100).toFixed(1)}%); ledger shows ${row} (${(shown * 100).toFixed(1)}%)`);
  assert.ok(Math.abs(shown - share) < 0.04, `ledger ${(shown * 100).toFixed(1)}% vs sent ${(share * 100).toFixed(1)}%`);
});

test('A224/A255: an empty Enter forces a /compact queued during a reply', { skip, timeout: 120000 }, async t => {
  const tui = await terminal(t);
  await tui.type('a slow reply please'); tui.key('Enter');
  await tui.until(() => tui.mock.state.requests.some(request => request.asked.includes('slow')), 'the slow reply is running');
  await tui.type('/compact'); tui.key('Enter');
  await tui.until(text => /Queued follow-up inputs[\s\S]*\/compact/.test(text), '/compact waits in the queue');
  assert.equal(tui.mock.state.compactions, 0);
  tui.key('Enter');
  await tui.until(() => tui.mock.state.compactions === 1, 'Enter compacts now, long before the reply would end', 20000);
  await tui.until(text => text.includes('Reply stopped to compact now.'), 'the terminal says why the reply stopped');
  assert.ok(!/reply \d+/.test(tui.screen()), 'the slow reply never finished');
});

test('a chat whose earlier part was deleted still opens, with a note', { skip, timeout: 120000 }, async t => {
  // His rust-obsidian chat's shape: a later rollout of the chat continues one whose file is gone.
  const thread = '01a157ef-aa4b-70a1-92ff-11c1e7b29875', missing = '01a16216-d22a-7173-8b94-a4baf5234a47';
  const tui = await terminal(t, {
    args: ['resume', thread],
    prepare: ({ elpis, work }) => {
      const dir = path.join(elpis, 'sessions/2026/10/22');
      fs.mkdirSync(dir, { recursive: true });
      const line = (ordinal, type, payload) => JSON.stringify({ timestamp: '2026-10-22T10:10:49.862Z', ordinal, type, payload });
      const base = 45271;
      const rows = [
        line(base, 'session_meta', { id: thread, session_id: thread, timestamp: '2026-10-22T10:10:49.862Z', cwd: work, originator: 'elpis-desktop', cli_version: '0.162.0', source: 'vscode', thread_source: 'user', model_provider: 'mock', history_mode: 'paginated', history_base: { thread_id: missing, end_ordinal_exclusive: base, end_byte_offset: 41901968 } }),
        line(base + 1, 'event_msg', { type: 'task_started', turn_id: 'turn-remaining', started_at: 1792577449 }),
        line(base + 2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'REMAINING QUESTION about the vault' }] }),
        line(base + 3, 'event_msg', { type: 'user_message', message: 'REMAINING QUESTION about the vault', images: [], local_images: [], text_elements: [] }),
        line(base + 4, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'REMAINING ANSWER kept after the gap' }] }),
        line(base + 5, 'event_msg', { type: 'agent_message', message: 'REMAINING ANSWER kept after the gap' }),
        line(base + 6, 'event_msg', { type: 'task_complete', turn_id: 'turn-remaining', last_agent_message: 'REMAINING ANSWER kept after the gap' }),
      ];
      fs.writeFileSync(path.join(dir, `rollout-2026-10-22T13-40-49-${thread}_01a16317-8b86-7a70-941d-bda980843230.jsonl`), rows.join('\n') + '\n');
    },
  });
  const opened = await tui.until(text => (text.includes('REMAINING ANSWER') || /missing source rollout|invalid paginated history/.test(text)) && text, 'the chat opens or fails');
  assert.doesNotMatch(opened, /missing source rollout|invalid paginated history/, 'the chat must not be refused');
  assert.match(opened, /REMAINING QUESTION about the vault/);
  await tui.until(text => text.includes('The earliest part of this chat is missing'), 'a quiet note says the earliest part is missing');
});
