#!/usr/bin/env python3
"""Run release checks without model credentials."""
from pathlib import Path
import subprocess, sys
ROOT = Path(__file__).resolve().parent.parent

def run(argv, cwd=ROOT):
    print('\n$ ' + ' '.join(str(x) for x in argv), flush=True)
    subprocess.run([str(x) for x in argv], cwd=cwd, check=True)

try:
    run(['claude','--version'])
    run(['claude','plugin','validate','--strict',ROOT/'.claude-plugin/marketplace.json'])
    for mod in sorted((ROOT/'mods').iterdir()):
        if not mod.is_dir(): continue
        run(['claude','plugin','validate','--strict',mod/'.claude-plugin/plugin.json'])
        if (mod/'hooks/hooks.json').exists():
            if mod.name == 'aside': run(['node','--test','tests/register.test.ts'],mod)
            else: run(['claude','plugin','test',mod])
    run(['python3','-m','unittest','discover','-s','tests','-p','*_test.py'])
    run(['bash','-n','install.sh'])
except (subprocess.CalledProcessError, FileNotFoundError) as e:
    print(f'Check failed: {e}',file=sys.stderr);raise SystemExit(1)
print('\nAll checks passed.')
