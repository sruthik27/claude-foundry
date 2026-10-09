#!/usr/bin/env python3
"""Install the marketplace in a disposable Claude config, without model calls."""
from pathlib import Path
import argparse, json, os, subprocess, tempfile
ROOT = Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--source',default='.',help='Marketplace path or GitHub owner/repo');a=p.parse_args()
source=str(Path(a.source).resolve()) if Path(a.source).exists() else a.source
with tempfile.TemporaryDirectory(prefix='claude-mods-smoke-') as temp:
    env=dict(os.environ,CLAUDE_CONFIG_DIR=temp)
    for kit in ['starter-kit','all-mods']:
        subprocess.run(['claude','plugin','install',kit,'--marketplace',source],cwd=temp,env=env,check=True)
    result=subprocess.run(['claude','plugin','list','--json'],cwd=temp,env=env,check=True,capture_output=True,text=True)
    parsed=json.loads(result.stdout)
    print(json.dumps(parsed,indent=2))
    # Read back the enabled plugin ids from the isolated user settings.
    settings=json.loads((Path(temp)/'settings.json').read_text())
    expected={x['name']+'@claude-code-mods' for x in json.loads((ROOT/'.claude-plugin/marketplace.json').read_text())['plugins']}
    enabled={k for k,v in settings.get('enabledPlugins',{}).items() if v}
    if not expected <= enabled: raise SystemExit(f'Missing enabled plugins: {sorted(expected-enabled)}')
    print(f'Install smoke test passed: {len(expected)} enabled entries, isolated config removed on exit.')
