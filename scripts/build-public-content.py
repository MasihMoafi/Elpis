#!/usr/bin/env python3
"""Build the technical page and its local evidence links from the README."""
from pathlib import Path
import re
import hashlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'website'

def main():
    assets = SITE / 'assets/technical'
    assets.mkdir(parents=True, exist_ok=True)
    evidence = SITE / 'evidence'
    evidence.mkdir(exist_ok=True)
    local_docs = [
        'docs/evals/public-content-audit-20260909.md',
        'docs/evals/elpis-motion-readability-20260909.md',
        'docs/evals/rq3/COST_EFFICIENCY_RESULTS.md',
        'docs/evals/rq3/COST_EFFICIENCY_PROTOCOL.md',
        'docs/evals/rq3/COST_EFFICIENCY_METRICS.json',
        'docs/evals/rq3/LUNA_PUBLISHED_RATES_2026-09-08.json',
        'docs/evals/rq3/OPENAI_PUBLISHED_RATES_2026-09-09.json',
    ]
    for name in local_docs:
        shutil.copyfile(ROOT / name, evidence / Path(name).name)
    source = (ROOT / 'readme.md').read_text()
    for name in set(re.findall(r'docs/assets/[^\s)"<>]+', source)):
        shutil.copyfile(ROOT / name, assets / Path(name).name)
        source = source.replace(name, './assets/technical/' + Path(name).name)
    for name in local_docs:
        source = source.replace(name, './evidence/' + Path(name).name)
    # Remaining repository documentation links stay repository links, not site 404s.
    source = re.sub(r'(?<=\()((?:docs|paper)/[^)]+)(?=\))',
                    lambda m: 'https://github.com/MasihMoafi/Elpis/blob/main/' + m[1], source)
    source = source.replace('](LICENSE)', '](https://github.com/MasihMoafi/Elpis/blob/main/LICENSE)')
    result = subprocess.run(['pandoc', '--from=gfm', '--to=html5', '--standalone', '--toc',
        '--template=' + str(SITE / 'technical-template.html')], input=source,
        text=True, capture_output=True, check=True)
    html = re.sub(r'(<table\b.*?</table>)', r'<div class="technical-table">\1</div>', result.stdout, flags=re.S)
    html = re.sub(r'(<pre\b.*?</pre>)', r'<div class="technical-code">\1</div>', html, flags=re.S)
    digest = hashlib.sha256((ROOT / 'readme.md').read_bytes() + (SITE / 'technical-template.html').read_bytes()).hexdigest()
    (SITE / 'technical.html').write_text(f'<!-- README/template SHA256: {digest} -->\n' + html)
    print('Built technical.html from readme.md; copied referenced media and frozen evidence.')

if __name__ == '__main__':
    main()
