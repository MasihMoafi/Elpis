#!/usr/bin/env python3
"""Memory of the running Elpis desktop app, by component, in proportional set size (PSS).

  mem-meter.py            one sample, a table
  mem-meter.py --json     one sample, JSON
  mem-meter.py --watch S  sample every 2 s for S seconds, report the peak per component
  mem-meter.py --list     one sample, every counted process with its kind, largest first

Roots: the Electron main process of elpis-desktop and tools/elpis-claude/acp-bridge.mjs.
Every descendant counts, plus the engine app-server bound to the elpis-bridge socket even
when it has been reparented. Components, by command line:
  app       Electron (window, renderer, GPU, utility processes)
  bridge    acp-bridge.mjs
  adapters  context-agent.mjs, agy-acp.mjs and other node adapters
  engine    codex/elpis app-server
  workers   claude or agy processes run for threads and workflow nodes
  browser   headless Chromium
  other     anything else under the roots
Stdlib only; run with `python3 -I`.
"""
import json, os, re, sys, time

ROOT = re.compile(r'elpis-desktop/versions/.*/runtime/electron/electron (?!.*--type=)|tools/elpis-claude/acp-bridge\.mjs')
KINDS = [
    ('browser', re.compile(r'chrome-headless-shell|chromium|elpis-browser-agent')),
    ('engine', re.compile(r'(codex|elpis) app-server')),
    ('bridge', re.compile(r'acp-bridge\.mjs')),
    ('workers', re.compile(r'claude-code/bin/claude\.exe|(^|/)claude |/agy |/codex ')),
    ('adapters', re.compile(r'tools/elpis-claude/.*\.mjs')),
    ('app', re.compile(r'elpis-desktop/versions/.*/runtime/electron/electron')),
]
ENGINE_SOCKET = re.compile(r'app-server --listen unix:///run/user/\d+/elpis-bridge')


def procs():
    table = {}
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            cmd = open(f'/proc/{pid}/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='ignore').strip()
            ppid = int(re.search(r'PPid:\s+(\d+)', open(f'/proc/{pid}/status').read()).group(1))
        except OSError:
            continue
        if cmd:
            table[int(pid)] = (ppid, cmd)
    return table


def pss(pid):
    try:
        return int(re.search(r'Pss:\s+(\d+)', open(f'/proc/{pid}/smaps_rollup').read()).group(1))
    except (OSError, AttributeError):
        return 0


def sample():
    table = procs()
    roots = {pid for pid, (_, cmd) in table.items() if ROOT.search(cmd)}
    members = set(roots) | {pid for pid, (_, cmd) in table.items() if ENGINE_SOCKET.search(cmd)}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _) in table.items():
            if ppid in members and pid not in members:
                members.add(pid); changed = True
    out = {k: {'kb': 0, 'procs': 0} for k, _ in KINDS}
    out['other'] = {'kb': 0, 'procs': 0}
    for pid in members:
        cmd = table[pid][1]
        kind = next((k for k, rx in KINDS if rx.search(cmd)), 'other')
        out[kind]['kb'] += pss(pid); out[kind]['procs'] += 1
    out['total'] = {'kb': sum(v['kb'] for v in out.values()), 'procs': sum(v['procs'] for v in out.values())}
    if '--list' in sys.argv:
        rows = sorted(((pss(pid), next((k for k, rx in KINDS if rx.search(table[pid][1])), 'other'), pid, table[pid][1]) for pid in members), reverse=True)
        for kb, kind, pid, cmd in rows: print(f"{kb / 1024:7.0f} MB {kind:8} {pid:>8} {cmd[:110]}")
    return out


def show(s):
    for k, v in s.items():
        print(f"{v['kb'] / 1024:8.0f} MB {v['procs']:4d} procs  {k}")


if __name__ == '__main__':
    if '--watch' in sys.argv:
        until = time.time() + float(sys.argv[sys.argv.index('--watch') + 1]); peak = sample()
        while time.time() < until:
            time.sleep(2); s = sample()
            for k in peak:
                if s[k]['kb'] > peak[k]['kb']: peak[k] = s[k]
        print('peak per component over the watch:'); show(peak)
    else:
        s = sample()
        print(json.dumps(s)) if '--json' in sys.argv else show(s)
