#!/usr/bin/env python3
"""Exercise installation without touching the user's Claude settings."""
import json, os, subprocess, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
class Installer(unittest.TestCase):
    def test_update_removes_stale_sources_and_preserves_settings_and_other_mods(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)
            old = config / 'mods/goal-meter/hooks'
            old.mkdir(parents=True); (old / 'register.js').write_text('stale')
            other = config / 'mods/other'; other.mkdir(); (other / 'keep').write_text('keep')
            settings = config / 'settings.json'
            settings.write_text(json.dumps({'env': {'OTHER': 'kept', 'CLAUDE_CODE_PLUGIN_DIRS': '/external/plugin'}, 'theme':'dark'}))
            env = dict(os.environ, CLAUDE_MODS_CONFIG_DIR=temp)
            subprocess.run(['bash',str(ROOT/'install.sh'),'goal-meter'],env=env,check=True,capture_output=True)
            self.assertFalse((old/'register.js').exists())
            self.assertTrue((old/'register.tsx').exists())
            self.assertEqual((other/'keep').read_text(),'keep')
            result = json.loads(settings.read_text())
            self.assertEqual(result['theme'],'dark'); self.assertEqual(result['env']['OTHER'],'kept')
            self.assertIn('/external/plugin',result['env']['CLAUDE_CODE_PLUGIN_DIRS'])
            self.assertEqual(len(list(config.glob('settings.json.bak.*'))),1)
            self.assertEqual(len(list(config.glob('mods-backups/*/goal-meter/hooks/register.js'))),1)
            subprocess.run(['bash',str(ROOT/'install.sh'),'goal-meter'],env=env,check=True,capture_output=True)
            paths=json.loads(settings.read_text())['env']['CLAUDE_CODE_PLUGIN_DIRS'].split(':')
            self.assertEqual(len(paths),len(set(paths)))
    def test_starter_bundle_expands_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            env=dict(os.environ,CLAUDE_MODS_CONFIG_DIR=temp)
            subprocess.run(['bash',str(ROOT/'install.sh'),'starter-kit'],env=env,check=True,capture_output=True)
            mods={p.name for p in (Path(temp)/'mods').iterdir()}
            self.assertEqual(mods,{'starter-kit','lumen','insight-pane','changes','goal-meter','live-progress'})
    def test_invalid_mod_and_malformed_settings_leave_install_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            config=Path(temp); settings=config/'settings.json'; settings.write_text('{broken')
            env=dict(os.environ,CLAUDE_MODS_CONFIG_DIR=temp)
            for name in ['goal-meter','../goal-meter']:
                run=subprocess.run(['bash',str(ROOT/'install.sh'),name],env=env,capture_output=True)
                self.assertNotEqual(run.returncode,0)
                self.assertEqual(settings.read_text(),'{broken')
                self.assertFalse((config/'mods').exists())
if __name__=='__main__': unittest.main()
