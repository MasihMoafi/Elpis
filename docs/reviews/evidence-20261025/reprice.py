"""Reanalyse two historical cohorts from raw request usage and optimizer receipts.

Question: did fewer total tokens also mean lower estimated cost in these cohorts?
This is an offline reproduction of previously reported observations, not a new
confirmatory experiment. Rates are the archived September 2026 estimates.
"""
import hashlib
import json
import os
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[3]
# The archives are gitignored, so they sit in the main checkout, not in a worktree; ELPIS_FINAL_DATA names another folder.
MAIN = pathlib.Path(subprocess.run(['git', '-C', str(REPO), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                   capture_output=True, text=True, check=True).stdout.strip()).parent
ARCHIVES = pathlib.Path(os.environ.get('ELPIS_FINAL_DATA') or MAIN / 'docs/evals/final-data')
RATE_FILE = REPO / 'docs/evals/rq3/LUNA_PUBLISHED_RATES_2026-09-08.json'
COHORTS = ['COST-E1-NONE-B-LUNA-20260908-01', 'COST-E2-32-NONE-LUNA-20260908-01']
FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
rates = json.loads(RATE_FILE.read_text())


def read(p):
    return json.loads(p.read_text())


def fingerprint(p):
    # Repo-relative, so the receipt is the same from any checkout and holds no home path.
    name = pathlib.Path('docs/evals/final-data', p.relative_to(ARCHIVES)) if p.is_relative_to(ARCHIVES) else p.relative_to(REPO)
    return {'path': str(name), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}


def total(usages):
    return {k: sum(u[k] for u in usages) for k in FIELDS}


def cost(u, price):
    assert 0 <= u['cached_input_tokens'] <= u['input_tokens']
    assert 0 <= u['reasoning_output_tokens'] <= u['output_tokens']
    assert u['cache_write_tokens'] == 0, 'A nonzero cache-write count needs a known rate'
    # Cached input is a subset of input; reasoning is already part of output.
    return ((u['input_tokens'] - u['cached_input_tokens']) * price['input']
            + u['cached_input_tokens'] * price['cached']
            + u['output_tokens'] * price['output']) / 1_000_000


def arm(directory):
    result = read(directory / 'result.json')
    assert result['completed'] and result['grade']['passed'], directory
    traces = list((directory / 'trace').glob('*/trace.jsonl'))
    assert len(traces) == 1, directory
    trace = traces[0]
    evidence, request_usages, seen = [fingerprint(trace)], [], set()
    for line in trace.read_text().splitlines():
        event = json.loads(line)['payload']
        if event['type'] != 'inference_completed':
            continue
        assert event['inference_call_id'] not in seen
        seen.add(event['inference_call_id'])
        response_path = trace.parent / event['response_payload']['path']
        response = read(response_path)
        assert response['token_usage'] is not None, 'Missing usage is not zero'
        request_usages.append(response['token_usage'])
        evidence.append(fingerprint(response_path))
    main = total(request_usages)
    assert main == result['mainUsage'], 'Raw request sums must match the sealed result'
    attempts = list((directory / 'state/logs/smart-prune/attempts').glob('*.json'))
    optimizer_usages = []
    for p in attempts:
        attempt = read(p)
        assert attempt['usage'] is not None, 'Missing optimizer usage is not zero'
        assert attempt['reasoning_effort'] == 'none'
        optimizer_usages.append(attempt['usage'])
        evidence.append(fingerprint(p))
    optimizer = total(optimizer_usages)
    assert optimizer == total([x['usage'] for x in result['optimizerAttempts']])
    return {'requests': len(request_usages), 'optimizer_calls': len(attempts),
            'main_tokens': main['total_tokens'], 'optimizer_tokens': optimizer['total_tokens'],
            'total_tokens': main['total_tokens'] + optimizer['total_tokens'],
            'main_estimated_cost': cost(main, rates['main']),
            'optimizer_estimated_cost': cost(optimizer, rates['optimizer']),
            'estimated_cost': cost(main, rates['main']) + cost(optimizer, rates['optimizer']),
            'evidence': evidence}


cohorts = []
for name in COHORTS:
    directory = ARCHIVES / name
    plan = read(directory / 'plan.json')
    frozen = subprocess.run(['node', str(directory / 'harness/staged-study.mjs'), '--audit', str(directory)],
                            capture_output=True, text=True, check=True, timeout=30)
    assert json.loads(frozen.stdout) == read(directory / 'report.json')
    case_ids = [x['id'] for x in plan['steps'] if x['kind'] == 'OFF']
    assert len(case_ids) == len(set(case_ids)) == 8
    pairs = []
    for case_id in case_ids:
        off, on = arm(directory / f'{case_id}-OFF'), arm(directory / f'{case_id}-NATIVE')
        assert off['optimizer_calls'] == 0 and on['optimizer_calls'] > 0
        pairs.append({'case': case_id, 'off': off, 'on': on,
                      'cost_change_percent': 100 * (on['estimated_cost'] / off['estimated_cost'] - 1),
                      'token_change_percent': 100 * (on['total_tokens'] / off['total_tokens'] - 1)})
    off_cost = sum(x['off']['estimated_cost'] for x in pairs)
    on_cost = sum(x['on']['estimated_cost'] for x in pairs)
    off_tokens = sum(x['off']['total_tokens'] for x in pairs)
    on_tokens = sum(x['on']['total_tokens'] for x in pairs)
    cohorts.append({'archive': name, 'model': plan['model'], 'main_effort': plan['mainEffort'],
                    'optimizer_effort': plan['optimizerEffort'], 'binary_hash': plan['binaryHash'],
                    'frozen_audit_reproduced': True, 'distinct_cases': len(pairs),
                    'requests_per_arm': sorted({x[a]['requests'] for x in pairs for a in ('off', 'on')}),
                    'aggregate_cost_change_percent': 100 * (on_cost / off_cost - 1),
                    'aggregate_token_change_percent': 100 * (on_tokens / off_tokens - 1),
                    'cheaper_on_cases': sum(x['on']['estimated_cost'] < x['off']['estimated_cost'] for x in pairs),
                    'pairs': pairs})
assert {x['case'] for x in cohorts[0]['pairs']} == {x['case'] for x in cohorts[1]['pairs']}
assert all(cohorts[0][k] == cohorts[1][k] for k in ('model', 'main_effort', 'optimizer_effort', 'binary_hash'))
output = {'scope': 'Historical synthetic cohorts; published-rate estimates, not invoices or current prices',
          'limitations': ['Eight cases reused across horizons; observations are clustered',
                          'Cache-hit fractions were observed, not experimentally controlled',
                          'No real repository implementation, new inference, or causal novelty claim'],
          'rates': rates, 'rate_file': fingerprint(RATE_FILE), 'cohorts': cohorts}
pathlib.Path(__file__).with_name('repriced-cohorts.json').write_text(json.dumps(output, indent=2) + '\n')
for c in cohorts:
    print(json.dumps({k: v for k, v in c.items() if k != 'pairs'}, indent=2))
