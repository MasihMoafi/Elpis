"""Read official grades and durable pruning evidence; never invoke a model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plan', type=Path, required=True)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
plan = json.loads(args.plan.read_text())
root = Path(plan['runtime_root'])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text())

def seconds(timing):
    if timing and timing.get('started_at') and timing.get('finished_at'):
        return (datetime.fromisoformat(timing['finished_at']) -
                datetime.fromisoformat(timing['started_at'])).total_seconds()
    return None

rows = []
for scheduled in plan['schedule']:
    job = root/'runs'/scheduled['id']
    row = {**scheduled, 'attempt_recorded': False, 'grade_valid': False,
           'attempt_directory_exists': job.exists()}
    records = [(p, read(p)) for p in job.rglob('result.json')]
    records = [(p, r) for p, r in records if 'verifier_result' in r]
    status_paths = list(job.rglob('run-status.json'))
    if len(records) != 1 or len(status_paths) != 1:
        rows.append(row)
        continue
    result_path, result = records[0]
    status_path = status_paths[0]
    status = read(status_path)
    launch = read(status_path.parent/'launch.json')
    assert launch['binary_sha256'] == plan['binary']['sha256']
    assert status['observed_main_models'] == [plan['main']['model']]
    assert status['guard_wrapped_shell_calls'] > 0
    audit = status_path.parent/'smart-prune'
    recovery_path = status_path.parent/'audit-recovery.json'
    recovery = read(recovery_path) if recovery_path.exists() else {}
    measured = (scheduled['arm'] == 'off' or
                'pruner_audit_directory_present' in status or
                recovery.get('copy_exit_code') == 0 or
                recovery.get('audit_directory_present') is False)
    attempts, admitted, optimizer = [], 0, {}
    for path in sorted((audit/'attempts').glob('*.json')):
        attempt = read(path)
        assert attempt['model'] == plan['pruner']['model']
        assert attempt['reasoning_effort'] == plan['pruner']['effort']
        for key, value in (attempt.get('usage') or {}).items():
            if isinstance(value, int):
                optimizer[key] = optimizer.get(key, 0) + value
        receipt_files = {}
        if attempt['status'] == 'admitted':
            folder = audit/'admissions'/attempt['admission_id']
            manifest = read(folder/'manifest.json')
            assert manifest['admission_id'] == attempt['admission_id']
            request, response = read(folder/'request.json'), read(folder/'response.json')
            assert request['admission_id'] == response['admission_id'] == manifest['admission_id']
            assert len(request['request_input_sha256']) == 64
            assert response['response_id']
            admitted += attempt['admitted_outputs']
            receipt_files = {name: sha(folder/name) for name in
                             ('manifest.json', 'request.json', 'response.json')}
        attempts.append({'file': str(path), 'sha256': sha(path),
                         'status': attempt['status'], 'model': attempt['model'],
                         'effort': attempt['reasoning_effort'], 'usage': attempt.get('usage'),
                         'admission_receipt_sha256': receipt_files})
    grade = ((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')
    grade_valid = grade in (0, 1) and not result.get('exception_info')
    if scheduled['arm'] == 'off':
        assert not attempts, 'OFF arm unexpectedly has optimizer attempts'
    for usage in (status['main_usage'], optimizer):
        if usage.get('total_tokens') is not None:
            assert usage['total_tokens'] == usage['input_tokens'] + usage['output_tokens']
        assert usage.get('cached_input_tokens', 0) <= usage.get('input_tokens', 0)
    row.update({'attempt_recorded': True, 'grade_valid': grade_valid,
                'reward': grade if grade_valid else None, 'official_recorded_reward': grade,
                'started_at': result['started_at'], 'finished_at': result.get('finished_at'),
                'agent_exit': status['exit_code'],
                'grader_exception': (result.get('exception_info') or {}).get('exception_type'),
                'evidence_error': status.get('evidence_error'),
                'primary_usage': status['main_usage'], 'pruning_measured': measured,
                'applied_admitted_outputs': admitted if measured else None,
                'optimizer_usage': optimizer if measured else None, 'optimizer_attempts': attempts,
                'native_guard_invocations': status['native_guard_invocations'],
                'agent_phase_seconds': seconds(result.get('agent_execution')),
                'agent_phase_note': 'includes artifact capture, not isolated inference latency',
                'final_workdir_capture': status.get('final_workdir_capture'),
                'prompt_sha256': sha(status_path.parent/'prompt.txt'), 'argv': launch['argv'],
                'official_result': str(result_path), 'official_result_sha256': sha(result_path),
                'raw_status_sha256': sha(status_path),
                'runtime_controls_sha256': {name: sha(status_path.parent/name) for name in
                                           ('effective-config.toml', 'pruner.json')},
                'primary_evidence_sha256': {str(path.relative_to(status_path.parent)): sha(path)
                                           for path in sorted(status_path.parent.rglob('*'))
                                           if path.is_file() and (path.suffix == '.jsonl' or
                                                                  path.name == 'launch.json')}})
    rows.append(row)

pairs = []
for task in plan['tasks']:
    members = {r['arm']: r for r in rows if r['task'] == task['name']}
    if set(members) != {'off', 'on'} or not all(r['attempt_recorded'] for r in members.values()):
        continue
    off, on = members['off'], members['on']
    assert off['prompt_sha256'] == on['prompt_sha256']
    assert off['runtime_controls_sha256'] == on['runtime_controls_sha256']
    assert len(off['argv']) == len(on['argv'])
    differences = [(a, b) for a, b in zip(off['argv'], on['argv']) if a != b]
    assert differences == [('features.automatic_context_pruning=false',
                            'features.automatic_context_pruning=true')]
    pairs.append({'task': task['name'], 'off_reward': off['reward'], 'on_reward': on['reward'],
                  'on_admitted_outputs': on['applied_admitted_outputs'],
                  'pruning_measured': on['pruning_measured'],
                  'both_grades_valid': off['grade_valid'] and on['grade_valid'],
                  'only_pruning_flag_differs': True,
                  'matching_config_and_pruner_files': True})

def summed_usage(entries):
    total = {}
    for usage in entries:
        for key, value in (usage or {}).items():
            if isinstance(value, int):
                total[key] = total.get(key, 0) + value
    return total

smoke_usage = {}
smoke_events = root/'runtime-smoke/events.jsonl'
if smoke_events.exists():
    for line in smoke_events.read_text().splitlines():
        item = json.loads(line)
        if item.get('type') == 'turn.completed':
            smoke_usage = item.get('usage') or {}
    if smoke_usage:
        smoke_usage['total_tokens'] = smoke_usage['input_tokens'] + smoke_usage['output_tokens']
setup_usage = []
for incident in plan['setup_incidents']:
    usage = dict(incident.get('main_usage') or {})
    if usage:
        usage['total_tokens'] = usage['input_tokens'] + usage['output_tokens']
        setup_usage.append(usage)

output = {'scope': 'three-task feasibility pilot; excluded from confirmatory inference',
          'generated_at': datetime.now(timezone.utc).isoformat(),
          'plan_sha256': sha(args.plan),
          'main': plan['main'], 'pruner': plan['pruner'],
          'recorded_arms': sum(r['attempt_recorded'] for r in rows),
          'graded_arms': sum(r['grade_valid'] for r in rows),
          'planned_arms': len(rows), 'paired_attempts': pairs,
          'fully_scored_pairs': sum(p['both_grades_valid'] for p in pairs),
          'known_primary_usage': summed_usage(r.get('primary_usage') for r in rows),
          'known_optimizer_usage': summed_usage(r.get('optimizer_usage') for r in rows),
          'known_setup_main_usage': summed_usage(setup_usage),
          'known_luna_tool_smoke_usage': smoke_usage,
          'known_usage_including_setup_and_smoke': summed_usage(
              [*(r.get('primary_usage') for r in rows),
               *(r.get('optimizer_usage') for r in rows), *setup_usage, smoke_usage]),
          'optimizer_usage_complete': all(r.get('pruning_measured', False) for r in rows),
          'confirmed_admitted_outputs': sum(r.get('applied_admitted_outputs') or 0 for r in rows),
          'runs': rows, 'setup_incidents': plan['setup_incidents'],
          'runtime_smoke': {**plan.get('runtime_smoke', {}),
                            'pruner_admissions_observed': None,
                            'pruner_measurement_note': 'Original exporter used the wrong audit path; unknown, not zero.'},
          'usage_note': 'Cached input is included in input, and reasoning output is included in output. Known primary usage covers scheduled arms only. Setup and the separate Luna tool smoke are also retained. Missing optimizer receipts make the optimizer and combined totals lower bounds. No subscription dollar-cost inference.',
          'inference': 'No conclusion of unchanged task performance from this pilot.',
          'measurement_caveat': 'Missing pruning receipts are unknown, not zero.'}
encoded = json.dumps(output, indent=2) + '\n'
if args.output:
    args.output.write_text(encoded)
    print(json.dumps({'output': str(args.output), 'recorded_arms': output['recorded_arms'],
                      'graded_arms': output['graded_arms'], 'fully_scored_pairs': output['fully_scored_pairs']}))
else:
    print(encoded, end='')
