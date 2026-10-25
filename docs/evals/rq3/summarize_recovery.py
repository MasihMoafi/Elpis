"""Inspect the resource-limited reruns without invoking any model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def total_usage(items):
    result = {}
    for usage in items:
        for key, value in (usage or {}).items():
            if isinstance(value, int):
                result[key] = result.get(key, 0) + value
    return result


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plan', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
plan = read(args.plan)
root = Path(plan['runtime_root'])
rows = []
for run in plan['schedule']:
    job = root / 'runs' / run['id']
    row = {**run, 'attempted': job.exists(), 'recorded': False, 'grade_valid': False}
    results = [(f, read(f)) for f in job.rglob('result.json')]
    results = [(f, r) for f, r in results if 'verifier_result' in r]
    statuses = list(job.rglob('run-status.json'))
    if len(results) != 1 or len(statuses) != 1:
        rows.append(row)
        continue
    result_file, result = results[0]
    status_file = statuses[0]
    agent = status_file.parent
    status = read(status_file)
    launch = read(agent / 'launch.json')
    limits = read(agent / 'resource-limits.json')
    cached = read(agent / 'grader-cache.json')
    config = read(root / 'configs' / (run['id'] + '.json'))
    assert status['observed_main_models'] == [plan['main']['model']]
    assert launch['binary_sha256'] == plan['binary']['sha256']
    assert status['guard_wrapped_shell_calls'] > 0
    assert limits == {'memory.max': '4294967296', 'memory.swap.max': '0',
                      'cpu.max': '200000 100000', 'pids.max': '512'}
    assert cached['archive_sha256'] == plan['grader_uv']['sha256']
    assert cached['provided_after_agent_execution_and_credential_clearance']
    verifier_file = result_file.parent / 'verifier/test-stdout.txt'
    verifier_text = verifier_file.read_text(errors='replace') if verifier_file.exists() else ''
    pytest_started = 'test session starts' in verifier_text
    collected = re.search(r'collected (\d+) items?', verifier_text)
    reward = ((result.get('verifier_result') or {}).get('rewards') or {}).get('reward')
    raw_reward = reward
    repair_file = agent / 'grading-repair.json'
    repair = read(repair_file) if repair_file.exists() else {}
    grade_source = 'original Harbor trial'
    if repair.get('grade_valid'):
        assert repair['model_repeated'] is False and repair['official_tests_unchanged']
        assert repair['reward'] in (0, 1)
        verifier_file = Path(repair['stdout_file'])
        assert sha(verifier_file) == repair['stdout_sha256']
        verifier_text = verifier_file.read_text(errors='replace')
        pytest_started = 'test session starts' in verifier_text
        collected = re.search(r'collected (\d+) items?', verifier_text)
        reward = repair['reward']
        grade_source = 'official grader resumed on retained candidate; original timeout preserved'
    grade_valid = (reward in (0, 1) and not result.get('exception_info') and pytest_started
                   and collected is not None and int(collected[1]) > 0)
    if repair.get('grade_valid'):
        grade_valid = pytest_started and collected is not None and int(collected[1]) > 0
    audit = agent / 'smart-prune'
    admissions = []
    attempts = []
    for f in sorted((audit / 'attempts').glob('*.json')):
        attempt = read(f)
        assert attempt['model'] == plan['pruner']['model']
        assert attempt['reasoning_effort'] == plan['pruner']['effort']
        item = {'file': str(f), 'sha256': sha(f), 'status': attempt['status'],
                'usage': attempt.get('usage'), 'model': attempt['model'],
                'reasoning_effort': attempt['reasoning_effort']}
        if attempt['status'] == 'admitted':
            folder = audit / 'admissions' / attempt['admission_id']
            manifest = read(folder / 'manifest.json')
            request = read(folder / 'request.json')
            response = read(folder / 'response.json')
            assert manifest['admission_id'] == request['admission_id'] == response['admission_id'] == attempt['admission_id']
            assert len(request['request_input_sha256']) == 64 and response['response_id']
            item['receipt_sha256'] = {n: sha(folder/n) for n in ('manifest.json', 'request.json', 'response.json')}
            admissions.append(attempt['admitted_outputs'])
        attempts.append(item)
    if run['arm'] == 'off':
        assert not attempts
    measured = ('pruner_audit_directory_present' in status and
                status.get('evidence_error') not in {'pruner_receipt_capture_failed', 'pruner_audit_presence_check_failed'})
    primary = status['main_usage']
    assert primary['total_tokens'] == primary['input_tokens'] + primary['output_tokens']
    assert primary['cached_input_tokens'] <= primary['input_tokens']
    row.update({'recorded': True, 'grade_valid': grade_valid,
                'reward': reward if grade_valid else None, 'raw_official_reward': raw_reward,
                'grade_source': grade_source,
                'grading_repair': repair if repair else None,
                'grader_exception': (result.get('exception_info') or {}).get('exception_type'),
                'pytest_started': pytest_started,
                'tests_collected': int(collected[1]) if collected else None,
                'pytest_summary': verifier_text.splitlines()[-1:],
                'agent_exit': status['exit_code'], 'evidence_error': status.get('evidence_error'),
                'observed_main_models': status['observed_main_models'],
                'native_guard_invocations': status['native_guard_invocations'],
                'primary_usage': primary, 'optimizer_usage': total_usage(a.get('usage') for a in attempts),
                'pruning_measured': measured,
                'admitted_outputs': sum(admissions) if measured else None,
                'optimizer_attempts': attempts, 'resource_limits': limits,
                'grader_env': repair.get('grader_env', config['verifier']['env']),
                'prompt_sha256': sha(agent/'prompt.txt'),
                'runtime_config_sha256': {n: sha(agent/n) for n in ('effective-config.toml', 'pruner.json')},
                'argv': launch['argv'], 'started_at': result['started_at'],
                'raw_trial_finished_at': result.get('finished_at'),
                'finished_at': repair.get('completed_at', result.get('finished_at')),
                'raw_result': str(result_file), 'raw_result_sha256': sha(result_file),
                'raw_status_sha256': sha(status_file),
                'grader_stdout_sha256': sha(verifier_file) if verifier_file.exists() else None,
                'evidence_sha256': {str(f.relative_to(agent)): sha(f) for f in sorted(agent.rglob('*'))
                                    if f.is_file() and (f.suffix == '.jsonl' or f.name in
                                       {'launch.json', 'resource-limits.json', 'grader-cache.json'})}})
    rows.append(row)

pairs = []
for task in plan['tasks']:
    members = {r['arm']: r for r in rows if r['task'] == task['name']}
    if set(members) != {'off', 'on'} or not all(r['recorded'] for r in members.values()):
        continue
    off, on = members['off'], members['on']
    for key in ('prompt_sha256', 'runtime_config_sha256', 'resource_limits'):
        assert off[key] == on[key]
    for key in ('UV_PYTHON', 'UV_PYTHON_DOWNLOADS', 'INSTALLER_DOWNLOAD_URL'):
        assert off['grader_env'][key] == on['grader_env'][key]
    assert len(off['argv']) == len(on['argv'])
    assert [(a, b) for a, b in zip(off['argv'], on['argv']) if a != b] == [
        ('features.automatic_context_pruning=false', 'features.automatic_context_pruning=true')]
    pairs.append({'task': task['name'], 'off_reward': off['reward'], 'on_reward': on['reward'],
                  'both_grades_valid': off['grade_valid'] and on['grade_valid'],
                  'on_admitted_outputs': on['admitted_outputs'],
                  'matched_prompts_configs_resources_and_grader_test_code': True,
                  'bootstrap_environment_identical': off['grader_env'] == on['grader_env'],
                  'only_pruning_invocation_flag_differs': True})

output = {'generated_at': datetime.now(timezone.utc).isoformat(),
          'scope': 'New two-task recovery cohort; one execution per arm; descriptive only',
          'plan_sha256': sha(args.plan), 'generator_sha256': sha(Path(__file__)),
          'main': plan['main'], 'pruner': plan['pruner'],
          'scheduled_arms': len(rows), 'recorded_arms': sum(r['recorded'] for r in rows),
          'graded_arms': sum(r['grade_valid'] for r in rows),
          'fully_graded_pairs': sum(p['both_grades_valid'] for p in pairs),
          'pairs': pairs, 'runs': rows,
          'known_primary_usage': total_usage(r.get('primary_usage') for r in rows),
          'known_optimizer_usage': total_usage(r.get('optimizer_usage') for r in rows),
          'confirmed_admitted_outputs': sum(r.get('admitted_outputs') or 0 for r in rows),
          'optimizer_usage_complete': all(r.get('pruning_measured', False) for r in rows),
          'usage_scope': 'This four-arm cohort only; prior pilot/setup/smoke excluded. Cached input is included in input; reasoning output is included in output. No invoice-dollar inference.',
          'prior_results_preserved': True, 'protocol_deviations': plan['protocol_deviations'],
          'statistical_limit': 'Two tasks cannot establish non-inferiority or a general performance effect.'}
args.output.write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps({k: output[k] for k in ['recorded_arms', 'graded_arms', 'fully_graded_pairs', 'pairs', 'confirmed_admitted_outputs']}))
