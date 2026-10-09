#!/usr/bin/env bash
# Copies selected mods without retaining obsolete source files. Does not download dependencies.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
config="${CLAUDE_MODS_CONFIG_DIR:-$HOME/.claude}"
python3 - "$here" "$config" "$@" <<'PY'
import json, os, re, shutil, sys, tempfile
from pathlib import Path
from datetime import datetime
root, config = Path(sys.argv[1]), Path(sys.argv[2])
names = sys.argv[3:] or sorted(p.name for p in (root / 'mods').iterdir() if p.is_dir())
for name in names:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) or not (root / 'mods' / name / '.claude-plugin/plugin.json').is_file():
        raise SystemExit(f'No such mod: {name}')
selected = []
visiting = set()
def expand(name):
    if name in selected: return
    if name in visiting: raise SystemExit(f'Cyclic dependency: {name}')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name): raise SystemExit(f'Invalid dependency: {name}')
    manifest = root / 'mods' / name / '.claude-plugin/plugin.json'
    if not manifest.is_file(): raise SystemExit(f'Missing dependency: {name}')
    visiting.add(name)
    for dep in json.loads(manifest.read_text()).get('dependencies', []):
        if not isinstance(dep, str) or '@' in dep: raise SystemExit('Legacy installer supports only local unversioned dependencies')
        expand(dep)
    visiting.remove(name); selected.append(name)
for name in names: expand(name)
names = selected
settings = config / 'settings.json'
s = json.loads(settings.read_text()) if settings.exists() else {}
if not isinstance(s, dict) or not isinstance(s.get('env', {}), dict):
    raise SystemExit('settings.json must contain an object with an env object')
env = s.setdefault('env', {})
existing = env.get('CLAUDE_CODE_PLUGIN_DIRS', '')
if not isinstance(existing, str):
    raise SystemExit('CLAUDE_CODE_PLUGIN_DIRS must be a string')
dirs = [d for d in existing.split(':') if d]
dest = config / 'mods'
dest.mkdir(parents=True, exist_ok=True)
stamp = datetime.now().strftime('%Y%m%d%H%M%S%f')
backup = config / 'mods-backups' / stamp
# Stage every selected source before changing the installed copies.
with tempfile.TemporaryDirectory(prefix='.mods-stage-', dir=config) as temp:
    stage = Path(temp)
    for name in names:
        shutil.copytree(root / 'mods' / name, stage / name,
                        ignore=shutil.ignore_patterns('__pycache__', '.DS_Store', '*.pyc'))
    if settings.exists():
        shutil.copy2(settings, str(settings) + '.bak.' + stamp)
    installed = []
    try:
        for name in names:
            target = dest / name
            if target.exists():
                backup.mkdir(parents=True, exist_ok=True)
                target.rename(backup / name)
            installed.append(name)
            (stage / name).rename(target)
            entry = str(target)
            if entry not in dirs: dirs.append(entry)
        env['CLAUDE_CODE_PLUGIN_DIRS'] = ':'.join(dirs)
        pending = stage / 'settings.json'
        pending.write_text(json.dumps(s, indent=2) + '\n')
        if settings.exists(): os.chmod(pending, settings.stat().st_mode & 0o777)
        else: os.chmod(pending, 0o600)
        os.replace(pending, settings)
    except BaseException:
        for name in reversed(installed):
            target = dest / name
            if target.exists(): shutil.rmtree(target)
            if (backup / name).exists(): (backup / name).rename(target)
        raise
for name in names: print(f'Installed {name} -> {dest / name}')
print('Settings and replaced mod folders backed up. Start a new Claude Code session to load them.')
PY
