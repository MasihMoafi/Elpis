#!/usr/bin/env python3
"""Build the technical page from the README."""
from pathlib import Path
import re
import hashlib
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'website'

def main():
    # readme.md and docs/ link the site's own copies, so nothing is copied.
    source = re.sub(r'\bwebsite/(?=assets/|evidence/)', './', (ROOT / 'readme.md').read_text())
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
    print('Built technical.html from readme.md.')

if __name__ == '__main__':
    main()
