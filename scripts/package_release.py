#!/usr/bin/env python3
"""Build release archives from tracked source, preserving executable file modes."""
from pathlib import Path
import argparse, hashlib, subprocess, zipfile
ROOT=Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--version',default='0.1.0-beta.1');a=p.parse_args()
out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
tracked=[Path(x) for x in subprocess.check_output(['git','ls-files'],cwd=ROOT,text=True).splitlines()]
def archive(name,files,relative,prefix=''):
    target=out/name
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
        for rel in files:z.write(ROOT/rel,prefix+str((ROOT/rel).relative_to(relative)))
    with zipfile.ZipFile(target) as z:assert z.testzip() is None
    return target
assets=[archive(f'claude-foundry-{a.version}.zip',tracked,ROOT,'claude-foundry/')]
for mod in sorted((ROOT/'mods').iterdir()):
    if not (mod/'hooks/hooks.json').exists():continue
    files=[rel for rel in tracked if (ROOT/rel).is_relative_to(mod)]
    assets.append(archive(f'{mod.name}.zip',files,mod))
checksums=out/'SHA256SUMS.txt'
checksums.write_text(''.join(hashlib.sha256(x.read_bytes()).hexdigest()+'  '+x.name+'\n' for x in assets))
print(f'Built {len(assets)} ZIP archives and {checksums}')
